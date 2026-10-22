// Take over and Give back (docs/v2/milestone-2-plan.md, decisions 30 and
// 32, lane 20): brief 5.10's "Open in terminal" and "Give back to Cleared".
//
//   POST /api/sessions/:id/takeover pauses an author's or a reviewer's live
//   session (the reviewer's by the owner's decision of 2026-10-22 22:01): the
//   engine interrupts its turn, settles what waited for the human as
//   cancelled and records who took it over and when (`takenOver`). The
//   session screen then opens the web terminal (lanes 31 and 32) on the
//   session's own harness, resumed on the same session in its container
//   through the harness adapter, with a shell as the second choice (owner
//   request of 2026-10-22 17:26, terminal/human.ts).
//   POST /api/sessions/:id/giveback closes that terminal (the harness
//   leaves, its transcript kept), then resumes the session with the
//   harness's resume in the same container, from that transcript, and tells
//   it to carry on.
//
// In milestone 2 the users module has no role, so Take over is the single
// owner account's: the first account of the users table (the oldest, the
// one setup creates). Any other signed-in account is refused (403) before
// the session is looked at, so a second account added later never gets a
// session's container; roles come in a later milestone. Give back is the
// owner's too, and only for a session the owner took over.
//
// This file holds the routes and the words; the engine (flow/engine.ts)
// does the work, since it owns the sessions. What the human did meanwhile
// (decisions 32 and 33, lane 31) is the human side's (terminal/human.ts):
// Take over records the checkout's state in the session's container; Give
// back closes the web terminal, finds the files the human changed since
// (the terminal's, against that state, and the editor's saves), journals
// them as `cleared.human_edit`, lets the engine resume the session, then
// tells it, in one notice, every file and its counts. The engine's own
// words at Give back (GIVEN_BACK) come first, as a separate message: the
// engine sends them and is not this lane's file. A session whose plan still
// waits for its Go is told nothing by the engine, and nothing here either:
// the Go tells it, and the reviewer's prompt names the files.
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import type { HumanSide } from '../terminal/human.ts';
import { FlowError, type FlowEngine } from './engine.ts';
import { humanEditNotice, userName } from './human-edits.ts';

// The rule a request cancelled by the take over is settled with.
export const TAKEN_OVER = 'takeover';

// What the resumed session is told at Give back.
export const GIVEN_BACK = [
  'The owner, who had taken over this session, gave the session back to you.',
  'Carry on with the ticket where you left off: what the owner did with you meanwhile, if anything, is in the conversation above. The owner may have changed files of the checkout: read again any file before you edit it.',
].join('\n');

// What a reviewer is told instead (owner decision of 2026-10-22 22:01: a
// reviewer's session is taken over too): its review goes on, and ends with
// the report its first message asked for, which the flow reads.
export const GIVEN_BACK_REVIEW = [
  'The owner, who had taken over this session, gave the session back to you.',
  'Carry on with the review where you left off, and end it with the report and the verdict line asked for at the start: what the owner did with you meanwhile, if anything, is in the conversation above. The owner may have changed files of the checkout: read again any file you judge.',
].join('\n');

export type TakeoverDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
  readonly human?: (registry: Registry) => HumanSide | undefined;   // lane 31; none: Take over and Give back as lane 20 made them
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<FlowError['kind'], number> = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

// One line per file for the notice: the counts of a file changed twice added up.
function merged(edits: readonly { readonly path: string; readonly added: number; readonly removed: number }[]): { path: string; added: number; removed: number }[] {
  const out = new Map<string, { path: string; added: number; removed: number }>();
  for (const edit of edits) {
    const seen = out.get(edit.path) ?? { path: edit.path, added: 0, removed: 0 };
    out.set(edit.path, { path: edit.path, added: seen.added + edit.added, removed: seen.removed + edit.removed });
  }
  return [...out.values()];
}

// The owner account of milestone 2: the first of the users table.
export async function ownerOf(registry: Registry): Promise<UserId | undefined> {
  return (await registry.users.list())[0]?.id;
}

// The checks of every write of the service's API (api/routes.ts): the
// app's proof, the flow, a user the service knows; then the owner.
export function takeoverRoutes(deps: TakeoverDeps): Route[] {
  const write = (run: (engine: FlowEngine, user: UserId, id: string, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = header(context.request, SERVICE_USER_HEADER);
      if (!user || !(await context.registry.users.get(user))) throw new HttpError(403, 'unknown user');
      if (user !== await ownerOf(context.registry))
        throw new HttpError(403, 'taking a session over is the owner account\'s alone in this version (the first account of this service): ask the owner');
      await run(engine, user, context.params.id as string, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof FlowError) answer(context, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
  return [
    {
      method: 'POST', path: '/api/sessions/:id/takeover',
      handle: write(async (engine, user, id, context) => {
        const taken = await engine.takeOver(id, user);
        await deps.human?.(context.registry)?.takenOver(id);
        answer(context, 200, { accepted: true, by: taken.by });
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/giveback',
      handle: write(async (engine, user, id, context) => {
        const taken = engine.takenOver(id);
        if (taken && taken.by !== user) throw new HttpError(403, 'only the account that took the session over gives it back');
        const human = taken ? deps.human?.(context.registry) : undefined;
        const edits = human ? await human.givingBack(id, user) : [];
        await engine.giveBack(id);
        human?.given(id);
        const plan = engine.sessionDetail(id)?.state.plan;
        if (edits.length > 0 && !(plan && !plan.go)) {
          const notice = humanEditNotice(await userName(context.registry.users, user), merged(edits));
          await engine.send(id, notice, 'cleared').catch((error: unknown) =>
            console.error(`cleared-v2: session ${id} could not be told of the human's changes (${error instanceof Error ? error.name : typeof error})`));
        }
        answer(context, 200, { accepted: true });
      }),
    },
  ];
}
