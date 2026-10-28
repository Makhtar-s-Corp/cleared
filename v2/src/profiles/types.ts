// The agent profile and its environment (issue #452, matrix B5.1c, P213,
// B5.4a, B5.4e, B5.4g, B5.5a, B5.5b): two objects, each a list of versions
// that are never changed. A session names the version of each it started
// on. Imported by the service's routes and the Services screen's panel.
//
//   GET  /api/profiles                        both histories: ProfilesView
//   POST /api/profiles/agent                  a new version of the profile: VersionView<AgentProfile>
//   POST /api/profiles/agent/restore          { version }: a new version that copies that one
//   POST /api/profiles/environment            a new version of the environment
//   POST /api/profiles/environment/restore    { version }
//
// No secret is ever in either: the harness's login stays mounted from the
// service (B5.4e), and a value that looks like one is refused.

export const PROFILES_PATH = '/api/profiles';

// Claude Code, or the harness pick (P213) on the harnesses the owner
// enabled. Codex and Cursor are reached through `auto` only: P87 keeps every
// engine's own harness on Claude Code until the owner's trials.
export const PROFILE_HARNESSES = ['claude-code', 'auto'] as const;
export type ProfileHarness = (typeof PROFILE_HARNESSES)[number];

export type AgentProfile = {
  readonly harness: ProfileHarness;
  // null: the service's model and its rules (CLEARED_V2_AUTHOR_MODEL and
  // CLEARED_V2_REVIEWER_MODEL, the Quick label, the Consumption screen's
  // choice, a service's reviewer sensitivity).
  readonly authorModel: string | null;
  readonly reviewerModel: string | null;
  // Added after the first prompt of each author or reviewer session; '' for none.
  readonly rolePrompts: { readonly author: string; readonly reviewer: string };
  // Commands an author or a reviewer runs without asking, added to Cleared's
  // and the project's (the policy's safe commands): each names its command.
  readonly allowedTools: readonly string[];
  // What a session has today, and the only value accepted: no MCP server
  // beyond Cleared's own, and the project's skills mounted as they are (B5.5b).
  readonly mcpServers: readonly never[];
  readonly skills: 'project';
};

// `project`: the model API, the npm registry, the project's declared hosts
// and these; `model-only`: the model API and the npm registry alone. Either
// goes through the session's egress proxy (B5.4a).
export const NETWORKS = ['project', 'model-only'] as const;
export type Network = (typeof NETWORKS)[number];

export type AgentEnvironment = {
  readonly image: string | null;             // null: the service's prepared image, else Cleared's session image
  readonly network: Network;
  readonly allowedHosts: readonly string[];
  readonly cpus: string | null;              // null: Cleared's limits (B5.4g)
  readonly memory: string | null;
};

export const DEFAULT_PROFILE: AgentProfile = {
  harness: 'claude-code', authorModel: null, reviewerModel: null, rolePrompts: { author: '', reviewer: '' },
  allowedTools: [], mcpServers: [], skills: 'project',
};

export const DEFAULT_ENVIRONMENT: AgentEnvironment = { image: null, network: 'project', allowedHosts: [], cpus: null, memory: null };

export type VersionView<T> = {
  readonly version: number;
  readonly body: T;
  readonly createdAt: string | null;         // null for the service's first version: the service as it always ran
  readonly createdBy: string | null;         // the person's name; null for the service's first version, or a person it no longer knows
  readonly restoredFrom: number | null;
};

export type ProfilesView = {
  readonly profile: { readonly current: number; readonly versions: readonly VersionView<AgentProfile>[] };
  readonly environment: { readonly current: number; readonly versions: readonly VersionView<AgentEnvironment>[] };
};

// The versions a session started on (an author's or a reviewer's; the lead
// and a reader have no profile). `auto`: its profile asked for the harness pick.
export type SessionVersions = { readonly profile: number; readonly environment: number; readonly auto: boolean };

// What a write refuses, as the screens say it (profiles_error_<code>). No
// refusal carries the value it refused.
export const PROFILE_REFUSALS = [
  'body', 'harness', 'model', 'same_models', 'prompt', 'tools', 'mcp', 'skills', 'sensitive',
  'image', 'network', 'hosts', 'cpus', 'memory', 'version', 'unchanged',
] as const;
export type ProfileRefusal = (typeof PROFILE_REFUSALS)[number];
