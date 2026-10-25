// What a tracker gives the mirror (tickets/mirror.ts): its issues changed
// since a time, each with its state in the app's names and who made each
// change of state, title or description; its comments since a time; and the
// four writes the mirror makes on it. GitHub Issues (mirror-github.ts) and
// Linear (mirror-linear.ts) implement it.

// A change of an issue's state, as the tracker recorded it: by the mirror's
// own account, by a person, or by an agent (a bot, an integration, or an
// actor the tracker does not name).
export type TrackerChange = {
  readonly status: string;
  readonly actor: 'mirror' | 'person' | 'agent';
  readonly who: string;
  readonly at: string;
};

// A change of an issue's title or description (P237), when the tracker
// names who made it; GitHub names no one for a description.
export type TrackerEdit = {
  readonly field: 'title' | 'body';
  readonly actor: TrackerChange['actor'];
  readonly who: string;
  readonly at: string;
};

// A comment on an issue, read by its own time: a comment does not always
// change its issue's.
export type TrackerComment = {
  readonly id: string;
  readonly issue: string;                         // the issue's id, as TrackerIssue.id
  readonly body: string;
  readonly actor: TrackerChange['actor'];
  readonly who: string;
  readonly at: string;                            // its creation
};

export type TrackerIssue = {
  readonly id: string;                            // what the tracker's API names it by
  readonly key: string;                           // what a person reads: 'ENG-12', 'owner/name#12'
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];             // without the state's own labels
  readonly status: string | null;                 // one of the app's six states, or null for a state the app does not have
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly changes: readonly TrackerChange[];     // oldest first
  readonly edits: readonly TrackerEdit[];         // oldest first
};

export interface Tracker {
  readonly name: string;                          // 'github:owner/name', 'linear:ENG': the mirror's tables key on it
  readonly title: string;                         // 'GitHub', 'Linear': what a person reads
  readonly service?: string;                      // a repository's tracker holds that service's tickets only
  changed(since: string): Promise<TrackerIssue[]>;
  create(input: { readonly title: string; readonly body: string; readonly labels: readonly string[]; readonly status: string }): Promise<TrackerIssue>;
  move(id: string, status: string): Promise<void>;
  edit(id: string, fields: { readonly title?: string; readonly body?: string }): Promise<void>;
  comment(id: string, body: string): Promise<string>;           // the comment's id
  commentsSince(since: string): Promise<TrackerComment[]>;    // updated since, oldest first
}

// A tracker's refusal or its silence. The message names the request, never
// the token or what the request carried.
export class TrackerError extends Error {
  override name = 'TrackerError';
}

// A tracker's answer within this time, or the pass on that tracker ends.
export const TRACKER_TIMEOUT_MS = 30_000;

export async function trackerFetch(fetcher: typeof fetch, what: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(TRACKER_TIMEOUT_MS) });
  } catch (error) {
    throw new TrackerError(`${what} could not be reached (${error instanceof Error ? error.name : typeof error})`);
  }
}
