// Running a recipe (docs/v2/milestone-2-plan.md, decision 29). A ticket
// recipe becomes a one-item plan of the plan runner (lane 7), approved at
// once by the person who runs it, or by a schedule's creator: running it is
// the approval, so the plan never waits in the inbox. The runner creates
// the ticket (labels plan:<id>, size:<s>, Quick for the fast lane) and
// starts it as any approved plan's; a release still waits for the owner. A
// goal recipe is an owner turn to the lead, as a goal.
//
// The plan goes through the runner's own propose, with the sensitivity of
// the services applied first as the lead's propose_plan does (decision 24:
// a fast recipe on a full service runs in the full lane). A recipe naming
// several services runs in steps (decision 26), derived from the workspace
// as the flow derives them; naming one in a workspace of several, it runs
// on that one. The lead is told once, by one service line naming the
// recipe and the plan.
import type { Recipe } from '../api/types.ts';
import { deriveSteps } from '../flow/steps.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { PlanLead, PlanRunner } from '../lead/plans/runner.ts';
import { applySensitivity } from '../lead/plans/tools.ts';
import type { UserId } from '../session/contract.ts';
import type { ServiceConfig } from '../workspace/config.ts';
import { RecipeError, publicRecipe, substitute, type RecipeFile } from './recipe.ts';
import type { RecipeSource } from './source.ts';

export type RecipePlans = Pick<PlanRunner, 'propose' | 'tick' | 'plan' | 'store'>;
export type RecipeLead = Pick<PlanLead, 'serviceLine' | 'publishPlan'> & {
  post(text: string, user: UserId, goal?: boolean): Promise<{ readonly seq: number }>;
};

export type RecipeDeps = {
  readonly source: RecipeSource;
  readonly plans: RecipePlans;
  readonly lead: RecipeLead;
  readonly inbox: Pick<InboxStore, 'handle'>;
  readonly workspace: readonly ServiceConfig[];
  // Applied to the title, the body and the goal before they reach a plan, a ticket or the lead.
  readonly clean: (text: string) => string;
  readonly now?: () => Date;
};

// What a run answers: the plan of a ticket recipe, the thread message of a
// goal recipe (POST /api/recipes/:name/run), and the goal's id, which the
// scheduler follows to approve the plan the lead proposes for it.
export type RecipeRun = { readonly accepted: true; readonly plan?: string; readonly message?: number; readonly goal?: string };

// A run started by a schedule: its approval is its creator's, given when the
// schedule was made, and each ticket's budget is the schedule's. `planned`
// hears of the plan before its approval starts the ticket, so its budget is
// known at that start.
export type ScheduledBy = { readonly schedule: string; readonly createdBy: UserId; readonly budgetUsd: number; readonly planned?: (plan: string) => void };

const usd = (amount: number) => `$${Number(amount.toFixed(2))}`;

export class Recipes {
  #deps: RecipeDeps;
  #now: () => Date;
  #runs = 0;
  #told = new Set<string>();

  constructor(deps: RecipeDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  async list(): Promise<Recipe[]> {
    return (await this.#read()).map(publicRecipe);
  }

  // The recipe of that name, as its service's base holds it now.
  async find(name: string): Promise<RecipeFile> {
    const recipe = (await this.#read()).find((r) => r.name === name);
    if (!recipe) throw new RecipeError('not_found', `no recipe ${name} in the services' base branches`);
    return recipe;
  }

  // Refuses what a run of `name` with `parameters` would refuse, writing nothing.
  async check(name: string, parameters: Readonly<Record<string, string>>): Promise<RecipeFile> {
    const recipe = await this.find(name);
    substitute(recipe, parameters);
    return recipe;
  }

  async run(name: string, parameters: Readonly<Record<string, string>>, by: UserId, scheduled?: ScheduledBy): Promise<RecipeRun> {
    const found = await this.check(name, parameters);
    try {
      await this.#deps.source.refresh(found.service);
    } catch (error) {
      // The base as last fetched is still the base: the run goes on.
      console.error(`cleared-v2: ${found.service} could not be fetched before the recipe ${name} (${error instanceof Error ? error.name : typeof error})`);
    }
    const recipe = await this.find(name);
    const { title, body } = substitute(recipe, parameters);
    const clean = this.#deps.clean;
    if (recipe.kind === 'goal') return this.goal(body, by, scheduled);
    const workspace = this.#deps.workspace;
    const steps = workspace.length < 2 ? undefined
      : recipe.services.length < 2 ? recipe.services.map((service) => ({ kind: 'service' as const, service, after: [] as number[] }))
      : deriveSteps(workspace, recipe.services).map(({ kind, service, after }) => ({ kind, service, after: [...after] }));
    const item = { title: clean(title), body: clean(body), lane: recipe.lane ?? 'full', size: recipe.size ?? 's', after: [], ...(steps ? { steps } : {}) };
    const stamp = this.#now().toISOString().replace(/[-:]|\.\d+Z$/g, '');
    const input = {
      goal: `recipe-${recipe.name}-${stamp}-${++this.#runs}`, title: item.title,
      summary: scheduled ? `The recipe ${recipe.name} of ${recipe.service}, run by schedule ${scheduled.schedule}.` : `The recipe ${recipe.name} of ${recipe.service}, run by ${by}.`,
      items: [item],
    };
    const plans = this.#deps.plans;
    const proposed = await plans.propose(applySensitivity(input, plans.store.services()));
    scheduled?.planned?.(proposed.plan);
    const approver = scheduled ? scheduled.createdBy : by;
    const line = scheduled
      ? `Schedule ${scheduled.schedule} ran the recipe ${recipe.name}: plan ${proposed.plan} ("${item.title}") is approved by ${approver}, who created the schedule, and its ticket starts with a budget of ${usd(scheduled.budgetUsd)}.`
      : `The owner (${by}) ran the recipe ${recipe.name}: plan ${proposed.plan} ("${item.title}") is approved by that gesture, and its ticket starts.`;
    await this.approve(proposed.plan, approver, line);
    return { accepted: true, plan: proposed.plan };
  }

  // A goal as an owner turn to the lead, by `by`: a goal recipe's, or a
  // goal schedule's own text. The lead's goal id is goal-<the message's seq>.
  async goal(text: string, by: UserId, scheduled?: ScheduledBy): Promise<RecipeRun> {
    const clean = this.#deps.clean(text);
    const message = await this.#deps.lead.post(scheduled ? this.#scheduledGoal(clean, scheduled) : clean, by, true);
    return { accepted: true, message: message.seq, goal: `goal-${message.seq}` };
  }

  // Approves a proposed plan for `by` with the service line `line`, as the
  // runner's own approval does: the plan's inbox item handled, the tick
  // that creates and starts the tickets, the line, the plan's frame.
  async approve(plan: string, by: UserId, line: string): Promise<void> {
    const plans = this.#deps.plans;
    if (!plans.store.move(plan, ['proposed'], 'approved', by)) throw new RecipeError('conflict', `plan ${plan} is ${plans.store.get(plan)?.state ?? 'gone'}: only a proposed plan is approved`);
    this.#deps.inbox.handle(`plan:${plan}`, by);
    await plans.tick();
    this.#deps.lead.serviceLine(line);
    this.#deps.lead.publishPlan(plans.plan(plan));
  }

  // A goal from a schedule, which the lead is told it plans for an absent owner.
  #scheduledGoal(text: string, scheduled: ScheduledBy): string {
    return `This goal comes from schedule ${scheduled.schedule}, created by ${scheduled.createdBy}: the plan you propose for it is approved on their behalf, and each of its tickets has a budget of ${usd(scheduled.budgetUsd)}.\n\n${text}`;
  }

  async #read(): Promise<readonly RecipeFile[]> {
    const { recipes, problems } = await this.#deps.source.list();
    for (const problem of problems) {
      const key = `${problem.service}:${problem.file}:${problem.message}`;
      if (this.#told.has(key)) continue;
      this.#told.add(key);
      console.error(`cleared-v2: a recipe is left out: ${problem.message.startsWith(problem.service) ? problem.message : `${problem.service}:${problem.file}: ${problem.message}`}`);
    }
    return recipes;
  }
}
