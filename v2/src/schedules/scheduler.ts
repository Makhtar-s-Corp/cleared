// The scheduler (docs/v2/milestone-2-plan.md, decision 29): schedules live
// in the store (store.ts), and each minute the scheduler starts those that
// are due through the plan runner, with the creator's approval, given when
// the schedule was made, as the plan's approval.
//
//   1. A due run is taken in one UPDATE that moves the schedule to its next
//      run, so a run starts once, whatever ticks overlap. After a stop of
//      the service, a schedule catches up once, not once per missed period;
//      a schedule `at` a time is disabled once taken.
//   2. A run is skipped when the seven-day window is at the week stop
//      (CLEARED_V2_WEEK_STOP_PERCENT, the plan runner's) or at the
//      schedule's own cap, read as the runner reads it: the newest figure
//      of the window, a quota reading's or a session's `cleared.rate_limit`
//      (consumption/quota.ts), unless its reset has passed.
//   3. A recipe runs as recipes/service.ts runs it, approved by the creator,
//      each ticket's budget the schedule's (the runner's start carries it
//      on the Origin: budget.ts). A goal is an owner turn to the lead, as
//      the creator; the plan the lead proposes for that goal (goal-<seq>)
//      within GOAL_PLAN_HOURS is approved for the creator at the next tick.
//   4. The Consumption screen's pause stops all of this: no run is taken,
//      no goal plan approved, until the owner resumes.
//   5. A release still waits for the owner: nothing here approves one.
//
// Each run is said once as a ScheduleEvent and kept in schedule_runs. A run
// that failed (skipped by the week, a recipe gone or refused, a start that
// failed) is a health notification (notify/sources.ts scheduleOccurrence)
// and an event for the lead's next turn, unless the schedule's last run
// failed for the same reason; a run that went well tells the lead by its
// plan's service line and notifies nothing.
import type { DatabaseSync } from 'node:sqlite';
import type { LeverReader } from '../consumption/levers.ts';
import { latestQuota } from '../consumption/quota.ts';
import type { CreateScheduleBody, Schedule } from '../api/types.ts';
import type { PlanLead, PlanRunner } from '../lead/plans/runner.ts';
import { NotifyQueue } from '../notify/queue.ts';
import { scheduleOccurrence } from '../notify/sources.ts';
import { RecipeError } from '../recipes/recipe.ts';
import type { RecipeRun, Recipes } from '../recipes/service.ts';
import type { UserId } from '../session/contract.ts';
import { ScheduleStore } from './store.ts';
import { ScheduleError, nextRun, parseAt, parseEvery } from './when.ts';

export type ScheduleEvent =
  | { readonly type: 'schedule_ran'; readonly schedule: string; readonly at: string; readonly plan?: string; readonly message?: number }
  | { readonly type: 'schedule_failed'; readonly schedule: string; readonly at: string; readonly reason: 'week' | 'recipe' | 'start'; readonly note: string };

export type SchedulerDeps = {
  readonly db: DatabaseSync;
  readonly project: string;
  readonly recipes: Pick<Recipes, 'run' | 'goal' | 'check' | 'approve'>;
  readonly plans: Pick<PlanRunner, 'store'>;
  readonly lead: Pick<PlanLead, 'enqueue'>;
  readonly weekStopPercent: number;
  // The Consumption screen's pause (consumption/levers.ts): nothing starts while it is on.
  readonly levers?: LeverReader;
  readonly now?: () => Date;
};

export const MAX_BUDGET_USD = 1000;
export const GOAL_PLAN_HOURS = 6;
const MAX_GOAL = 20_000;        // the lead's owner message's

const usd = (amount: number) => `$${Number(amount.toFixed(2))}`;
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

// The seven-day window's share, as the plan runner reads it: the newest
// figure of a reading or of a session's report (consumption/quota.ts).
// The week is Claude Code's subscription: a window another harness reports
// (Codex's, milestone 3) is its own, never this one.
export function weekShare(db: DatabaseSync, project: string, now: Date): number | undefined {
  return latestQuota(db, { project, window: 'seven_day', now, harness: 'claude-code' })?.usedPercent;
}

export class Scheduler {
  readonly store: ScheduleStore;
  #deps: SchedulerDeps;
  #now: () => Date;
  #listeners = new Set<(event: ScheduleEvent) => void>();
  #running: Promise<ScheduleEvent[]> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #starting = new Map<string, number>();      // a plan's budget between its proposal and its run's record

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.store = new ScheduleStore(deps.db, deps.project);
  }

  subscribe(listener: (event: ScheduleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  // Ticks every `ms` until close(); the timer never keeps the process alive.
  startTimer(ms = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch((error) => console.error(`cleared-v2: schedule tick failed (${errorName(error)})`)); }, ms);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  list(): Schedule[] {
    return this.store.list();
  }

  get(id: string): Schedule | undefined {
    return this.store.get(id);
  }

  remove(id: string): boolean {
    return this.store.remove(id, this.#now().toISOString());
  }

  budgetOf(plan: string): number | undefined {
    return this.#starting.get(plan) ?? this.store.budgetOfPlan(plan);
  }

  // A schedule of `by`, refused with the reason when a run of it would be.
  async create(input: unknown, by: UserId): Promise<Schedule> {
    const body = (typeof input === 'object' && input !== null && !Array.isArray(input) ? input : {}) as Partial<Record<keyof CreateScheduleBody, unknown>>;
    const refuse = (message: string): never => { throw new ScheduleError(message); };
    const has = (value: unknown) => value !== undefined && value !== null;
    if (has(body.recipe) === has(body.goal)) return refuse('a schedule runs a recipe or a goal: name one of the two');
    const raw = body.parameters ?? {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== 'string'))
      return refuse('the parameters are names and their texts');
    const parameters = raw as Record<string, string>;
    let recipe: string | null = null;
    let goal: string | null = null;
    if (has(body.recipe)) {
      if (typeof body.recipe !== 'string') return refuse('the recipe is a recipe\'s name');
      try {
        await this.#deps.recipes.check(body.recipe, parameters);
      } catch (error) {
        if (error instanceof RecipeError) return refuse(error.message);
        throw error;
      }
      recipe = body.recipe;
    } else {
      if (typeof body.goal !== 'string' || body.goal.trim() === '' || body.goal.length > MAX_GOAL) return refuse(`the goal is a text of 1 to ${MAX_GOAL} characters`);
      if (Object.keys(parameters).length > 0) return refuse('a goal takes no parameters: they are a recipe\'s');
      goal = body.goal.trim();
    }
    if (has(body.at) === has(body.every)) return refuse('a schedule has at or every, one of the two: at a time to run once, or every period');
    const budget = body.budgetUsd;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > MAX_BUDGET_USD) return refuse(`the budget is an amount in dollars above 0 and at most ${MAX_BUDGET_USD}`);
    const cap = body.weekCapPercent;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 100) return refuse('the week cap is a share of the seven-day window from 1 to 100');
    const now = this.#now();
    let at: string | null = null;
    let every: string | null = null;
    let next: Date;
    if (has(body.at)) {
      if (typeof body.at !== 'string') return refuse('at is a time such as 2026-10-24T03:00');
      next = parseAt(body.at, now);
      at = next.toISOString();
    } else {
      if (typeof body.every !== 'string') return refuse('every is a period such as day 03:00');
      every = parseEvery(body.every).text;
      next = nextRun(every, now);
    }
    return this.store.add({ recipe, goal, parameters, at, every, budgetUsd: budget, weekCapPercent: cap, createdBy: by, nextRunAt: next.toISOString() }, now.toISOString());
  }

  // One pass, one at a time: a tick asked while one runs is that tick.
  tick(): Promise<ScheduleEvent[]> {
    this.#running ??= this.#tick().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #tick(): Promise<ScheduleEvent[]> {
    const now = this.#now();
    const at = now.toISOString();
    const events: ScheduleEvent[] = [];
    // Paused from the Consumption screen: a run due now stays due, and is taken once at the resume.
    if (this.#deps.levers?.read().paused) return events;
    for (const schedule of this.store.due(at)) {
      const next = schedule.every ? nextRun(schedule.every, now).toISOString() : null;
      if (!this.store.claim(schedule.id, schedule.nextRunAt as string, next, at)) continue;
      events.push(await this.#run(schedule, at, now));
    }
    await this.#approveGoalPlans(now);
    return events;
  }

  async #run(schedule: Schedule, at: string, now: Date): Promise<ScheduleEvent> {
    const base = { schedule: schedule.id, at, budgetUsd: schedule.budgetUsd, createdBy: schedule.createdBy };
    const cap = Math.min(schedule.weekCapPercent, this.#deps.weekStopPercent);
    const share = weekShare(this.#deps.db, this.#deps.project, now);
    if (share !== undefined && share >= cap) {
      const note = share >= this.#deps.weekStopPercent
        ? `The seven-day window is at ${share} %, at the week stop of ${this.#deps.weekStopPercent} %: the run is skipped.`
        : `The seven-day window is at ${share} %, at or above the schedule's cap of ${schedule.weekCapPercent} %: the run is skipped.`;
      return this.#failed(schedule, base, 'week', note);
    }
    let planned: string | undefined;
    const scheduled = {
      schedule: schedule.id, createdBy: schedule.createdBy, budgetUsd: schedule.budgetUsd,
      planned: (plan: string) => { planned = plan; this.#starting.set(plan, schedule.budgetUsd); },
    };
    let run: RecipeRun;
    try {
      run = schedule.recipe !== null
        ? await this.#deps.recipes.run(schedule.recipe, schedule.parameters, schedule.createdBy, scheduled)
        : await this.#deps.recipes.goal(schedule.goal ?? '', schedule.createdBy, scheduled);
    } catch (error) {
      // A plan proposed but not approved keeps no budget: it waits in the inbox for the owner.
      if (planned) this.#starting.delete(planned);
      if (error instanceof RecipeError) return this.#failed(schedule, base, 'recipe', error.message);
      console.error(`cleared-v2: schedule ${schedule.id} could not start its run (${errorName(error)})`);
      return this.#failed(schedule, base, 'start', error instanceof Error ? error.message : String(error));
    }
    if (planned) this.#starting.delete(planned);
    this.store.record({ ...base, outcome: 'ran', ...(run.plan ? { plan: run.plan } : {}), ...(run.goal ? { goal: run.goal } : {}), ...(run.message !== undefined ? { message: run.message } : {}) });
    return this.#emit({ type: 'schedule_ran', schedule: schedule.id, at, ...(run.plan ? { plan: run.plan } : {}), ...(run.message !== undefined ? { message: run.message } : {}) });
  }

  #failed(schedule: Schedule, base: { schedule: string; at: string; budgetUsd: number; createdBy: UserId }, reason: 'week' | 'recipe' | 'start', note: string): ScheduleEvent {
    const previous = this.store.lastRun(schedule.id);
    this.store.record({ ...base, outcome: 'failed', reason, note });
    const event = this.#emit({ type: 'schedule_failed', schedule: schedule.id, at: base.at, reason, note });
    // The same failure as the last run's was told then: an hourly schedule does not wake the owner every hour.
    if (previous?.outcome === 'failed' && previous.reason === reason) return event;
    this.#deps.lead.enqueue(`Schedule ${schedule.id} (${schedule.recipe ? `the recipe ${schedule.recipe}` : 'a goal'}, created by ${schedule.createdBy}) did not run: ${note} Tell the owner in the morning.`);
    try {
      const occurrence = scheduleOccurrence(event);
      if (occurrence) new NotifyQueue(this.#deps.db).add(occurrence, 'pending', base.at);
    } catch (error) {
      console.error(`cleared-v2: schedule ${schedule.id}'s failed run could not be notified (${errorName(error)})`);
    }
    return event;
  }

  #emit(event: ScheduleEvent): ScheduleEvent {
    for (const listener of this.#listeners) {
      try { listener(event); } catch (error) { console.error(`cleared-v2: a schedule listener failed (${errorName(error)})`); }
    }
    return event;
  }

  // The plans the lead proposed for a schedule's goal, approved for its creator.
  async #approveGoalPlans(now: Date): Promise<void> {
    const waiting = this.store.goalRunsWaiting(new Date(now.getTime() - GOAL_PLAN_HOURS * 3600_000).toISOString());
    if (waiting.length === 0) return;
    const proposed = this.#deps.plans.store.list(['proposed']);
    for (const run of waiting) {
      const plan = proposed.find((p) => p.goal === run.goal);
      if (!plan) continue;
      this.store.setRunPlan(run.id, plan.id);
      try {
        await this.#deps.recipes.approve(plan.id, run.createdBy,
          `Schedule ${run.schedule}'s goal: plan ${plan.id} ("${plan.title}") is approved by ${run.createdBy}, who created the schedule, and its tickets start with a budget of ${usd(run.budgetUsd)} each.`);
      } catch (error) {
        if (!(error instanceof RecipeError)) throw error;
        console.error(`cleared-v2: plan ${plan.id} of schedule ${run.schedule} was not approved: ${error.message}`);
      }
    }
  }
}
