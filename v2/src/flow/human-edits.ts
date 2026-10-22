// The files a human changed in a session's checkout (docs/v2/milestone-2-plan.md,
// decision 33): through the Editor tab's save, or found at Give back after
// the web terminal, each journaled as `cleared.human_edit`. The reviewer's
// prompt names them (flow/prompts.ts reviewPrompt, called by the engine's
// review start). Lane 23 places the call with this empty default; lane 31
// fills it from the session's `cleared.human_edit` events, merged per path.
import type { HumanEdit } from '../api/types.ts';
import type { SessionEvent } from '../session/events.ts';

export function humanEdits(_input: { readonly events: readonly SessionEvent[] }): readonly HumanEdit[] {
  return [];
}
