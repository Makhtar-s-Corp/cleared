// The Claude Code adapter, host side (milestone 1 plan, section 6). Each
// session is a labelled session container (src/container/session-runtime.ts)
// whose command is the runner (images/session/runner/main.ts); the adapter
// keeps the container's stdin and stdout through `docker start --attach
// --interactive` and speaks the runner's JSON lines:
//   - every runner line goes through the mapper (claude-code/map.ts), then
//     the session's cleaner, then the event log, as the fake adapter does;
//   - a permission request is evaluated by the policy (section 5): an allow
//     or a deny is answered at once, an ask waits for answer() from the inbox;
//     a question (AskUserQuestion) always waits;
//   - interrupt() cancels what waits and asks the runner to interrupt the turn;
//   - stop() asks the runner to stop, then removes the containers and the
//     networks; the config volume stays, so resume() can start a new
//     container on the same Claude Code session.
// The token never appears on a docker command line: the runner reads it from
// the read-only mount.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { RunnerInput, RunnerOutput } from '../../../images/session/runner/main.ts';
import { Docker, type Limits } from '../../container/docker.ts';
import type { ServiceSpec } from '../../container/services.ts';
import { WORKDIR_MOUNT, sessionNames, startSession, stopSession } from '../../container/session-runtime.ts';
import type { Cleaner } from '../clean.ts';
import { NotImplemented, type Answer, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserMessage } from '../contract.ts';
import type { AgUiEvent, EventLog, SessionEvent } from '../events.ts';
import { evaluate, type Policy, type PolicyContext } from '../policy.ts';
import { createMapper, toolRequest, type Mapper } from './claude-code/map.ts';

export const RUNNER_COMMAND: readonly string[] = ['node', '/opt/cleared/runner/main.ts'];

// What every session of this service shares.
export type ClaudeCodeRuntime = {
  readonly stateDir: string;                      // the allow lists live under <stateDir>/egress/<session>
  readonly tokenFile: string;                     // host path, service owned, mode 0600
  readonly hostAddresses: readonly string[];      // refused by the egress proxy
  readonly user: string;                          // uid:gid the session runs as
  readonly services?: readonly ServiceSpec[];
  readonly image?: string;
  readonly limits?: Limits;
  readonly maxBudgetUsd?: number;                 // per session, passed to the SDK
  readonly stopTimeoutMs?: number;                // how long stop() waits for the runner to exit
};

// The default runtime: the service's state folder (CLEARED_V2_STATE_DIR, or
// <XDG_STATE_HOME or ~/.local/state>/cleared-v2), the token file in it, the
// host's own addresses and the service's uid.
export function claudeCodeRuntime(env: NodeJS.ProcessEnv = process.env): ClaudeCodeRuntime {
  const stateDir = env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');
  const hostAddresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith('fe80:')).map((entry) => entry.address);
  return { stateDir, tokenFile: join(stateDir, 'claude.token'), hostAddresses, user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}` };
}

export type ClaudeCodeOptions = {
  readonly log: EventLog;
  readonly cleaner: () => Cleaner;
  readonly docker?: Docker;
  readonly runtime?: ClaudeCodeRuntime;
  // The policy for each evaluation; by default the one the session started
  // with. The flow refreshes ticketFiles here.
  readonly policy?: (input: StartInput) => Policy;
  readonly newId?: () => string;
  readonly now?: () => Date;
};

type Pending = { readonly kind: 'permission' | 'question' };

type Session = {
  readonly id: SessionId;
  readonly input: StartInput;
  readonly cleaner: Cleaner;
  readonly mapper: Mapper;
  readonly wake: Set<() => void>;
  readonly pending: Map<string, Pending>;
  child: ChildProcessWithoutNullStreams | undefined;
  closed: boolean;
  exitSeen: boolean;                              // the runner printed its exit line
  exited: Promise<void>;
  handle: SessionHandle | undefined;
};

// Reads a file of the ticket checkout by the path the harness names it
// (under /workspace), never outside the checkout.
function workdirReader(workdir: string): PolicyContext['readFile'] {
  return (path) => {
    const rel = relative(WORKDIR_MOUNT, path);
    if (rel.startsWith('..') || rel === '' || resolve(WORKDIR_MOUNT, rel) !== resolve(path)) return undefined;
    const host = resolve(workdir, rel);
    if (!host.startsWith(resolve(workdir) + sep)) return undefined;
    try {
      return readFileSync(host, 'utf8');
    } catch {
      return undefined;
    }
  };
}

export function createClaudeCodeAdapter(options: ClaudeCodeOptions): SessionAdapter {
  const { log } = options;
  const docker = options.docker ?? new Docker();
  const runtime = options.runtime ?? claudeCodeRuntime();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const policyOf = options.policy ?? ((input: StartInput) => input.policy);
  const sessions = new Map<SessionId, Session>();

  function emit(session: Session, events: readonly AgUiEvent[]): void {
    let stored = false;
    for (const event of events) {
      for (const clean of session.cleaner.clean(event)) {
        log.append({ at: now().toISOString(), sessionId: session.id, ticket: session.input.ticket, project: session.input.project, event: clean });
        stored = true;
      }
    }
    if (stored) for (const wake of session.wake) wake();
  }

  function write(session: Session, line: RunnerInput): void {
    session.child?.stdin.write(JSON.stringify(line) + '\n');
  }

  function close(session: Session): void {
    session.closed = true;
    for (const wake of session.wake) wake();
  }

  function onLine(session: Session, text: string): void {
    let line: RunnerOutput;
    try {
      line = JSON.parse(text) as RunnerOutput;
    } catch {
      return;                                     // stdout carries only JSON lines; anything else is not the runner's
    }
    if (typeof line !== 'object' || line === null) return;
    if (line.type === 'permission_request') {
      const verdict = evaluate(toolRequest(line), policyOf(session.input), { readFile: workdirReader(session.input.workdir) });
      emit(session, session.mapper.permissionRequest(line, verdict));
      if (verdict.decision === 'ask') {
        session.pending.set(line.requestId, { kind: 'permission' });
        return;
      }
      const answer: Answer = verdict.decision === 'allow'
        ? { decision: { kind: 'allow_once' }, by: 'policy', rule: verdict.rule }
        : { decision: { kind: 'reject_once', message: verdict.message }, by: 'policy', rule: verdict.rule };
      write(session, { type: 'answer', requestId: line.requestId, decision: answer.decision });
      emit(session, session.mapper.answered(line.requestId, answer));
      return;
    }
    if (line.type === 'question') {
      session.pending.set(line.requestId, { kind: 'question' });
      emit(session, session.mapper.question(line));
      return;
    }
    // A request the adapter already settled (interrupt) is not reported twice.
    if (line.type === 'request_cancelled' && !session.pending.delete(line.requestId)) return;
    if (line.type === 'exit') session.exitSeen = true;
    emit(session, session.mapper.line(line));
  }

  // Starts the session container with the runner attached and sends `start`.
  async function launch(session: Session, resume: boolean): Promise<void> {
    const { id, input } = session;
    await startSession(docker, {
      session: id, workdir: input.workdir, tokenFile: runtime.tokenFile, allowDir: join(runtime.stateDir, 'egress', id),
      allowHosts: input.policy.allowedHosts, hostAddresses: runtime.hostAddresses, services: runtime.services ?? [],
      user: runtime.user, command: RUNNER_COMMAND, interactive: true,
      ...(runtime.image === undefined ? {} : { image: runtime.image }),
      ...(runtime.limits === undefined ? {} : { limits: runtime.limits }),
    });
    const child = await docker.attach(id, sessionNames(id).container);
    session.child = child;
    session.closed = false;
    session.exitSeen = false;
    session.exited = new Promise<void>((done) => {
      child.on('close', (code: number | null) => {
        if (session.child === child) {
          // A runner that ends without its exit line died.
          if (!session.exitSeen) emit(session, session.mapper.line({ type: 'exit', code: code ?? 1 }));
          session.child = undefined;
          session.pending.clear();
          close(session);
        }
        done();
      });
    });
    child.stdin.on('error', () => undefined);       // a runner that died; its close says so
    child.stderr.resume();                          // the runner's and the CLI's diagnostics are not events
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (text) => onLine(session, text));
    write(session, {
      type: 'start', sessionId: id, model: input.model, resume,
      ...(runtime.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: runtime.maxBudgetUsd }),
    });
    emit(session, session.mapper.start(input.model));
  }

  function send(session: Session, message: UserMessage): void {
    const uuid = newId();
    emit(session, session.mapper.userMessage(uuid, message.text, message.by));
    write(session, { type: 'user', uuid, text: message.text });
  }

  function handle(session: Session): SessionHandle {
    const open = () => {
      if (session.closed || !session.child) throw new Error(`session ${session.id} is stopped`);
    };
    const value: SessionHandle = {
      id: session.id,
      async send(message) {
        open();
        send(session, message);
      },
      async *events(afterSeq = 0) {
        let seq = afterSeq;
        for (;;) {
          // Listening before reading the log, so an event stored in between is not missed.
          let wake = () => {};
          const waited = new Promise<void>((resolve) => { wake = resolve; });
          session.wake.add(wake);
          try {
            const fresh: SessionEvent[] = log.after(session.id, seq);
            for (const event of fresh) {
              seq = event.seq;
              yield event;
            }
            if (fresh.length > 0) continue;
            if (session.closed) return;
            await waited;
          } finally {
            session.wake.delete(wake);
          }
        }
      },
      async answer(requestId, answer) {
        open();
        if (!session.pending.delete(requestId)) throw new Error(`no pending request ${requestId} in session ${session.id}`);
        write(session, { type: 'answer', requestId, decision: answer.decision });
        emit(session, session.mapper.answered(requestId, answer));
      },
      async interrupt() {
        open();
        session.mapper.interrupting();
        for (const requestId of [...session.pending.keys()]) {
          session.pending.delete(requestId);
          write(session, { type: 'answer', requestId, decision: { kind: 'cancelled' } });
          emit(session, session.mapper.answered(requestId, { decision: { kind: 'cancelled' }, by: 'policy', rule: 'interrupt' }));
        }
        write(session, { type: 'interrupt' });
      },
      async stop() {
        const child = session.child;
        if (child) {
          write(session, { type: 'stop' });
          child.stdin.end();
          const timeout = new Promise<void>((resolve) => setTimeout(resolve, runtime.stopTimeoutMs ?? 15_000).unref());
          await Promise.race([session.exited, timeout]);
        }
        // Removing the container ends the attached docker process if the runner did not exit.
        await stopSession(docker, session.id);
        if (session.child === child && child) await Promise.race([session.exited, new Promise<void>((resolve) => setTimeout(resolve, Math.min(runtime.stopTimeoutMs ?? 1000, 1000)).unref())]);
        if (!session.closed) {
          if (!session.exitSeen) emit(session, session.mapper.line({ type: 'exit', code: 0 }));
          session.child = undefined;
          session.pending.clear();
          close(session);
        }
      },
      async handover() {
        throw new NotImplemented('handing a session over to another harness comes in milestone 3');
      },
    };
    return value;
  }

  return {
    harness: 'claude-code',
    async start(input) {
      if (input.harness !== 'claude-code') throw new Error(`this adapter runs claude-code sessions, not ${input.harness}`);
      const id = newId();
      const session: Session = {
        id, input, cleaner: options.cleaner(), mapper: createMapper({ sessionId: id }), wake: new Set(), pending: new Map(),
        child: undefined, closed: true, exitSeen: false, exited: Promise.resolve(), handle: undefined,
      };
      sessions.set(id, session);
      await launch(session, false);
      session.handle = handle(session);
      // The ticket's prompt is the first turn; it is Cleared's, not a user's.
      send(session, { text: input.prompt, by: 'cleared' });
      return session.handle;
    },
    async resume(id) {
      const session = sessions.get(id);
      if (!session) throw new Error(`unknown session ${id}`);
      if (!session.closed && session.handle) return session.handle;
      await launch(session, true);
      session.handle = handle(session);
      return session.handle;
    },
  };
}
