// The routes of the schedules (docs/v2/milestone-2-plan.md, decision 29):
// GET and POST /api/schedules and DELETE /api/schedules/:id, registered by
// the lead module with the plan runner, guarded as the recipes' are. The
// signed-in user who creates a schedule is its creator, whose approval its
// plans carry.
import { guard, HttpError, readJson, send } from '../recipes/routes.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import type { UserId } from '../session/contract.ts';
import type { Scheduler } from './scheduler.ts';
import { ScheduleError } from './when.ts';

export type ScheduleRouteDeps = {
  // The scheduler, or undefined while the service runs no plans.
  readonly schedules: (registry: Registry) => Pick<Scheduler, 'list' | 'create' | 'remove'> | undefined;
  readonly proof: () => string;
};

const DOWN = 'the schedules are not running: CLEARED_V2_PROJECT is unset, CLEARED_V2_LEAD_ENABLED is off, or the flow has no adapter';

export function scheduleRoutes(deps: ScheduleRouteDeps): Route[] {
  const guarded = (write: boolean, run: (schedules: Pick<Scheduler, 'list' | 'create' | 'remove'>, user: UserId | undefined, context: RouteContext) => Promise<void>) =>
    guard({ target: deps.schedules, proof: deps.proof, down: DOWN }, write, async (schedules, user, context) => {
      try {
        await run(schedules, user, context);
      } catch (error) {
        if (error instanceof ScheduleError) throw new HttpError(400, error.message);
        throw error;
      }
    });
  return [
    { method: 'GET', path: '/api/schedules', handle: guarded(false, async (schedules, _user, c) => send(c.response, 200, schedules.list())) },
    {
      method: 'POST', path: '/api/schedules',
      handle: guarded(true, async (schedules, user, c) => send(c.response, 200, await schedules.create(await readJson(c.request), user as UserId))),
    },
    {
      method: 'DELETE', path: '/api/schedules/:id',
      handle: guarded(true, async (schedules, _user, c) => {
        if (!schedules.remove(c.params.id ?? '')) throw new HttpError(404, 'no such schedule');
        send(c.response, 200, { deleted: true });
      }),
    },
  ];
}
