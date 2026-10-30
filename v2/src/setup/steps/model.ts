// The assistant's model step (docs/v2/milestone-5-plan.md, decision 7): the
// Claude Code login. The person runs `claude setup-token` and pastes what it
// prints into the step's field; it is written to <state>/claude.token (mode
// 600), where the Claude Code adapter reads it (session/adapters/claude-code.ts),
// named in the settings as CLEARED_CLAUDE_CREDENTIALS, and never answered
// back. An API key is not offered: the adapter reads a subscription's token
// only (question 3 of the plan, logged).
//
// The command can run in a terminal of the step: a shell in a throwaway
// container of the session image (setup/container.ts), one at a time, the
// owner's only, through the web terminal's manager (terminal/terminals.ts).
// Nothing of it is kept: no journal, no ledger row; its output lives in
// memory until it closes, as a session terminal's does.
//
// The step runs the command itself (`capture`, issue #490): the terminal opens
// on `claude setup-token`, the person signs in, and the token is taken from
// the output (setup/token-catch.ts), saved as a paste is, and masked before
// anything reaches the browser; then the terminal closes and its container goes.
//
//   GET  /api/setup/model    -> ModelView
//   POST /api/setup/model    { value } -> ModelView, or 400 { error: invalid },
//        409 { error: environment } when the environment names a login file
//   POST /api/setup/model/terminal/open { cols, rows, capture? }; .../input|resize|close,
//        GET .../stream: as a session's terminal routes (terminal/routes.ts)
import { join } from 'node:path';
import { TERMINAL_INPUT_MAX_BYTES } from '../../api/types.ts';
import { SHELL_COMMAND, type SessionContainer } from '../../terminal/container.ts';
import { streamTerminal } from '../../terminal/routes.ts';
import { TerminalError, Terminals } from '../../terminal/terminals.ts';
import { answer, guarded, HttpError, readBody } from '../http.ts';
import { tokenCatch } from '../token-catch.ts';
import { readCredential, settingsPath, stateFolder, writeCredential, writeSettings } from '../settings.ts';
import type { SetupStep, StepDeps } from '../step.ts';
import type { CredentialView, ModelView } from '../types.ts';

export const MODEL_FILE = 'claude.token';
const TERMINAL = 'setup';

// What `claude setup-token` prints: a long-lived OAuth token of a Claude
// subscription, one line (sk-ant-oat01-… today). Only what it cannot be is
// refused, so a change of its prefix does not lock a newcomer out: a paste
// with a space or a line break, one too short, and an API key (sk-ant-api…),
// which the adapter does not read.
export const looksLikeSetupToken = (value: string): boolean => /^[A-Za-z0-9_-]{20,4096}$/.test(value) && !value.startsWith('sk-ant-api');

function credentialOf(deps: StepDeps): CredentialView {
  if (deps.fromEnvironment.has('CLEARED_CLAUDE_CREDENTIALS')) return { set: true, at: null, source: 'environment' };
  if (readCredential(join(stateFolder(deps.env), MODEL_FILE)) === undefined) return { set: false };
  return { set: true, at: deps.records.get('model')?.doneAt ?? null, source: 'assistant' };
}

const SETUP_COMMAND: readonly string[] = ['claude', 'setup-token'];
const TOKEN_START = 'sk-ant-';
const HOLD_MS = 1_200;                         // the output paused this long: what was held is decided as it stands

// The step's terminals, with the token taken out of their output.
function catching(container: SessionContainer, onToken: (token: string) => void): SessionContainer {
  return {
    ...container,
    exec: (...args) => container.exec(...args),
    async terminal(id, size, command) {
      const process = await container.terminal(id, size, command);
      const decoder = new TextDecoder();
      const caught = tokenCatch(onToken);
      return {
        write: (data) => process.write(data),
        resize: (cols, rows) => process.resize(cols, rows),
        onExit: (listener) => process.onExit(listener),
        end: () => process.end(),
        onOutput(listener) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const pass = (text: string) => { if (text) listener(Buffer.from(text)); };
          process.onOutput((chunk) => {
            clearTimeout(timer);
            pass(caught.push(decoder.decode(chunk, { stream: true })));
            if (caught.holding) { timer = setTimeout(() => pass(caught.flush()), HOLD_MS); timer.unref(); }
          });
        },
      };
    },
  };
}

const size = (body: Record<string, unknown>) => ({ cols: body.cols as number, rows: body.rows as number });

const model: SetupStep = {
  id: 'model',
  filled: true,
  skippable: false,
  routes: (deps) => {
    let made: Terminals | undefined;
    // Saved as a paste is; refused with a reason the route says, a capture says nothing.
    const save = (value: string): void => {
      if (!looksLikeSetupToken(value)) throw new HttpError(400, 'invalid');
      const current = credentialOf(deps);
      if (current.set && current.source === 'environment') throw new HttpError(409, 'environment');
      const path = settingsPath(deps.env);
      if (!path) throw new HttpError(503, 'no state folder: set CLEARED_STATE_DIR');
      const file = join(stateFolder(deps.env), MODEL_FILE);
      writeCredential(file, value);
      writeSettings(path, { env: { CLEARED_CLAUDE_CREDENTIALS: file } });
      deps.env.CLEARED_CLAUDE_CREDENTIALS = file;
      deps.records.done('model');
    };
    let opener = '';
    const captured = (token: string): void => {
      try { save(token); } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return;
      }
      // After this turn: the output that holds the mask reaches the stream first.
      setImmediate(() => { void made?.close(TERMINAL, opener, 'closed').catch(() => undefined); });
    };
    const terminals = (): Terminals => {
      if (!made) {
        made = new Terminals({ container: catching(deps.container, captured), journal: () => undefined, clean: (text) => text });
        made.startTimer();
        const kept = made;
        deps.onStop(() => kept.closeAll());
      }
      return made;
    };
    const open = () => terminals().openMode(TERMINAL) !== undefined;
    return [
      {
        method: 'GET', path: '/api/setup/model',
        handle: guarded(deps, async (context) => answer(context, 200, { credential: credentialOf(deps), terminal: true } satisfies ModelView)),
      },
      {
        method: 'POST', path: '/api/setup/model',
        handle: guarded(deps, async (context) => {
          const raw = (await readBody(context.request)).value;
          const pasted = typeof raw === 'string' ? raw.trim() : '';
          // A terminal wraps the token (issue #490): spaces and line breaks go, for what starts as a token only, so words are still refused.
          save(pasted.startsWith(TOKEN_START) ? pasted.replace(/\s+/g, '') : pasted);
          answer(context, 200, { credential: credentialOf(deps), terminal: true } satisfies ModelView);
        }),
      },
      {
        method: 'POST', path: '/api/setup/model/terminal/open',
        handle: guarded(deps, async (context, user) => {
          const body = await readBody(context.request);
          const started = Date.now();
          try {
            opener = user.id;
            answer(context, 200, await terminals().open(TERMINAL, user.id, size(body), { mode: 'shell', command: body.capture === true ? SETUP_COMMAND : SHELL_COMMAND, intro: '' }));
          } catch (error) {
            if (!(error instanceof TerminalError || error instanceof HttpError)) throw new HttpError(503, 'terminal_failed');
            throw error;
          } finally {
            deps.records.machine('model', Date.now() - started);
          }
        }),
      },
      {
        method: 'POST', path: '/api/setup/model/terminal/input',
        handle: guarded(deps, async (context) => {
          const data = (await readBody(context.request)).data;
          if (typeof data !== 'string') throw new HttpError(400, 'data is the text typed');
          if (Buffer.byteLength(data) > TERMINAL_INPUT_MAX_BYTES) throw new HttpError(413, `at most ${TERMINAL_INPUT_MAX_BYTES} bytes per post`);
          if (!open()) throw new HttpError(409, 'no terminal is open');
          terminals().input(TERMINAL, data);
          answer(context, 200, { accepted: true });
        }),
      },
      {
        method: 'POST', path: '/api/setup/model/terminal/resize',
        handle: guarded(deps, async (context) => {
          const body = await readBody(context.request);
          if (!open()) throw new HttpError(409, 'no terminal is open');
          await terminals().resize(TERMINAL, size(body));
          answer(context, 200, { accepted: true });
        }),
      },
      {
        method: 'POST', path: '/api/setup/model/terminal/close',
        handle: guarded(deps, async (context, user) => {
          if (!open()) throw new HttpError(409, 'no terminal is open');
          await terminals().close(TERMINAL, user.id, 'closed');
          answer(context, 200, { accepted: true });
        }),
      },
      {
        method: 'GET', path: '/api/setup/model/terminal/stream',
        handle: guarded(deps, async (context) => streamTerminal(context, terminals(), TERMINAL)),
      },
    ];
  },
};

export default model;
