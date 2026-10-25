// What a step is, and what its routes are given (docs/v2/milestone-5-plan.md,
// decision 9): the shape every file of steps/ exports, apart from the
// registry (steps.ts), which imports them all.
import type { DatabaseSync } from 'node:sqlite';
import type { Route, RouteContext, User } from '../modules/registry.ts';
import type { SessionContainer } from '../terminal/container.ts';
import type { SetupRecords } from './records.ts';
import type { StepId } from './types.ts';

// What a step's routes are given by the setup module.
export type StepDeps = {
  readonly db: DatabaseSync;
  readonly env: NodeJS.ProcessEnv;
  readonly records: SetupRecords;
  readonly fromEnvironment: ReadonlySet<string>;   // what the environment set at start: never replaced from the browser
  readonly fetch: typeof fetch;
  readonly container: SessionContainer;            // the model step's throwaway containers
  readonly now: () => Date;
  // The proof, a known user, and the owner: what every setup route asks
  // first (an HttpError otherwise, which `guarded` answers).
  owner(context: RouteContext): Promise<User>;
  // What a step started, ended with the service (a terminal).
  onStop(stop: () => Promise<void>): void;
};

export type SetupStep = {
  readonly id: StepId;
  readonly filled: boolean;                        // false: a stub, its lane fills it later
  readonly skippable: boolean;
  readonly tables?: readonly string[];
  readonly routes?: (deps: StepDeps) => Route[];
  readonly done?: (deps: StepDeps) => boolean;     // done whatever its record says (the owner, once a user exists)
};

// A step a later lane fills: a person may skip it, it has no route.
export const stub = (id: StepId): SetupStep => ({ id, filled: false, skippable: true });

