// What every setup route does around its work: the owner first (the proof,
// a known user, the owner: StepDeps.owner), then the step's code; a refusal
// is answered as { error } with its status, a terminal's refusal as the
// session terminal's routes answer it.
import type { Route, RouteContext, User } from '../modules/registry.ts';
import { answer, HttpError } from '../terminal/routes.ts';
import { TerminalError } from '../terminal/terminals.ts';
import type { StepDeps } from './step.ts';

export { answer, HttpError, readBody } from '../terminal/routes.ts';

export function guarded(deps: Pick<StepDeps, 'owner'>, run: (context: RouteContext, user: User) => Promise<void>): Route['handle'] {
  return async (context) => {
    try {
      await run(context, await deps.owner(context));
    } catch (error) {
      if (context.response.headersSent) { context.response.end(); return; }
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof TerminalError) answer(context, error.kind === 'conflict' ? 409 : error.kind === 'unsupported' ? 501 : 400, { error: error.message });
      else throw error;
    }
  };
}
