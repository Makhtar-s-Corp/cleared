// What the release card says of a change besides its pull requests
// (docs/v2/milestone-2-plan.md, decision 23): the author's groups by intent,
// and the flags the diff raises. The publish step calls flags() once per
// ticket, with the diff of every pull request it published and the report
// the author left as its last `cleared.changes` journal event, and puts the
// result on the release item. Lane 16 places the call with this empty
// default; lane 18 fills the function and nothing else of the flow.
import type { ChangesReport, ReleaseFlag, ReleaseGroup } from '../api/types.ts';
import type { SessionEvent } from '../session/events.ts';

// The journal event `report_changes` writes (decision 22's tool, lane 17).
export const CHANGES_EVENT = 'cleared.changes';

export type FlagsInput = {
  readonly diff: string;                         // unified diffs, one after the other, as git diff prints them
  readonly report?: ChangesReport;               // absent: the author reported nothing
};

export type FlagsResult = { readonly groups: readonly ReleaseGroup[]; readonly flags: readonly ReleaseFlag[] };

export function flags(_input: FlagsInput): FlagsResult {
  return { groups: [], flags: [] };
}

// The report of the session's last `cleared.changes` event, by that name.
// One whose value is not a list of groups of an intent and its files reads
// as no report: the tool that writes it validates it (lane 17).
export function changesReport(events: readonly SessionEvent[]): ChangesReport | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event as { readonly type: string; readonly name?: string; readonly value?: unknown } | undefined;
    if (event?.type !== 'CUSTOM' || event.name !== CHANGES_EVENT) continue;
    const groups = (event.value as { groups?: unknown } | null | undefined)?.groups;
    if (!Array.isArray(groups)) return undefined;
    const out: { intent: string; files: string[] }[] = [];
    for (const group of groups as { intent?: unknown; files?: unknown }[]) {
      if (typeof group?.intent !== 'string' || !Array.isArray(group.files) || !group.files.every((file) => typeof file === 'string')) return undefined;
      out.push({ intent: group.intent, files: [...group.files as string[]] });
    }
    return { groups: out };
  }
  return undefined;
}
