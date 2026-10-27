// The environment step's answer (docs/v2/milestone-5-plan.md, section 3.1:
// each new module keeps its route types in its own types.ts), read by the
// service's environment step and by the app's setup screen.

// A service's prepared image: none yet, a build running, ready for what its
// base holds now, stale (built for an older base: the next build makes the
// new one), or its last build failed.
export type PreparedState = 'none' | 'building' | 'ready' | 'stale' | 'failed';

export type EnvironmentService = {
  readonly name: string;
  readonly readable: boolean;                                   // false: its base is not fetched yet
  readonly devcontainer: 'none' | 'image' | 'dockerfile' | null;
  // The image its .devcontainer names when it is not Cleared's session
  // image: a session needs Node 24, Claude Code and Cleared's runner in it.
  readonly foreignImage: string | null;
  readonly install: string | null;                              // [session] install_command, as written
  readonly state: PreparedState;
  readonly image: string | null;                                // the ready image's tag
  readonly builtAt: string | null;
  readonly buildMs: number | null;
  readonly startedAt: string | null;                            // of the build running
  readonly error: string | null;                                // the failed build's first line
  // The service's declared check, as its base declares it; null: none.
  readonly checkCommand: string | null;
  // The check run in the ready image by the last Build (flow/env-setup.ts
  // checkPrepared); null when none ran on this image.
  readonly check: EnvironmentCheck | null;
  // Why a setup session is proposed (C4), or null: no .devcontainer, the
  // image did not build, or the check failed in it.
  readonly proposal: 'no_devcontainer' | 'build_failed' | 'check_failed' | null;
  readonly setupTicket: string | null;                          // the open setup session's ticket, when there is one
};

export type EnvironmentCheck = { readonly command: string; readonly passed: boolean; readonly at: string; readonly ms: number; readonly tail: string };

// GET /api/setup/environment, and POST /api/setup/environment/build (202).
// `sessions`: whether a setup session can start from here, the flow running
// with this workspace; `no_flow` when it does not run, `restart` when it
// runs on a workspace read before this one was connected (issue #420).
export type EnvironmentView = { readonly workspace: boolean; readonly services: readonly EnvironmentService[]; readonly sessions: 'ready' | 'no_flow' | 'restart' };

// POST /api/setup/environment/session: a setup session for `service`, its
// ticket's title and description in the person's language (the template's).
export type SetupSessionBody = { readonly service: string; readonly title: string; readonly body: string };
export type SetupSessionAnswer = { readonly ticket: string; readonly created: boolean };
