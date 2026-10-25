// The API access panel's model (docs/v2/milestone-5-plan.md, section 8,
// C18): what the panel shows of the person's tokens, and the name a new
// one may take. No React here, so the node tests read it.
import type { ApiToken, MadeApiToken } from '../../../src/run/types.ts';
import type { Translate } from '../lib/i18n.ts';
import { ago } from '../lib/time.ts';

// As the service checks them (src/run/tokens.ts).
export const ACCESS_NAME_MAX = 60;
export const ACCESS_PER_PERSON = 20;

// The command the panel shows once a token is made; the person writes their own task.
export const ACCESS_COMMAND = 'cleared run "Show the newest entry first" --wait';

export type AccessProblem = 'empty' | 'long' | 'many';
export type AccessFailure = { readonly kind: 'read' | 'make' } | { readonly kind: 'revoke'; readonly name: string };

export type AccessView = {
  readonly rows: readonly ApiToken[] | null;            // null until the list is read
  readonly fresh: MadeApiToken | null;                   // the token just made, its value shown this once
  readonly name: string;
  readonly problem: AccessProblem | null;
  readonly failed: AccessFailure | null;
  readonly busy: boolean;
  readonly said: string;                                 // the panel's polite line: copied, revoked
};

export const initialAccess: AccessView = { rows: null, fresh: null, name: '', problem: null, failed: null, busy: false, said: '' };

export function accessNameProblem(name: string): 'empty' | 'long' | null {
  const trimmed = name.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return 'empty';
  return trimmed.length > ACCESS_NAME_MAX ? 'long' : null;
}

// "25 October", "25 octobre": the day, in the catalog's language.
const day = (iso: string, t: Translate): string =>
  new Intl.DateTimeFormat(t('locale') === 'fr' ? 'fr' : 'en-GB', { day: 'numeric', month: 'long' }).format(new Date(iso));

export type AccessRow = { readonly id: string; readonly name: string; readonly made: string; readonly used: string };

export function accessRows(tokens: readonly ApiToken[], now: Date, t: Translate): AccessRow[] {
  return tokens.map((token) => ({
    id: token.id, name: token.name,
    made: t('access_made_on', { date: day(token.createdAt, t) }),
    used: token.lastUsedAt ? t('access_used', { when: ago(token.lastUsedAt, now, t) }) : t('access_unused'),
  }));
}
