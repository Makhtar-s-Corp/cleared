// The assistant's steps, registered (docs/v2/milestone-5-plan.md, decision
// 9): one file per step under steps/, in the order of the proof's section 1.
// A step declares whether its lane filled it, whether a person may skip it,
// its own tables and its own routes under /api/setup/<its id>, and, when its
// state is not only its record, when it is done. A lane fills its step's
// file and never edits this registry or another step.
import checks from './steps/checks.ts';
import environment from './steps/environment.ts';
import firstTicket from './steps/first-ticket.ts';
import forge from './steps/forge.ts';
import model from './steps/model.ts';
import owner from './steps/owner.ts';
import secrets from './steps/secrets.ts';
import workspace from './steps/workspace.ts';
import type { SetupStep } from './step.ts';

export type { SetupStep, StepDeps } from './step.ts';

export const STEPS: readonly SetupStep[] = [owner, forge, model, workspace, environment, secrets, checks, firstTicket];
