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
  readonly install: string | null;                              // [session] install_command, as written
  readonly state: PreparedState;
  readonly image: string | null;                                // the ready image's tag
  readonly builtAt: string | null;
  readonly buildMs: number | null;
  readonly startedAt: string | null;                            // of the build running
  readonly error: string | null;                                // the failed build's first line
};

// GET /api/setup/environment, and POST /api/setup/environment/build (202).
export type EnvironmentView = { readonly workspace: boolean; readonly services: readonly EnvironmentService[] };
