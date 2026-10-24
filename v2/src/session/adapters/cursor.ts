// The Cursor adapter, host side (milestone 3, matrix B5.1c and O6). Same
// contract as Claude Code's (contract.ts), same event log and cleaner, same
// policy (policy.ts, unchanged: the adapter turns Cursor's tool calls into the
// requests it evaluates, cursor/map.ts). What differs is how Cursor is driven:
//   - no long-lived process: each message is one `agent -p --output-format
//     stream-json` process in the session's container (a `docker exec`),
//     resumed on the chat Cursor named in its first line; the chat id is kept
//     in the state folder (nothing reads it back yet: a restarted service
//     does not resume a session, as Claude Code's does not);
//   - no channel on which a call waits for a human in print mode. The guard is
//     therefore two layers and it fails closed:
//       1. the policy compiled into Cursor's own permissions file, deny first,
//          never `--force` (cursor/permissions.ts);
//       2. every call Cursor reports is evaluated by the full policy. Only an
//          allow lets the turn go on. A deny, and an ask (nobody can be asked
//          mid-turn), stop the turn's process and say so in the thread
//          (cleared.permission_answered, then an error with the code
//          policy_stop). This second layer sees a call when it starts, so it is
//          a tripwire, not a prevention: layer 1 is what refuses;
//   - usage: Cursor's stream reports no tokens and no cost. The run reports
//     the model, total_cost_usd null, and nothing is estimated;
//   - Take over: interactive() ends the running turn, refuses further messages
//     until resume(), and gives `agent --resume <chat>` for the web terminal;
//     resume() simply allows the next turn, which resumes the chat the human
//     left. There is no runner to release or reload.
// The login (a Cursor API key file) is read inside the container only.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Docker, type Limits } from '../../container/docker.ts';
import type { ServiceSpec } from '../../container/services.ts';
import { WORKDIR_MOUNT, sessionNames, startSession, stopSession } from '../../container/session-runtime.ts';
import type { Cleaner } from '../clean.ts';
import { NotImplemented, type InteractiveResume, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserMessage } from '../contract.ts';
import type { AgUiEvent, EventLog, SessionEvent } from '../events.ts';
import { evaluate, type Policy } from '../policy.ts';
import { END_TURN, EXIT_NO_LOGIN, EXIT_NO_PERMISSIONS, EXIT_NO_PROGRAM, INTERACTIVE_NAME, interactiveCommand, isChatId, turnCommand } from './cursor/interactive.ts';
import { cursorCall, createCursorMapper, type CursorMapper } from './cursor/map.ts';
import { cursorPermissions } from './cursor/permissions.ts';

// The hosts Cursor's agent reaches, added to the egress allow list. Taken from
// Cursor's public documentation, not yet observed from a run: the owner's
// trial confirms or corrects them.
export const CURSOR_HOSTS: readonly string[] = ['api2.cursor.sh', 'api3.cursor.sh', 'repo42.cursor.sh', 'cursor.com'];

// How a turn's process is started and ended; the Docker one is the real one,
// tests give their own.
export interface CursorLauncher {
  start(session: SessionId, input: StartInput): Promise<void>;
  turn(session: SessionId, command: readonly string[]): Promise<ChildProcessWithoutNullStreams>;
  // Ends the running turn's program itself.
  endTurn(session: SessionId): Promise<void>;
  stop(session: SessionId): Promise<void>;
}

export type CursorRuntime = {
  readonly stateDir: string;                      // the allow lists and the chat ids live under it
  readonly loginFile: string;                     // host path of the Cursor API key file, mounted read only
  readonly hostAddresses: readonly string[];
  readonly user: string;
  readonly services?: readonly ServiceSpec[];
  readonly image?: string;                        // a session image that has Cursor's program in it
  readonly limits?: Limits;
  readonly stopTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
};

// CLEARED_CURSOR_API_KEY_FILE names the key file; else <state>/cursor.key.
export function cursorRuntime(env: NodeJS.ProcessEnv = process.env): CursorRuntime {
  const stateDir = env.CLEARED_V2_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared-v2');
  const hostAddresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !entry.address.startsWith('fe80:')).map((entry) => entry.address);
  return { stateDir, loginFile: env.CLEARED_CURSOR_API_KEY_FILE || join(stateDir, 'cursor.key'), hostAddresses, user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}` };
}

export function dockerLauncher(docker: Docker, runtime: CursorRuntime): CursorLauncher {
  return {
    async start(session, input) {
      await startSession(docker, {
        session, workdir: input.workdir, tokenFile: runtime.loginFile, allowDir: join(runtime.stateDir, 'egress', session),
        allowHosts: [...input.policy.allowedHosts, ...CURSOR_HOSTS], hostAddresses: runtime.hostAddresses, services: input.services ?? runtime.services ?? [],
        ...(input.siblings === undefined ? {} : { siblings: input.siblings }), ...(input.skills === undefined ? {} : { skills: input.skills }),
        user: runtime.user, command: ['sleep', 'infinity'],
        ...(runtime.image === undefined ? {} : { image: runtime.image }),
        ...(runtime.limits === undefined ? {} : { limits: runtime.limits }),
      });
    },
    turn: (session, command) => docker.execStream(session, sessionNames(session).container, { user: runtime.user, workdir: WORKDIR_MOUNT, command }),
    async endTurn(session) {
      await docker.exec(session, sessionNames(session).container, END_TURN, { timeoutMs: 10_000 });
    },
    stop: async (session) => { await stopSession(docker, session); },
  };
}

export type CursorOptions = {
  readonly log: EventLog;
  readonly cleaner: () => Cleaner;
  readonly launcher?: CursorLauncher;
  readonly docker?: Docker;
  readonly runtime?: CursorRuntime;
  readonly policy?: (input: StartInput) => Policy;
  readonly newId?: () => string;
  readonly now?: () => Date;
};

// A turn's own process and the reason it is being ended: per turn, since the
// close of an ended turn can arrive after the next one has begun.
type Turn = { readonly child: ChildProcessWithoutNullStreams; ending: 'interrupt' | 'blocked' | undefined };

type Session = {
  readonly id: SessionId;
  readonly input: StartInput;
  readonly cleaner: Cleaner;
  readonly mapper: CursorMapper;
  readonly wake: Set<() => void>;
  readonly queue: string[];
  chat: string | undefined;                       // Cursor's chat id
  turn: Turn | undefined;                         // the running turn
  closed: boolean;
  closing: boolean;                               // stop() is ending the running turn
  handedOver: boolean;                            // a human has the chat (Take over)
  turnDone: Promise<void>;
  handle: SessionHandle | undefined;
};

const SIGNED_OUT = /not\s+(?:logged|signed)\s+in|log\s*in\s+required|unauthori[sz]ed|authentication|api\s*key/i;

export function createCursorAdapter(options: CursorOptions): SessionAdapter {
  const { log } = options;
  const runtime = options.runtime ?? cursorRuntime();
  const launcher = options.launcher ?? dockerLauncher(options.docker ?? new Docker(), runtime);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const policyOf = options.policy ?? ((input: StartInput) => input.policy);
  const sessions = new Map<SessionId, Session>();
  const chatFile = (id: SessionId) => join(runtime.stateDir, 'cursor-chats', `${id}.chat`);

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

  function rememberChat(session: Session, chat: string): void {
    if (session.chat !== undefined || !isChatId(chat)) return;
    session.chat = chat;
    try {
      mkdirSync(join(runtime.stateDir, 'cursor-chats'), { recursive: true, mode: 0o700 });
      writeFileSync(chatFile(session.id), chat, { mode: 0o600 });
    } catch {
      // The chat stays in memory; a restarted service then starts a new chat.
    }
  }

  function permissionsOf(session: Session): string {
    return JSON.stringify(cursorPermissions(policyOf(session.input)));
  }

  // The full policy on a call Cursor reports. Only an allow lets the turn go on.
  function guard(session: Session, line: Record<string, unknown>): boolean {
    const call = cursorCall(line);
    if (!call) return true;
    const verdict = evaluate(call.request, policyOf(session.input), {
      readFile: (path) => {
        try { return readFileSync(join(session.input.workdir, path.slice(WORKDIR_MOUNT.length + 1)), 'utf8'); } catch { return undefined; }
      },
    });
    if (verdict.decision === 'allow') return true;
    const message = verdict.decision === 'deny'
      ? verdict.message
      : 'This call needs a person\'s approval, and a Cursor turn has no way to wait for one: it was stopped. Ask for an allowed alternative.';
    const turn = session.turn;
    if (turn) turn.ending = 'blocked';
    emit(session, session.mapper.blocked(call.callId, verdict, message));
    void launcher.endTurn(session.id).catch(() => undefined);
    turn?.child.kill();
    return false;
  }

  function failure(code: number | null, stderr: string): { message: string; code: string } {
    if (code === EXIT_NO_LOGIN) return { message: 'Cursor has no login in the session\'s container.', code: 'cursor_login' };
    if (code === EXIT_NO_PERMISSIONS) return { message: 'The Cursor permissions file could not be written in the checkout, so the program did not start.', code: 'cursor_permissions' };
    if (code === EXIT_NO_PROGRAM) return { message: 'Cursor is not installed in the session\'s image.', code: 'cursor_not_installed' };
    if (SIGNED_OUT.test(stderr)) return { message: 'Cursor refused the login: sign in again or renew the key.', code: 'cursor_login' };
    return { message: 'The Cursor program ended without an answer.', code: 'cursor_exit' };
  }

  async function runTurn(session: Session, text: string): Promise<void> {
    emit(session, session.mapper.beginTurn());
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await launcher.turn(session.id, turnCommand(permissionsOf(session), session.input.model, session.chat));
    } catch {
      emit(session, session.mapper.turnFailed('The Cursor program could not be started.', 'cursor_launch'));
      return;
    }
    const turn: Turn = { child, ending: undefined };
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
      if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') rememberChat(session, frame.session_id);
      if (frame.type === 'tool_call' && frame.subtype === 'started' && !guard(session, frame)) return;
      emit(session, session.mapper.line(frame));
    });
    child.stdin.end(text);
    await new Promise<void>((done) => {
      child.on('close', (code: number | null) => {
        if (session.turn === turn) session.turn = undefined;
        if (turn.ending === 'interrupt') { if (!session.closing) emit(session, session.mapper.cancelled('waiting_human', 'Waiting for a message')); } else if (turn.ending === undefined) {
          const { message, code: reason } = failure(code, stderr);
          emit(session, session.mapper.turnFailed(message, reason));
        }
        done();
      });
    });
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
        // A Cursor turn never waits on a request, so none can be answered.
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
      async handover() {
        throw new NotImplemented('handing a session over to another harness comes in milestone 3');
      },
    };
  }

  return {
    harness: 'cursor',
    async start(input) {
      if (input.harness !== 'cursor') throw new Error(`this adapter runs cursor sessions, not ${input.harness}`);
      const id = newId();
      const session: Session = {
        id, input, cleaner: options.cleaner(), mapper: createCursorMapper({ sessionId: id }), wake: new Set(), queue: [],
        chat: undefined, turn: undefined, closed: true, closing: false, handedOver: false, turnDone: Promise.resolve(), handle: undefined,
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
      // Given back after a human had the chat: the next turn resumes it as the human left it.
      session.handedOver = false;
      return session.handle ?? (session.handle = handle(session));
    },
    async interactive(id): Promise<InteractiveResume> {
      const session = sessions.get(id);
      if (!session || session.closed) return { supported: false, reason: `There is no running session ${id} here to resume in a terminal.` };
      if (session.chat === undefined) return { supported: false, reason: 'Cursor has not started a chat for this session yet: there is nothing to resume. Open the Shell instead.' };
      if (session.turn) {
        // One writer at a time: the running turn ends, then the human has the chat.
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
      return { supported: true, name: INTERACTIVE_NAME, command: interactiveCommand(permissionsOf(session), session.input.model, session.chat) };
    },
  };
}
