// The setup assistant's shapes (docs/v2/milestone-5-plan.md, section 3.1:
// each new module keeps its route types in its own types.ts), read by the
// service's setup module and by the app's setup screen.

// The steps of the proof's section 1, in order: one file each under
// src/setup/steps/, one screen under app/web/screens/setup/steps/ and one
// catalog pair app/messages/setup-<id>.{en,fr}.json (decision 9).
export const STEP_IDS = ['owner', 'forge', 'model', 'workspace', 'environment', 'secrets', 'checks', 'first-ticket'] as const;
export type StepId = (typeof STEP_IDS)[number];
export const isStepId = (value: string): value is StepId => (STEP_IDS as readonly string[]).includes(value);

export type StepState = 'todo' | 'done' | 'skipped';

// A step as GET /api/setup answers it: its state, whether its lane filled
// it, whether a person may skip it, and its record (records.ts).
export type StepView = {
  readonly id: StepId;
  readonly state: StepState;
  readonly filled: boolean;
  readonly skippable: boolean;
  readonly shownAt: string | null;
  readonly doneAt: string | null;
  readonly skippedAt: string | null;
  readonly personMs: number;
  readonly machineMs: number;
};

export type SetupView = {
  readonly steps: readonly StepView[];
  readonly owner: string | null;
  readonly current: StepId | null;                     // the first step neither done nor skipped; null: the end
  readonly total: { readonly personMs: number; readonly machineMs: number };
};

// A credential as a screen sees it: whether one is set, when the assistant
// set it, or that the environment gives it. Never its value.
export type CredentialView =
  | { readonly set: false }
  | { readonly set: true; readonly at: string | null; readonly source: 'assistant' | 'environment' };

// What a step's write refuses, as the screens say it (their catalogs).
export type SetupError = { readonly error: string };

// POST /setup/owner, the app's own (before anyone is signed in).
export type OwnerBody = { readonly code: string; readonly name: string; readonly password: string };
export type OwnerMade = { readonly name: string; readonly publicKey: string | null; readonly existed: boolean };   // publicKey null: the key could not be made (the app's log says why)
export type OwnerView = { readonly name: string | null; readonly publicKey: string | null; readonly setting: 'human_public_key' };

// One right of a fine-grained GitHub credential: GitHub's permission, the
// access it needs, and whether a feature off by default is all that needs it.
export type ForgeRight = { readonly permission: 'metadata' | 'contents' | 'pull_requests' | 'commit_statuses' | 'workflows' | 'issues'; readonly access: 'read' | 'write'; readonly optional: boolean };

// What a fine-grained credential needs, from what Cleared asks of GitHub:
// gh pr create, edit, view, comment and close (workspace/publish.ts,
// flow/effects.ts, flow/pr-close.ts), gh pr checks (approval/service.ts),
// git clone and push of the session's branch, and the lock's merge
// (merge-pr.ts: PUT /pulls/{n}/merge needs Contents, write). Metadata is
// GitHub's own minimum and lists the repositories. Names as GitHub's page
// "Permissions required for fine-grained personal access tokens" writes them.
export const FORGE_RIGHTS: readonly ForgeRight[] = [
  { permission: 'metadata', access: 'read', optional: false },
  { permission: 'contents', access: 'write', optional: false },
  { permission: 'pull_requests', access: 'write', optional: false },
  { permission: 'commit_statuses', access: 'read', optional: false },
  { permission: 'workflows', access: 'write', optional: true },      // only for a ticket that changes .github/workflows/
  { permission: 'issues', access: 'write', optional: true },         // only for the GitHub Issues mirror (P230)
];

// GitLab, the other forge (section 11): its token, and the address it is
// saved for (gitlab.com until one is saved).
export type GitLabView = { readonly credential: CredentialView; readonly address: string };

export type ForgeView = { readonly credential: CredentialView; readonly rights: readonly ForgeRight[]; readonly gitlab: GitLabView };
// POST /api/setup/forge { forge?: 'github' | 'gitlab', value, address? }.
export type ForgeChecked = { readonly forge: 'github' | 'gitlab'; readonly credential: CredentialView; readonly repositories: number; readonly more: boolean; readonly sample: readonly string[] };

export type ModelView = { readonly credential: CredentialView; readonly terminal: boolean };

// The first ticket (section 14): where it stands, from its state in the
// ticket store. todo: in Todo, the flow starting it; working: the author;
// review: the reviewer; approval: waiting for the owner in the inbox;
// merging: approved, the lock merges and the release watch runs; live: Done;
// stopped: another state (set aside, closed). plan: the author's session
// plan waits for the person's Go in the inbox (issue #446), drawn on the
// author's stage of the list, which then never moves back.
export const FIRST_TICKET_STAGES = ['todo', 'working', 'review', 'approval', 'merging', 'live'] as const;
export type FirstTicketStage = (typeof FIRST_TICKET_STAGES)[number] | 'plan' | 'stopped';

export type FirstTicket = {
  readonly id: string;
  readonly title: string;
  readonly service: string | null;
  readonly stage: FirstTicketStage;
  readonly createdAt: string;
  readonly rolledBack: boolean;                      // the release watch put it back in Todo after it was approved
  readonly plan?: string;                            // the session plan's inbox item while it waits for its Go
  readonly pullRequest?: { readonly number: number; readonly url: string };   // once the branch is published
};

// GET /api/setup/first-ticket?language= and POST { service, language }.
export type FirstTicketView = {
  readonly ready: boolean;                           // false: no workspace yet (the workspace step), no ticket can run
  readonly services: readonly string[];
  readonly proposal: { readonly title: string; readonly body: string };
  readonly ticket: FirstTicket | null;
};

// GET /api/setup/secrets/expected: the names of the test secrets each service's
// repository shows it needs, and where one was seen (secrets/expected.ts).
export type ExpectedSecrets = { readonly services: readonly { readonly service: string; readonly names: readonly { readonly name: string; readonly from: string }[] }[] };
