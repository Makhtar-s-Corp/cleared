// The shapes of the assistant's workspace step (docs/v2/milestone-5-plan.md,
// section 9, decision 15), read by the service's step and by the app's
// screen: the repositories the forge credential reaches, what connect.ts
// proposes once they are cloned, and what the person ticks.

// A repository the person may pick: the forge's list, archived ones left out.
export type RepositoryChoice = { readonly repo: string; readonly private: boolean };

// Why the list is empty: no forge credential yet, or the forge did not answer.
export type ListProblem = 'no_forge' | 'unreachable';

export type ConnectedService = { readonly name: string; readonly repo: string; readonly path: string | null };

export type WorkspaceView = {
  readonly repositories: readonly RepositoryChoice[];
  readonly archived: number;                                 // archived repositories, not listed
  readonly problem: ListProblem | null;
  // What the assistant wrote last, when the settings name its file.
  readonly connected: { readonly services: readonly ConnectedService[]; readonly at: string | null } | null;
  // environment: CLEARED_V2_WORKSPACE comes from Cleared's environment, which the browser never replaces.
  readonly source: 'assistant' | 'environment' | null;
};

// A contract line proposed from a file under a known name, its path inside the service.
export type ContractLine = { readonly format: 'openapi' | 'events'; readonly path: string };

export type ProposedService = {
  readonly name: string;                                     // the [service <name>] it would be
  readonly repo: string;
  readonly kind: 'repository' | 'folder';
  readonly path: string | null;                              // a folder of a monorepo
  readonly contract: ContractLine | null;
};

// A picked repository: one service, or its folders when it is a monorepo.
export type ProposedRepository = {
  readonly repo: string;
  readonly layout: 'whole' | 'folders';
  readonly folders: readonly string[];                       // folders that could be services; none: not a monorepo
  readonly from: 'workspaces' | 'manifests' | null;          // its package.json workspaces, or top folders with a manifest of their own
};

export type Place = { readonly file: string; readonly line: number };

// A proposed consumes line: `from` calls `to`'s routes, at these places of from's code.
export type ProposedLink = { readonly id: string; readonly from: string; readonly to: string; readonly items: readonly string[]; readonly places: readonly Place[] };

export type WorkspaceProposal = {
  readonly repositories: readonly ProposedRepository[];
  readonly services: readonly ProposedService[];
  readonly links: readonly ProposedLink[];
  readonly machineMs: number;                                // the clone and the read
};

// POST /api/setup/workspace/propose: the picked repositories, and those kept whole although they have folders.
export type ProposeBody = { readonly repositories: readonly string[]; readonly whole?: readonly string[] };

// POST /api/setup/workspace: the same picks, and what the person ticked of the proposal.
export type ConfirmBody = ProposeBody & {
  readonly services: readonly string[];                      // names of the proposal's services
  readonly links: readonly string[];                         // ids of its links
  readonly contracts: readonly string[];                     // names of the services whose contract line is ticked
};

export type WorkspaceWritten = { readonly services: readonly ConnectedService[]; readonly links: number; readonly contracts: number };
