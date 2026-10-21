// The SDK hooks of the session runner (milestone 1 plan, decision 13).
// Empty here: lane 5 fills it with Cleared's three rules (no push to the
// base branch, the guard before anything leaves, HANDOVER.md at the end),
// and lane 4's runner (main.ts) spreads it into the `hooks` option of
// query() without editing this file.
//
// The types mirror the shapes of @anthropic-ai/claude-agent-sdk 0.3.306
// (sdk.d.ts: HookCallback, HookCallbackMatcher, HookEvent) without importing
// the package, which only the image installs.

export type HookCallback = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

export type HookCallbackMatcher = {
  matcher?: string;
  hooks: HookCallback[];
  // Seconds, for every hook of this matcher.
  timeout?: number;
};

export type Hooks = Partial<Record<string, HookCallbackMatcher[]>>;

export const hooks: Hooks = {};
