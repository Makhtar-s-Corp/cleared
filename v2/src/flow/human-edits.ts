// The files a human changed in a session's checkout (docs/v2/milestone-2-plan.md,
// decision 33): through the Editor tab's save, or found at Give back after
// the web terminal, each journaled as `cleared.human_edit`. The reviewer's
// prompt names them (flow/prompts.ts reviewPrompt, called by the engine's
// review start); lane 23 placed the call, lane 31 fills it: the session's
// `cleared.human_edit` events, merged per path in the order they came.
import type { HumanEdit } from '../api/types.ts';
import type { UserId } from '../session/contract.ts';
import type { SessionEvent } from '../session/events.ts';

// One line per path: the counts added up, the hash before the first edit
// and after the last, and who, when and how of the last.
export function humanEdits(input: { readonly events: readonly SessionEvent[] }): readonly HumanEdit[] {
  const out = new Map<string, HumanEdit>();
  for (const { at, event } of input.events) {
    if (event.type !== 'CUSTOM' || event.name !== 'cleared.human_edit') continue;
    const edit = event.value;
    const seen = out.get(edit.path);
    out.set(edit.path, seen
      ? { ...edit, at, added: seen.added + edit.added, removed: seen.removed + edit.removed, before: seen.before }
      : { ...edit, at });
  }
  return [...out.values()];
}

// What the session is told of a human's changes: at once for a save while
// it is live, in one notice at Give back for what was changed while it was
// taken over.
export function humanEditNotice(user: string, edits: readonly Pick<HumanEdit, 'path' | 'added' | 'removed'>[]): string {
  const files = edits.map((edit) => `${edit.path} (+${edit.added}, -${edit.removed})`).join(', ');
  return `${user} changed these files: ${files}. Read them again before editing them.`;
}

// The name the notice gives a user: its name in the users table, else its id.
export async function userName(users: { get(id: UserId): Promise<{ readonly name: string } | undefined> }, id: UserId): Promise<string> {
  return (await users.get(id).catch(() => undefined))?.name ?? id;
}
