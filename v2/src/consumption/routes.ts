// The routes of the Consumption screen (docs/v2/requirements-matrix.md, O15),
// registered by the lead module beside the schedules, whose pause is one of
// the levers: GET /api/consumption (`?tz=<IANA zone>` for the days) and POST
// /api/consumption/levers; the week's figures, GET /api/consumption/week
// (`?tz=` too, C17, week.ts); and the cost of a ticket from the ledger, GET
// /api/tickets/:id/cost (P211, ticket-cost.ts). Guarded as the recipes' are:
// the app's proof, then the flow running, then for a write a user the
// service knows.
import type { DatabaseSync } from 'node:sqlite';
import { guard, HttpError, readJson, send } from '../recipes/routes.ts';
import type { Registry, Route } from '../modules/registry.ts';
import type { UserId } from '../session/contract.ts';
import type { TicketStore } from '../tickets/contract.ts';
import { LeverError, LeverStore, type LeversChange } from './levers.ts';
import { ticketCost } from './ticket-cost.ts';
import { consumption, leverChoices } from './usage.ts';
import { weekFigures } from './week.ts';

export type ConsumptionTarget = {
  readonly db: DatabaseSync;
  readonly project: string;
  readonly config: { readonly authorModel: string; readonly reviewerModel: string };
  // The week's figures read the tickets merged from the ticket store, and
  // name the workspace's services in its configuration's order.
  readonly tickets?: TicketStore;
  readonly services?: readonly string[];
};

export type ConsumptionRouteDeps = {
  // The ledger and the flow's configuration, or undefined while the service runs no flow.
  readonly target: (registry: Registry) => ConsumptionTarget | undefined;
  readonly proof: () => string;
  readonly now?: () => Date;
};

const DOWN = 'the consumption is not available: CLEARED_V2_PROJECT is unset or the flow has no adapter';

export function consumptionRoutes(deps: ConsumptionRouteDeps): Route[] {
  const now = deps.now ?? (() => new Date());
  const guarded = (write: boolean, run: Parameters<typeof guard<ConsumptionTarget>>[2]) => guard({ target: deps.target, proof: deps.proof, down: DOWN }, write, run);
  return [
    {
      method: 'GET', path: '/api/consumption',
      handle: guarded(false, async (target, _user, c) => {
        const zone = new URL(c.request.url ?? '/', 'http://service').searchParams.get('tz') ?? undefined;
        send(c.response, 200, consumption(target.db, {
          project: target.project, now: now(), ...(zone ? { timeZone: zone } : {}),
          levers: new LeverStore(target.db, target.project).read(), config: target.config,
        }));
      }),
    },
    {
      method: 'GET', path: '/api/consumption/week',
      handle: guarded(false, async (target, _user, c) => {
        const zone = new URL(c.request.url ?? '/', 'http://service').searchParams.get('tz') ?? undefined;
        send(c.response, 200, await weekFigures(target.db, target.tickets, {
          project: target.project, services: target.services ?? [], now: now(), ...(zone ? { timeZone: zone } : {}),
        }));
      }),
    },
    {
      method: 'POST', path: '/api/consumption/levers',
      handle: guarded(true, async (target, user, c) => {
        const body = await readJson(c.request);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'the body is an object: { model?, maxLanes?, paused? }');
        try {
          const set = new LeverStore(target.db, target.project).set(body as LeversChange, user as UserId, now().toISOString(), target.config.reviewerModel, target.config.authorModel);
          send(c.response, 200, leverChoices(set, target.config));
        } catch (error) {
          if (error instanceof LeverError) throw new HttpError(400, error.message);
          throw error;
        }
      }),
    },
    {
      method: 'GET', path: '/api/tickets/:id/cost',
      handle: guarded(false, async (target, _user, c) => {
        send(c.response, 200, ticketCost(target.db, { project: target.project, ticket: c.params.id as string }));
      }),
    },
  ];
}
