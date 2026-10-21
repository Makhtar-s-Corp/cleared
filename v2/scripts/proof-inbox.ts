// Step 6 of the proof (scripts/proof-j1.ts): what the owner does with the
// inbox items of the ticket that wait. The request the message asked for may
// come after another request of the same session, which pauses it: the owner
// answers that one from the inbox too, then waits for the next.

// What installs or fetches something is denied; work in the checkout is allowed once.
export const OUTSIDE = /\b(apt-get|apk|sudo|pip3?|curl|wget|ssh|npx|embedded-postgres)\b|\bnpm (i|install|add|view)\b/;

export type InboxAction =
  | { readonly kind: 'target'; readonly index: number }
  | { readonly kind: 'other'; readonly index: number; readonly decision: 'allow_once' | 'reject_once' }
  | { readonly kind: 'wait' };

export function inboxAction(items: readonly { readonly detail: string }[], target: string): InboxAction {
  const index = items.findIndex((item) => item.detail.includes(target));
  if (index >= 0) return { kind: 'target', index };
  if (items.length === 0) return { kind: 'wait' };
  return { kind: 'other', index: 0, decision: OUTSIDE.test((items[0] as { detail: string }).detail) ? 'reject_once' : 'allow_once' };
}
