// The shapes of the test secrets' routes (docs/v2/milestone-5-plan.md,
// section 12, decision 12, C16), imported by the Services screen's panel
// and the assistant's secrets step; src/api/types.ts is not edited by
// milestone 5 (section 3.1).
//
//   GET  /api/test-values           every service's values, by name: TestValuesView
//   POST /api/test-values           one set or replaced: TestValueSaved
//   POST /api/test-values/remove    one removed: { removed: true }
// The app's routes, with its proof and the person's id. The assistant's step
// answers the same shapes under /api/setup/secrets, for the owner.
//
// A value is in a request body and nowhere else: no answer, error or log
// line ever carries one.

export const TEST_VALUES_PATH = '/api/test-values';

// A value is one line of 8 characters at least: the cleaner does not look for
// a shorter one (session/clean.ts), which would remove ordinary words.
export const TEST_VALUE_MIN = 8;
export const TEST_VALUE_MAX = 4096;
export const TEST_VALUES_PER_SERVICE = 50;

// What a write refuses, as the screens say it (test_values_error_<code>).
export const TEST_VALUE_REFUSALS = [
  'name', 'reserved', 'short', 'long', 'line', 'space', 'count', 'key',
  'service', 'not_found', 'no_workspace', 'invalid_workspace', 'body', 'empty',
] as const;
export type TestValueRefusal = (typeof TEST_VALUE_REFUSALS)[number];

// One test value as a person sees it: its name, when and by whom it was
// set, whether the key at hand opens it. Never the value.
export type TestValue = {
  readonly service: string;
  readonly name: string;
  readonly setAt: string;
  readonly setBy: string | null;                       // the person's name; null when the service no longer knows them
  readonly readable: boolean;                          // false: sealed under another key (the ledger was copied), set it again
};

// The key: made at the first value (none), at hand (ready), or there but
// refused (unusable: a link, readable by others, not 32 bytes).
export type TestValueKey = 'none' | 'ready' | 'unusable';

export type TestValuesView = {
  readonly workspace: boolean;
  readonly key: TestValueKey;
  // The workspace's services in its order, then any other service that still holds values (inWorkspace false).
  readonly services: readonly { readonly name: string; readonly inWorkspace: boolean; readonly values: readonly TestValue[] }[];
};

export type SetTestValueBody = { readonly service: string; readonly name: string; readonly value: string };
export type RemoveTestValueBody = { readonly service: string; readonly name: string };
export type TestValueSaved = { readonly value: TestValue; readonly replaced: boolean };
