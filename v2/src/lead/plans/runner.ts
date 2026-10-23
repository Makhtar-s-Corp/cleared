// The plans (docs/v2/milestone-2-plan.md, section 5): a goal turned by the
// lead into a plan the owner approves, whose tickets the service starts.
//
//   propose_plan stores a plan with the estimates of its history
//   (estimates.ts), supersedes the proposal of the same goal still waiting,
//   and puts it in the inbox. The owner approves it in one gesture: the
//   tickets are created in Todo, labelled plan:<id>, size:<s> and Quick for
//   a fast item, and the runner starts them. The model classifies and
//   proposes; the service counts:
//
//   1. An item is ready when every position it waits for has landed. Ready
//      items start in position order while the plan has fewer than
//      maxParallel running (In Progress or In Review); Needs Approval does
//      not hold a slot, so a night fills the inbox without blocking.
//   2. A ticket the flow puts back is started once more, with the note and
//      "integrate the base branch first" in the author's prompt; a second
//      put back holds the item and tells the lead, which decides with
//      start_ticket or asks the owner. A put back by a service restart does
//      not count (decision 12: the runner simply starts it again).
//   3. A release that landed (merged and healthy) lands its item; a rollback
//      is a put back; a release live but not healthy holds its item.
//   4. Paused, a plan starts nothing; its running tickets go on.
//   5. At the week stop (the seven-day window at CLEARED_V2_WEEK_STOP_PERCENT)
//      or past CLEARED_V2_DAY_BUDGET_USD spent since midnight, when it is
//      set, nothing new starts, and the lead and the owner are told once.
//   6. A plan is done when every item has landed or is cancelled.
//
// An item may run in steps across services (decision 26, lane 23): its
// ticket names the services of its steps, its start gives the flow the
// steps and the plan's maxParallel, and its estimate adds the steps'. In a
// workspace of several services, an item without steps names the services
// its body names, which the flow derives the steps from.
//
// What happens to a ticket is heard on the flow's bus (onFlowEvent). The bus
// is in memory, so each tick also reads the tickets themselves: an item
// running whose ticket is back in Todo, and not run by the flow, is a put
// back that was missed.
import type { Plan, PlanItemState } from '../../api/types.ts';
import { FlowError, QUICK_LABEL } from '../../flow/engine.ts';
import type { FlowEvent, FlowListener, Origin } from '../../flow/events.ts';
import { landingOf } from '../../flow/ledger.ts';
import type { InboxStore } from '../../inbox/store.ts';
import { reportHealth } from '../../notify/queue.ts';
import { HostToolRefused, type UserId } from '../../session/contract.ts';
import type { Store } from '../../store/db.ts';
import type { TicketId, TicketStore } from '../../tickets/contract.ts';
import { LeadConfigError } from '../config.ts';
import type { LeadToolOutput } from '../contract.ts';
import { duration, estimateFor, historyOf, itemOfSteps, planTotals, stepHistoryOf } from './estimates.ts';
import { FINAL_ITEM_STATES, PlanStore, itemServices, publicPlan, type StoredItem, type StoredPlan } from './store.ts';
import { validatePlan } from './tools.ts';

export type PlanConfig = {
  readonly maxParallel: number;              // a plan's tickets running at once
  readonly weekStopPercent: number;          // CLEARED_V2_WEEK_STOP_PERCENT: nothing new starts at this share of the seven-day window
  readonly dayBudgetUsd: number | undefined; // CLEARED_V2_DAY_BUDGET_USD: nothing new starts past this cost since midnight
};

export const DEFAULT_PLAN_CONFIG: PlanConfig = { maxParallel: 2, weekStopPercent: 85, dayBudgetUsd: undefined };

// A setting that is set but wrong stops the service, as the lead's do.
export function loadPlanConfig(env: NodeJS.ProcessEnv = process.env): PlanConfig {
  let weekStopPercent = DEFAULT_PLAN_CONFIG.weekStopPercent;
  const week = env.CLEARED_V2_WEEK_STOP_PERCENT;
  if (week !== undefined && week !== '') {
    weekStopPercent = Number(week);
    if (!Number.isFinite(weekStopPercent) || weekStopPercent <= 0 || weekStopPercent > 100) throw new LeadConfigError(`CLEARED_V2_WEEK_STOP_PERCENT must be a share in percent, above 0 and at most 100, not "${week}"`);
  }
  let dayBudgetUsd: number | undefined;
  const budget = env.CLEARED_V2_DAY_BUDGET_USD;
  if (budget !== undefined && budget !== '') {
    dayBudgetUsd = Number(budget);
    if (!Number.isFinite(dayBudgetUsd) || dayBudgetUsd <= 0) throw new LeadConfigError(`CLEARED_V2_DAY_BUDGET_USD must be an amount in dollars above 0, not "${budget}"`);
  }
  return { maxParallel: DEFAULT_PLAN_CONFIG.maxParallel, weekStopPercent, dayBudgetUsd };
}

export type PlanErrorKind = 'not_found' | 'conflict' | 'invalid';

export class PlanError extends Error {
  override name = 'PlanError';
  readonly kind: PlanErrorKind;
  constructor(kind: PlanErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// What the plans use of the lead (lead/engine.ts LeadEngine).
export type PlanLead = {
  enqueue(text: string, urgent?: boolean): void;
  serviceLine(text: string): unknown;
  planLine(planId: string, text: string): unknown;
  publishPlan(plan: Plan): void;
};

// What the plans use of the flow (flow/engine.ts FlowEngine).
export type PlanFlow = {
  start(ticket: TicketId, by: UserId, origin?: Origin): Promise<void>;
  isActive(ticket: TicketId): boolean;
  subscribe(listener: FlowListener): () => void;
};

export type PlanDeps = {
  readonly store: Pick<Store, 'db' | 'events' | 'sessions'>;
  readonly inbox: InboxStore;
  readonly tickets: TicketStore;
  readonly flow: PlanFlow;
  readonly lead: PlanLead;
  readonly project: string;
  // The names of the services the workspace's configuration has, in its
  // order: the plans read only these of the ledger's rows (PlanStore).
  readonly services?: readonly string[];
  readonly config: PlanConfig;
  readonly now?: () => Date;
  // Applied to every text of the model before it becomes a plan or a ticket.
  readonly clean?: (text: string) => string;
};

type Stop = { readonly kind: 'week' | 'budget'; readonly text: string };

const ACTIVE: readonly Plan['state'][] = ['approved', 'paused'];
const SHOWN: readonly Plan['state'][] = ['proposed', 'approved', 'paused'];
const BASE_HINT = 'The base branch may have moved since: integrate the base branch first.';

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);
const tickets = (n: number) => (n === 1 ? '1 ticket' : `${n} tickets`);

export class PlanRunner {
  readonly store: PlanStore;
  #deps: PlanDeps;
  #now: () => Date;
  #clean: (text: string) => string;
  #tracked = new Set<Promise<unknown>>();
  #starting = new Set<TicketId>();
  #running: Promise<void> | undefined;
  #next: Promise<void> | undefined;
  #told: Stop['kind'] | undefined;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: PlanDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#clean = deps.clean ?? ((text) => text);
    this.store = new PlanStore(deps.store.db, deps.project, this.#now, deps.services);
  }

  // ---- lifecycle -------------------------------------------------------------

  listen(): void {
    this.#unsubscribe ??= this.#deps.flow.subscribe((event) => this.onFlowEvent(event));
  }

  // Ticks every `ms` until close(); the timer never keeps the process alive.
  startTimer(ms = 30_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch((error) => console.error(`cleared-v2: plan tick failed (${errorName(error)})`)); }, ms);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    await this.settled();
  }

  // Waits until nothing the runner started is still running. For the tests.
  async settled(): Promise<void> {
    while (this.#tracked.size > 0 || this.#running || this.#next) {
      await Promise.allSettled([...this.#tracked, this.#running, this.#next]);
    }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#tracked.add(promise);
    const done = () => { this.#tracked.delete(promise); };
    promise.then(done, done);
    return promise;
  }

  // ---- reading ----------------------------------------------------------------

  get(id: string): StoredPlan | undefined {
    return this.store.get(id);
  }

  list(): Plan[] {
    return this.store.list().map(publicPlan);
  }

  plan(id: string): Plan {
    const plan = this.store.get(id);
    if (!plan) throw new PlanError('not_found', `unknown plan ${id}`);
    return publicPlan(plan);
  }

  #publish(id: string): void {
    const plan = this.store.get(id);
    if (plan) this.#deps.lead.publishPlan(publicPlan(plan));
  }

  // The plans' lines of the lead's compact state.
  stateLines(): string {
    const plans = this.store.list(SHOWN);
    if (plans.length === 0) return '';
    return ['Plans:', ...plans.map((plan) => `- ${plan.id} "${plan.title}" ${plan.state}: ${plan.items.map((item) =>
      `#${item.position} ${item.state}${item.ticket ? ` ${item.ticket}` : ''}${item.state === 'waiting' && item.after.length ? ` (after ${item.after.join(', ')})` : ''}`).join(', ')}.`)].join('\n');
  }

  // The plans' section of the handover's structured record.
  handoverSection(): string {
    const plans = this.store.list(SHOWN);
    if (plans.length === 0) return '';
    return ['Plans:', ...plans.flatMap((plan) => [
      `- ${plan.id} "${plan.title}" (goal ${plan.goal}), ${plan.state}${plan.approvedBy ? `, approved by ${plan.approvedBy}` : ''}:`,
      ...plan.items.map((item) => `  ${item.position}. ${item.title}: ${item.state}${item.ticket ? ` (${item.ticket})` : ''}${item.after.length ? `, after ${item.after.join(', ')}` : ''}${item.putBacks ? `, put back ${item.putBacks} time${item.putBacks > 1 ? 's' : ''}` : ''}`),
    ])].join('\n');
  }

  // ---- the lead's tools ------------------------------------------------------------

  async propose(input: unknown): Promise<LeadToolOutput['propose_plan']> {
    const valid = validatePlan(input, this.store.services());
    const clean = (text: string) => this.#clean(text);
    const samples = await historyOf({ tickets: this.#deps.tickets, store: this.#deps.store }, this.#deps.project);
    const stepSamples = valid.items.some((item) => item.steps) ? await stepHistoryOf({ tickets: this.#deps.tickets, db: this.#deps.store.db }, this.#deps.project) : [];
    const maxParallel = this.#deps.config.maxParallel;
    const items = valid.items.map((item) => {
      const base = { title: clean(item.title), body: clean(item.body), lane: item.lane, size: item.size, after: item.after };
      return item.steps ? { ...base, ...itemOfSteps(item.steps, stepSamples, item.size, item.lane, maxParallel) } : { ...base, estimate: estimateFor(samples, item.size, item.lane) };
    });
    const totals = planTotals(items, maxParallel);
    const { plan, superseded } = this.store.propose({ goal: valid.goal, title: clean(valid.title), summary: clean(valid.summary), maxParallel, totals, items });
    for (const id of superseded) {
      this.#deps.inbox.handle(`plan:${id}`, 'system');
      this.#publish(id);
    }
    this.#deps.inbox.addPlan({ project: this.#deps.project, planId: plan.id, title: plan.title, summary: plan.summary, itemCount: plan.items.length, totals });
    this.#deps.lead.planLine(plan.id, `Plan to approve: ${plan.title}, ${tickets(plan.items.length)}, about ${duration(totals.minutes)} of work.`);
    this.#publish(plan.id);
    return { plan: plan.id, supersedes: superseded[0] ?? null, totals };
  }

  // The lead starts again an item the runner put back or holds.
  async startTicket(id: TicketId, reason: string): Promise<LeadToolOutput['start_ticket']> {
    const found = this.store.itemOf(id);
    if (!found) throw new HostToolRefused(`${id} is not a ticket of a plan: start_ticket starts only a plan's ticket that was put back or is held.`);
    const { plan, item } = found;
    if (plan.state === 'paused') throw new HostToolRefused(`Plan ${plan.id} is paused: the owner resumes it.`);
    if (plan.state !== 'approved') throw new HostToolRefused(`Plan ${plan.id} is ${plan.state}: only an approved plan starts tickets.`);
    if (item.state !== 'put_back' && item.state !== 'held') throw new HostToolRefused(`Item ${item.position} of plan ${plan.id} (${id}) is ${item.state}: start_ticket starts an item that was put back or is held.`);
    const stop = this.#stop();
    if (stop) throw new HostToolRefused(stop.text);
    const running = plan.items.filter((i) => i.state === 'running').length;
    if (running >= plan.maxParallel) throw new HostToolRefused(`Plan ${plan.id} already runs ${tickets(running)}, its most at a time: start it once one of them waits for approval.`);
    const failed = await this.#launch(plan, item, `The lead starts this ticket again: ${this.#clean(reason)}\n${BASE_HINT}`);
    if (failed) throw new HostToolRefused(`${id} did not start: ${failed}`);
    return { started: id };
  }

  // ---- the owner's gestures ------------------------------------------------------------

  async approve(id: string, user: UserId): Promise<Plan> {
    const plan = this.store.get(id);
    if (!plan) throw new PlanError('not_found', `unknown plan ${id}`);
    if (!this.store.move(id, ['proposed'], 'approved', user)) throw new PlanError('conflict', `plan ${id} is ${this.store.get(id)?.state ?? plan.state}: only a proposed plan is approved`);
    this.#deps.inbox.handle(`plan:${id}`, user);
    // The tick creates the tickets, one tick at a time: a timer's tick
    // during the approval cannot create them twice.
    await this.tick();
    const n = plan.items.length;
    this.#deps.lead.serviceLine(`The owner approved plan ${id} ("${plan.title}"): ${n === 1 ? 'its ticket is' : `its ${n} tickets are`} created and start in order, at most ${plan.maxParallel} at a time.`);
    this.#publish(id);
    return this.plan(id);
  }

  async reject(id: string, user: UserId, message: string): Promise<Plan> {
    const plan = this.store.get(id);
    if (!plan) throw new PlanError('not_found', `unknown plan ${id}`);
    if (!this.store.move(id, ['proposed'], 'rejected')) throw new PlanError('conflict', `plan ${id} is ${plan.state}: only a proposed plan is rejected`);
    this.#deps.inbox.handle(`plan:${id}`, user);
    this.#deps.lead.serviceLine(`The owner rejected plan ${id}: ${message.trim() || 'no reason given.'}`);
    this.#publish(id);
    return this.plan(id);
  }

  async pause(id: string, _user: UserId): Promise<Plan> {
    const plan = this.store.get(id);
    if (!plan) throw new PlanError('not_found', `unknown plan ${id}`);
    if (!this.store.move(id, ['approved'], 'paused')) throw new PlanError('conflict', `plan ${id} is ${plan.state}: only an approved plan is paused`);
    this.#deps.lead.serviceLine(`The owner paused plan ${id}: running tickets go on, nothing new starts.`);
    this.#publish(id);
    return this.plan(id);
  }

  async resume(id: string, _user: UserId): Promise<Plan> {
    const plan = this.store.get(id);
    if (!plan) throw new PlanError('not_found', `unknown plan ${id}`);
    if (!this.store.move(id, ['paused'], 'approved')) throw new PlanError('conflict', `plan ${id} is ${plan.state}: only a paused plan is resumed`);
    this.#deps.lead.serviceLine(`The owner resumed plan ${id}.`);
    this.#publish(id);
    await this.tick();
    return this.plan(id);
  }

  // ---- what the flow says ------------------------------------------------------------

  onFlowEvent(event: FlowEvent): void {
    if (event.project !== this.#deps.project) return;
    const found = this.store.itemOf(event.ticket);
    if (!found || !ACTIVE.includes(found.plan.state)) return;
    const { plan, item } = found;
    switch (event.type) {
      case 'ticket_started':
        if (!FINAL_ITEM_STATES.has(item.state)) this.#set(plan, item, 'running');
        return;
      case 'release_requested':
        if (!FINAL_ITEM_STATES.has(item.state)) this.#set(plan, item, 'needs_approval');
        return;
      case 'release_landed':
        this.#set(plan, item, 'landed');
        // Its dependents may start now, not at the next tick.
        void this.#track(this.tick().catch((error) => console.error(`cleared-v2: plan tick failed (${errorName(error)})`)));
        return;
      case 'release_unhealthy':
        this.#hold(plan, item, `Pull request #${event.pr} is live but not healthy: ${event.note}`,
          `Item ${item.position} of plan ${plan.id} (${event.ticket}) is live but not healthy: ${event.note} It is held, so the items after it wait. Tell the owner, who decides.`);
        return;
      case 'ticket_put_back':
        this.#putBack(plan, item, event.note, event.reason !== 'restart', event.reason === 'rolled_back');
        return;
      default:
        return;
    }
  }

  #set(plan: StoredPlan, item: StoredItem, state: PlanItemState, change: { putBack?: boolean; note?: string | null } = {}): void {
    if (item.state === state && !change.putBack && change.note === undefined) return;
    this.store.setItem(plan.id, item.position, { state, ...change });
    this.#publish(plan.id);
  }

  #hold(plan: StoredPlan, item: StoredItem, note: string, told: string, putBack = false): void {
    if (item.state === 'held') return;
    this.#set(plan, item, 'held', { note, putBack });
    this.#deps.lead.enqueue(told, true);
  }

  // A put back counts toward the hold unless the service's restart caused it.
  // Only a rollback puts back an item that landed.
  #putBack(plan: StoredPlan, item: StoredItem, note: string, counts: boolean, rollback = false): void {
    if (item.state === 'cancelled' || item.state === 'held') return;
    if (item.state === 'landed' && !rollback) return;
    // The tick may read the ticket in Todo before the flow says why: the
    // flow's word then only replaces the note.
    if (item.state === 'put_back') {
      this.#set(plan, item, 'put_back', { note });
      return;
    }
    if (counts && item.putBacks + 1 >= 2) {
      this.#hold(plan, item, note,
        `Item ${item.position} of plan ${plan.id} (${item.ticket}) went back to Todo a second time and is held: ${note} Decide: start it again with start_ticket, or ask the owner.`, true);
      return;
    }
    this.#set(plan, item, 'put_back', { note, putBack: counts });
  }

  // ---- the tick ---------------------------------------------------------------

  // One tick at a time; a tick asked while one runs runs after it, once.
  tick(): Promise<void> {
    if (this.#next) return this.#next;
    if (!this.#running) {
      this.#running = this.#tickOnce().finally(() => { this.#running = undefined; });
      return this.#running;
    }
    this.#next = this.#running.catch(() => undefined).then(() => {
      this.#next = undefined;
      return this.tick();
    });
    return this.#next;
  }

  async #tickOnce(): Promise<void> {
    const stop = this.#stop();
    let blocked = false;
    for (const listed of this.store.list(ACTIVE)) {
      if (listed.state === 'approved') await this.#createTickets(listed);
      await this.#reconcile(listed);
      const plan = this.store.get(listed.id) as StoredPlan;
      if (plan.items.every((item) => FINAL_ITEM_STATES.has(item.state))) {
        this.#finish(plan);
        continue;
      }
      if (plan.state !== 'approved') continue;
      const startable = this.#startable(plan);
      if (stop) blocked ||= startable.length > 0;
      else for (const item of startable) await this.#launch(plan, item, item.state === 'put_back' ? `Cleared: this ticket went back to Todo before: ${item.note ?? 'no note was written'}\n${BASE_HINT}` : undefined, false);
    }
    if (!stop) this.#told = undefined;
    else if (blocked && this.#told !== stop.kind) {
      this.#told = stop.kind;
      this.#deps.lead.enqueue(`${stop.text} Tell the owner once.`, true);
      try {
        reportHealth(this.#deps.store.db, { code: 'week_stop', at: this.#now().toISOString() });
      } catch (error) {
        console.error(`cleared-v2: the week stop could not be notified (${errorName(error)})`);
      }
    }
  }

  // The tickets of an approved plan that do not exist yet, in position
  // order, by the person who approved it; a failure is tried again at the
  // next tick.
  async #createTickets(plan: StoredPlan): Promise<void> {
    for (const item of plan.items) {
      if (item.ticket) continue;
      try {
        const labels = [`plan:${plan.id}`, `size:${item.size}`, ...(item.lane === 'fast' ? [QUICK_LABEL] : [])];
        const services = this.#ticketServices(item);
        const created = await this.#deps.tickets.create({ title: item.title, body: item.body, labels, project: this.#deps.project, ...(services ? { services } : {}) }, { kind: 'human', id: plan.approvedBy as UserId });
        this.store.setTicket(plan.id, item.position, created.id);
      } catch (error) {
        console.error(`cleared-v2: a ticket of plan ${plan.id} could not be created, the next tick tries again (${errorName(error)})`);
        return;
      }
    }
  }

  // The services an item's ticket names in a workspace of several: its
  // steps', in their order, else those its body names; none in a workspace
  // of one, whose tickets name none.
  #ticketServices(item: StoredItem): string[] | undefined {
    if (item.steps) return [...new Set(item.steps.map((step) => step.service))];
    const services = this.store.services();
    return services.length > 1 ? itemServices(item.body, services).map((service) => service.name) : undefined;
  }

  // Each item as its ticket says, for what the bus did not say.
  async #reconcile(plan: StoredPlan): Promise<void> {
    const states = this.#deps.tickets.states;
    for (const listed of plan.items) {
      if (!listed.ticket || this.#starting.has(listed.ticket) || FINAL_ITEM_STATES.has(listed.state)) continue;
      const ticket = await this.#deps.tickets.get(listed.ticket);
      // The item as it is now: an event may have moved it during the read.
      const fresh = this.store.get(plan.id) as StoredPlan;
      const item = fresh.items.find((i) => i.position === listed.position) as StoredItem;
      if (!ticket || this.#starting.has(listed.ticket) || FINAL_ITEM_STATES.has(item.state)) continue;
      const landed = new Set(fresh.items.filter((i) => i.state === 'landed').map((i) => i.position));
      if (ticket.status === states.todo) {
        if ((item.state === 'running' || item.state === 'needs_approval') && !this.#deps.flow.isActive(ticket.id))
          this.#putBack(fresh, item, 'The ticket went back to Todo.', true);
        else if (item.state === 'waiting' || item.state === 'ready')
          this.#set(fresh, item, item.after.every((p) => landed.has(p)) ? 'ready' : 'waiting');
      } else if (ticket.status === states.progress || ticket.status === states.review) {
        if (item.state !== 'running') this.#set(fresh, item, 'running');
      } else if (ticket.status === states.validate || ticket.status === states.go) {
        if (item.state !== 'held') this.#set(fresh, item, 'needs_approval');
      } else if (ticket.status === states.done && item.state !== 'held') {
        await this.#doneTicket(fresh, item, ticket.id);
      }
    }
  }

  // A Done ticket whose landing the bus did not say (the service stopped in
  // between): a ticket a person closed without a release has landed; one
  // with a release has landed when the release watch said so.
  async #doneTicket(plan: StoredPlan, item: StoredItem, ticket: TicketId): Promise<void> {
    const release = this.#deps.inbox.lastRelease(ticket);
    if (!release) {
      this.#set(plan, item, 'landed');
      return;
    }
    const approval = (await this.#deps.tickets.history(ticket)).filter((h) => h.status === this.#deps.tickets.states.go && h.by.kind === 'human').at(-1);
    if (!approval) return;
    const landing = landingOf(this.#deps.store.db, { ticket, pr: release.pr.number, since: approval.at });
    if (landing.state === 'landed') this.#set(plan, item, 'landed');
    else if (landing.state === 'unhealthy')
      this.#hold(plan, item, `Pull request #${release.pr.number} is live but not healthy: ${landing.note}`,
        `Item ${item.position} of plan ${plan.id} (${ticket}) is live but not healthy: ${landing.note} It is held, so the items after it wait. Tell the owner, who decides.`);
  }

  // What the runner starts now, in position order, within the free slots.
  #startable(plan: StoredPlan): StoredItem[] {
    const landed = new Set(plan.items.filter((i) => i.state === 'landed').map((i) => i.position));
    let free = plan.maxParallel - plan.items.filter((i) => i.state === 'running').length;
    const out: StoredItem[] = [];
    for (const item of plan.items) {
      if (free <= 0) break;
      if (!item.ticket || this.#starting.has(item.ticket)) continue;
      const fresh = (item.state === 'waiting' || item.state === 'ready') && item.after.every((p) => landed.has(p));
      if (!fresh && item.state !== 'put_back') continue;
      out.push(item);
      free--;
    }
    return out;
  }

  // Starts an item's ticket for the person who approved the plan. The item
  // is running before the flow is asked, so no tick starts it twice. In the
  // background unless `wait`; answers the reason it did not start, if it did not.
  async #launch(plan: StoredPlan, item: StoredItem, note: string | undefined, wait = true): Promise<string | undefined> {
    const ticket = item.ticket as TicketId;
    this.#set(plan, item, 'running');
    this.#starting.add(ticket);
    const origin: Origin = {
      plan: plan.id, item: item.position, ...(note ? { note } : {}),
      ...(item.steps ? { steps: item.steps.map(({ kind, service, after }) => ({ kind, service, after })), maxParallel: plan.maxParallel } : {}),
    };
    const started = this.#deps.flow.start(ticket, plan.approvedBy as UserId, origin).then(() => undefined, (error: unknown) => {
      // The flow put a ticket that could not start back itself, and said so
      // on the bus; a ticket in another state is read again at the next tick.
      if (error instanceof FlowError && error.kind === 'not_found') {
        const current = this.store.get(plan.id)?.items.find((i) => i.position === item.position);
        if (current) this.#hold(plan, current, `The ticket ${ticket} is gone.`, `Item ${item.position} of plan ${plan.id}: its ticket ${ticket} is gone, so the item is held. Tell the owner.`);
      } else if (!(error instanceof FlowError)) {
        console.error(`cleared-v2: ${ticket} of plan ${plan.id} could not start (${errorName(error)})`);
      }
      return error instanceof Error ? error.message : String(error);
    }).finally(() => { this.#starting.delete(ticket); });
    this.#track(started);
    return wait ? started : undefined;
  }

  #finish(plan: StoredPlan): void {
    if (!this.store.move(plan.id, ACTIVE, 'done')) return;
    const landed = plan.items.filter((i) => i.state === 'landed').length;
    this.#deps.lead.enqueue(`Plan ${plan.id} is done: ${landed === plan.items.length ? `all ${tickets(landed)}` : `${tickets(landed)} of ${plan.items.length}`} of "${plan.title}" are live.`);
    this.#publish(plan.id);
  }

  // ---- the week stop -----------------------------------------------------------

  // The seven-day window at or above the stop, from the harness's last
  // report while that window runs (the mapper reports a change only, and
  // nothing runs to report the reset of a window that stopped the plans);
  // or, when the day budget is set, the cost of the project's sessions
  // since midnight (the server's time) past it.
  #stop(): Stop | undefined {
    const db = this.#deps.store.db;
    const project = this.#deps.project;
    const week = db.prepare(`SELECT json_extract(event, '$.value.usedPercent') AS used, json_extract(event, '$.value.resetsAt') AS resets FROM session_events
      WHERE project = ? AND type = 'CUSTOM' AND json_extract(event, '$.name') = 'cleared.rate_limit' AND json_extract(event, '$.value.window') = 'seven_day'
      ORDER BY at DESC, rowid DESC LIMIT 1`).get(project) as { used: number | null; resets: string | null } | undefined;
    const limit = this.#deps.config.weekStopPercent;
    const running = !week?.resets || Date.parse(week.resets) > this.#now().getTime();
    if (week && typeof week.used === 'number' && running && week.used >= limit)
      return { kind: 'week', text: `The seven-day window of the subscription is at ${week.used} %: the plans start nothing new until it falls below ${limit} %.` };
    const budget = this.#deps.config.dayBudgetUsd;
    if (budget === undefined) return undefined;
    const midnight = new Date(this.#now());
    midnight.setHours(0, 0, 0, 0);
    const spent = Number((db.prepare(`SELECT COALESCE(SUM(json_extract(event, '$.result.total_cost_usd')), 0) AS spent FROM session_events
      WHERE project = ? AND type = 'RUN_FINISHED' AND at >= ?`).get(project, midnight.toISOString()) as { spent: number }).spent);
    return spent > budget
      ? { kind: 'budget', text: `Today's sessions cost $${spent.toFixed(2)}, past the day budget of $${budget}: the plans start nothing new until tomorrow.` }
      : undefined;
  }
}
