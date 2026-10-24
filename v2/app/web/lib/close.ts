// Close (issue #249): a ticket that should never ship is closed with a
// reason, from its release card in the inbox or from its page. The card
// leaves the tower and stays in the history; nothing is merged. Shared by
// both screens, which draw the reason's field and keep the words in their
// own catalogs.
import type { ScreenContext } from './screen.ts';

// The longest reason the route accepts (CLOSE_REASON_MAX in src/flow/engine.ts, which the browser cannot import at run time).
export const CLOSE_REASON_MAX = 2000;

// What a Close says, as the route accepts it: some text, at most CLOSE_REASON_MAX characters.
export function closeReason(text: string): { readonly reason: string } | { readonly error: 'close_empty' | 'close_long' } {
  const reason = text.trim();
  if (reason === '') return { error: 'close_empty' };
  return reason.length > CLOSE_REASON_MAX ? { error: 'close_long' } : { reason };
}

export type Closed = { readonly kind: 'closed'; readonly at: string };

export async function closeTicket(api: ScreenContext['api'], ticket: string, text: string, now: Date): Promise<Closed> {
  const checked = closeReason(text);
  if ('error' in checked) throw new Error(checked.error);
  await api(`/tickets/${encodeURIComponent(ticket)}/close`, { method: 'POST', body: { reason: checked.reason } });
  return { kind: 'closed', at: now.toISOString() };
}

// How a refusal of the Close reads: 404 or 409, the ticket is done, approved, landing or gone; 400, the service refused the reason.
export const closeFailureKey = (status: number): 'close_conflict' | 'close_invalid' | 'close_failed' =>
  status === 404 || status === 409 ? 'close_conflict' : status === 400 ? 'close_invalid' : 'close_failed';
