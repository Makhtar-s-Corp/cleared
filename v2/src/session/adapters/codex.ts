// The Codex adapter, host side (milestone 3, matrix B5.1c, D13 and O6). Same
// contract as Claude Code's and Cursor's (contract.ts), same event log and
// cleaner, same policy (policy.ts, unchanged in its rules: the adapter turns
// Codex's items into the requests it evaluates, codex/map.ts). How Codex is
// driven (docs/adapters.md, Codex, the v2 adapter):
//   - one `codex exec --json` process per message in the session's container
//     (a `docker exec`), the prompt on its standard input; the next message
//     is `codex exec resume <thread>` on the thread Codex named in its first
//     line. The thread id is kept in the state folder (nothing reads it back
//     yet: a restarted service does not resume a session, as with the other
//     harnesses). The app server, which can hold a call for a person, is not
//     used: its decision gate (docs/adapters.md) is still open;
//   - no channel on which a call waits for a person, so the guard is two
//     layers and it fails closed, as Cursor's:
//       1. Codex's own sandbox, chosen by the role (codex/interactive.ts,
//          sandboxOf): read only for a reviewer, a reader, the lead and an
//          author whose plan waits; the checkout writable for an author at
//          work; approvals `never`, never a bypass flag;
//       2. every item Codex reports is evaluated by the full policy. Only an
//          allow lets the turn go on; a deny, and an ask (nobody can be asked
//          mid-turn), stop the turn's process and say so in the thread
//          (cleared.permission_answered, then an error with the code
//          policy_stop). A command is seen when it starts, a file change only
//          once it is made: this layer is a tripwire, layer 1 is what refuses;
//   - usage: each turn's tokens from turn.completed (codex/map.ts says how
//     they are counted), no cost (total_cost_usd null, nothing estimated);
//     the rate limit windows from the thread's rollout file after each turn,
//     when the launcher can read it;
//   - Take over: interactive() ends the running turn, refuses further
//     messages until resume(), and gives `codex resume <thread>` for the web
//     terminal, in the role's sandbox; resume() simply allows the next turn,
//     which resumes the thread the human left. There is no runner to release
//     or reload.
// The login (a Codex API key file) is read inside the container only.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Docker, type Limits } from '../../container/docker.ts';
import type { ServiceSpec } from '../../container/services.ts';
import { WORKDIR_MOUNT, limitsOf, sessionNames, startSession, stopSession } from '../../container/session-runtime.ts';
import type { Cleaner } from '../clean.ts';
import { type InteractiveResume, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserMessage } from '../contract.ts';
import { handoverOf } from '../handover.ts';
import type { AgUiEvent, EventLog, SessionEvent } from '../events.ts';
import { evaluate, type Policy } from '../policy.ts';
import { END_TURN, EXIT_NO_LOGIN, EXIT_NO_PROGRAM, INTERACTIVE_NAME, RATE_LIMITS, interactiveCommand, isThreadId, sandboxOf, turnCommand } from './codex/interactive.ts';
import { codexCalls, createCodexMapper, type CodexMapper } from './codex/map.ts';

// The hosts Codex reaches, added to the egress allow list. Taken from
// OpenAI's public documentation, not yet observed from a run in a container:
// the owner's trial confirms or corrects them.
export const CODEX_HOSTS: readonly string[] = ['api.openai.com', 'chatgpt.com', 'auth.openai.com'];

// How a turn's process is started and ended; the Docker one is the real one,
// tests give their own.
export interface CodexLauncher {
  start(session: SessionId, input: StartInput): Promise<void>;
  turn(session: SessionId, command: readonly string[]): Promise<ChildProcessWithoutNullStreams>;
  // Ends the running turn's program itself.
  endTurn(session: SessionId): Promise<void>;
  // The thread's last token_count line, or undefined when there is none.
  rateLimits(session: SessionId, thread: string): Promise<string | undefined>;
  stop(session: SessionId): Promise<void>;
}

export type CodexRuntime = {
  readonly stateDir: string;                      // the allow lists and the thread ids live under it
  readonly loginFile: string;                     // host path of the Codex API key file, mounted read only
  readonly hostAddresses: readonly string[];
  readonly user: string;
  readonly services?: readonly ServiceSpec[];
  readonly image?: string;                        // a session image that has Codex's program in it
  readonly limits?: Limits;
  readonly stopTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
};

// CLEARED_CODEX_API_KEY_FILE names the key file; else <state>/codex.key.
export function codexRuntime(env: NodeJS.ProcessEnv = process.env): CodexRuntime {
  const stateDir = env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');
  const hostAddresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith('fe80:')).map((entry) => entry.address);
  return { stateDir, loginFile: env.CLEARED_CODEX_API_KEY_FILE || join(stateDir, 'codex.key'), hostAddresses, user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}` };
}

export function dockerLauncher(docker: Docker, runtime: CodexRuntime): CodexLauncher {
  return {
    async start(session, input) {
      await startSession(docker, {
        session, workdir: input.workdir, tokenFile: runtime.loginFile, allowDir: join(runtime.stateDir, 'egress', session),
        allowHosts: [...input.policy.allowedHosts, ...CODEX_HOSTS], hostAddresses: runtime.hostAddresses, services: input.services ?? runtime.services ?? [],
        ...(input.siblings === undefined ? {} : { siblings: input.siblings }), ...(input.skills === undefined ? {} : { skills: input.skills }),
        user: runtime.user, command: ['sleep', 'infinity'],
        // Its service's test secrets, for an author or a reviewer (C16).
        ...(input.service === undefined ? {} : { service: input.service }), role: input.role,
        ...(runtime.image === undefined ? {} : { image: runtime.image }),
        ...(limitsOf(runtime.limits, input.limits) ?? {}),
      });
    },
    turn: (session, command) => docker.execStream(session, sessionNames(session).container, { user: runtime.user, workdir: WORKDIR_MOUNT, command }),
    async endTurn(session) {
      await docker.exec(session, sessionNames(session).container, END_TURN, { timeoutMs: 10_000 });
    },
    async rateLimits(session, thread) {
      if (!isThreadId(thread)) return undefined;
      const { stdout } = await docker.exec(session, sessionNames(session).container, [...RATE_LIMITS, thread], { timeoutMs: 10_000 });
      return stdout.trim() || undefined;
    },
    stop: async (session) => { await stopSession(docker, session); },
  };
}

export type CodexOptions = {
  readonly log: EventLog;
  readonly cleaner: () => Cleaner;
  readonly launcher?: CodexLauncher;
  readonly docker?: Docker;
  readonly runtime?: CodexRuntime;
  readonly policy?: (input: StartInput) => Policy;
  readonly newId?: () => string;
  readonly now?: () => Date;
};

// A turn's own process and the reason it is being ended: per turn, since the
// close of an ended turn can arrive after the next one has begun.
type Turn = { readonly child: ChildProcessWithoutNullStreams; ending: 'interrupt' | 'blocked' | undefined; completed: boolean };

type Session = {
  readonly id: SessionId;
  readonly input: StartInput;
  readonly cleaner: Cleaner;
  readonly mapper: CodexMapper;
  readonly wake: Set<() => void>;
  readonly queue: string[];
  readonly checked: Set<string>;                  // the items the guard has seen in the running turn's process
  thread: string | undefined;                     // Codex's thread id
  turn: Turn | undefined;                         // the running turn
  closed: boolean;
  closing: boolean;                               // stop() is ending the running turn
  handedOver: boolean;                            // a human has the thread (Take over)
  turnDone: Promise<void>;
  handle: SessionHandle | undefined;
};

const SIGNED_OUT = /not\s+(?:logged|signed)\s+in|log\s*in\s+required|unauthori[sz]ed|401|invalid\s+api\s*key|authentication/i;

export function createCodexAdapter(options: CodexOptions): SessionAdapter {
  const { log } = options;
  const runtime = options.runtime ?? codexRuntime();
  const launcher = options.launcher ?? dockerLauncher(options.docker ?? new Docker(), runtime);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const policyOf = options.policy ?? ((input: StartInput) => input.policy);
  const sessions = new Map<SessionId, Session>();
  const threadFile = (id: SessionId) => join(runtime.stateDir, 'codex-threads', `${id}.thread`);

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

  function close(session: Session): void {
    session.closed = true;
    for (const wake of session.wake) wake();
  }

  function rememberThread(session: Session, thread: string): void {
    if (session.thread !== undefined || !isThreadId(thread)) return;
    session.thread = thread;
    try {
      mkdirSync(join(runtime.stateDir, 'codex-threads'), { recursive: true, mode: 0o700 });
      writeFileSync(threadFile(session.id), thread, { mode: 0o600 });
    } catch {
      // The thread stays in memory; a restarted service then starts a new one.
    }
  }

  // The full policy on an item Codex reports, once per item. Only an allow
  // lets the turn go on.
  function guard(session: Session, item: Record<string, unknown>): boolean {
    const calls = codexCalls(item);
    const first = calls[0];
    if (!first || session.checked.has(first.callId)) return true;
    session.checked.add(first.callId);
    const policy = policyOf(session.input);
    for (const call of calls) {
      const verdict = evaluate(call.request, policy, {
        readFile: (path) => {
          try { return readFileSync(join(session.input.workdir, path.slice(WORKDIR_MOUNT.length + 1)), 'utf8'); } catch { return undefined; }
        },
      });
      if (verdict.decision === 'allow') continue;
      const message = verdict.decision === 'deny'
        ? verdict.message
        : 'This call needs a person\'s approval, and a Codex turn has no way to wait for one: it was stopped. Ask for an allowed alternative.';
      const turn = session.turn;
      if (turn) turn.ending = 'blocked';
      emit(session, session.mapper.blocked(call.callId, verdict, message));
      void launcher.endTurn(session.id).catch(() => undefined);
      turn?.child.kill();
      return false;
    }
    return true;
  }

  function failure(code: number | null, stderr: string): { message: string; code: string } {
    if (code === EXIT_NO_LOGIN) return { message: 'Codex has no login in the session\'s container.', code: 'codex_login' };
    if (code === EXIT_NO_PROGRAM) return { message: 'Codex is not installed in the session\'s image.', code: 'codex_not_installed' };
    if (SIGNED_OUT.test(stderr)) return { message: 'Codex refused the login: renew the key.', code: 'codex_login' };
    return { message: 'The Codex program ended without an answer.', code: 'codex_exit' };
  }

  // The windows of the thread's rollout, after a turn; a failed read says nothing.
  async function readRateLimits(session: Session): Promise<void> {
    if (session.thread === undefined) return;
    let text: string | undefined;
    try { text = await launcher.rateLimits(session.id, session.thread); } catch { return; }
    if (text === undefined) return;
    let line: unknown;
    try { line = JSON.parse(text); } catch { return; }
    if (typeof line !== 'object' || line === null || Array.isArray(line)) return;
    emit(session, session.mapper.rateLimits(line as Record<string, unknown>));
  }

  async function runTurn(session: Session, text: string): Promise<void> {
    // Codex numbers its items from item_0 again in each process (docs/adapters.md,
    // proofs 7 and 8): an id seen in an earlier turn is a new item here.
    session.checked.clear();
    emit(session, session.mapper.beginTurn());
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await launcher.turn(session.id, turnCommand(session.input.model, session.thread, sandboxOf(policyOf(session.input))));
    } catch {
      emit(session, session.mapper.turnFailed('The Codex program could not be started.', 'codex_launch'));
      return;
    }
    const turn: Turn = { child, ending: undefined, completed: false };
    session.turn = turn;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => undefined);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (raw) => {
      if (session.turn !== turn || turn.ending !== undefined) return;
      let line: unknown;
      try { line = JSON.parse(raw); } catch { return; }
      if (typeof line !== 'object' || line === null || Array.isArray(line)) return;
      const frame = line as Record<string, unknown>;
      if (frame.type === 'thread.started' && typeof frame.thread_id === 'string') rememberThread(session, frame.thread_id);
      const item = frame.item;
      if (typeof item === 'object' && item !== null && !Array.isArray(item) && !guard(session, item as Record<string, unknown>)) return;
      if (frame.type === 'turn.completed' || frame.type === 'turn.failed' || frame.type === 'error') turn.completed = true;
      emit(session, session.mapper.line(frame));
    });
    child.stdin.end(text);
    await new Promise<void>((done) => {
      child.on('close', (code: number | null) => {
        if (session.turn === turn) session.turn = undefined;
        if (turn.ending === 'interrupt') { if (!session.closing) emit(session, session.mapper.cancelled('waiting_human', 'Waiting for a message')); } else if (turn.ending === undefined && !turn.completed) {
          const { message, code: reason } = failure(code, stderr);
          emit(session, session.mapper.turnFailed(message, reason));
        }
        done();
      });
    });
    if (turn.completed) await readRateLimits(session);
  }

  // Ends the running turn: the program itself in the container, then the
  // docker client. The turn's close handler may clear session.turn while
  // the container answers, so the turn is kept before the wait.
  async function endRunningTurn(session: Session): Promise<void> {
    const turn = session.turn;
    if (!turn) return;
    turn.ending = 'interrupt';
    await launcher.endTurn(session.id).catch(() => undefined);
    turn.child.kill();
  }

  // One turn at a time, in the order the messages came.
  function pump(session: Session): void {
    session.turnDone = session.turnDone.then(async () => {
      for (let text = session.queue.shift(); text !== undefined && !session.closed && !session.handedOver; text = session.queue.shift()) await runTurn(session, text);
    });
  }

  function handle(session: Session): SessionHandle {
    const open = () => {
      if (session.closed) throw new Error(`session ${session.id} is stopped`);
    };
    return {
      id: session.id,
      async send(message: UserMessage) {
        open();
        if (session.handedOver) throw new Error(`session ${session.id} is taken over: give it back first`);
        emit(session, session.mapper.userMessage(newId(), message.text, message.by));
        session.queue.push(message.text);
        pump(session);
      },
      async *events(afterSeq = 0) {
        let seq = afterSeq;
        for (;;) {
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
      async answer(requestId) {
        open();
        // A Codex exec turn never waits on a request, so none can be answered.
        throw new Error(`no pending request ${requestId} in session ${session.id}`);
      },
      async interrupt() {
        open();
        session.queue.length = 0;
        await endRunningTurn(session);
      },
      async stop() {
        session.queue.length = 0;
        session.closing = true;
        if (session.turn) {
          await endRunningTurn(session);
          await Promise.race([session.turnDone, new Promise<void>((resolve) => setTimeout(resolve, runtime.stopTimeoutMs ?? 15_000).unref())]);
        }
        await launcher.stop(session.id);
        if (!session.closed) {
          emit(session, session.mapper.cancelled('stopped', 'Stopped'));
          close(session);
        }
      },
      async handover(to) {
        open();
        return handoverOf(log, session.id, 'codex', to);
      },
    };
  }

  return {
    harness: 'codex',
    async start(input) {
      if (input.harness !== 'codex') throw new Error(`this adapter runs codex sessions, not ${input.harness}`);
      const id = newId();
      const session: Session = {
        id, input, cleaner: options.cleaner(), mapper: createCodexMapper({ sessionId: id }), wake: new Set(), queue: [], checked: new Set(),
        thread: undefined, turn: undefined, closed: true, closing: false, handedOver: false, turnDone: Promise.resolve(), handle: undefined,
      };
      sessions.set(id, session);
      await launcher.start(id, input);
      session.closed = false;
      emit(session, session.mapper.start(input.model));
      session.handle = handle(session);
      // The ticket's prompt is the first turn; it is Cleared's, not a user's.
      await session.handle.send({ text: input.prompt, by: 'cleared' });
      return session.handle;
    },
    async resume(id) {
      const session = sessions.get(id);
      if (!session) throw new Error(`unknown session ${id}`);
      if (session.closed) {
        await launcher.start(id, session.input);
        session.closed = false;
        session.closing = false;
        session.handle = handle(session);
      }
      // Given back after a human had the thread: the next turn resumes it as the human left it.
      session.handedOver = false;
      return session.handle ?? (session.handle = handle(session));
    },
    async interactive(id): Promise<InteractiveResume> {
      const session = sessions.get(id);
      if (!session || session.closed) return { supported: false, reason: `There is no running session ${id} here to resume in a terminal.` };
      if (session.thread === undefined) return { supported: false, reason: 'Codex has not started a thread for this session yet: there is nothing to resume. Open the Shell instead.' };
      if (session.turn) {
        // One writer at a time: the running turn ends, then the human has the thread.
        session.queue.length = 0;
        session.handedOver = true;                  // before the wait: no message starts a turn beside the human
        await endRunningTurn(session);
        await Promise.race([session.turnDone, new Promise<void>((resolve) => setTimeout(resolve, runtime.interruptTimeoutMs ?? 15_000).unref())]);
        if (session.turn) {
          session.handedOver = false;
          return { supported: false, reason: 'The session\'s running turn did not end in time: try again, or open the Shell instead.' };
        }
      }
      session.handedOver = true;
      return { supported: true, name: INTERACTIVE_NAME, command: interactiveCommand(session.input.model, session.thread, sandboxOf(policyOf(session.input))) };
    },
  };
}
