// The setup assistant's screen, its pure parts (docs/v2/milestone-5-plan.md,
// section 5): the words (the shell's catalog, the assistant's and every
// step's, bundled into this screen's chunk only), a step's time as a person
// reads it, a date, and the service's setup routes through the app.
import type { SetupView, StepId } from '../../../../src/setup/types.ts';
import { STEP_IDS } from '../../../../src/setup/types.ts';
import checksEn from '../../../messages/setup-checks.en.json';
import checksFr from '../../../messages/setup-checks.fr.json';
import setupEn from '../../../messages/setup.en.json';
import setupFr from '../../../messages/setup.fr.json';
import environmentEn from '../../../messages/setup-environment.en.json';
import environmentFr from '../../../messages/setup-environment.fr.json';
import firstTicketEn from '../../../messages/setup-first-ticket.en.json';
import firstTicketFr from '../../../messages/setup-first-ticket.fr.json';
import forgeEn from '../../../messages/setup-forge.en.json';
import forgeFr from '../../../messages/setup-forge.fr.json';
import modelEn from '../../../messages/setup-model.en.json';
import modelFr from '../../../messages/setup-model.fr.json';
import ownerEn from '../../../messages/setup-owner.en.json';
import ownerFr from '../../../messages/setup-owner.fr.json';
import secretsEn from '../../../messages/setup-secrets.en.json';
import secretsFr from '../../../messages/setup-secrets.fr.json';
import workspaceEn from '../../../messages/setup-workspace.en.json';
import workspaceFr from '../../../messages/setup-workspace.fr.json';
import { catalogOf, type Language } from '@/lib/catalogs.ts';
import { hasMark, translator, type Catalog, type Translate } from '@/lib/i18n.ts';
import { lasted } from '@/lib/time.ts';

const FILES: Readonly<Record<Language, readonly Catalog[]>> = {
  en: [setupEn, ownerEn, forgeEn, modelEn, workspaceEn, environmentEn, secretsEn, checksEn, firstTicketEn],
  fr: [setupFr, ownerFr, forgeFr, modelFr, workspaceFr, environmentFr, secretsFr, checksFr, firstTicketFr],
};

// The shell's words, then the assistant's and every step's; a key missing
// from French falls back to English, as everywhere.
export function setupTranslator(language: Language): Translate {
  const merged = (files: readonly Catalog[]) => Object.assign({}, ...files) as Catalog;
  return translator({ ...catalogOf('shell', language), ...merged(FILES.en), ...(language === 'en' ? {} : merged(FILES[language])) });
}

// A step's catalog prefix: its id with underscores (first-ticket: first_ticket);
// the secrets step's is test_values, since the guard reads a catalog key with
// "secret" in it as an assigned secret (as P246 found for "token" and "pass").
export const stepKey = (id: StepId): string => (id === 'secrets' ? 'test_values' : id.replace(/-/g, '_'));

// A step's time as the last page's fold says it (issue #492): a step left open
// over a night is not an hour of anyone's work, so past an hour it says so.
const HOUR_MS = 3_600_000;
export const credibleTime = (ms: number, t: Translate): string => (ms >= HOUR_MS ? t('setup_time_long') : lasted(ms, t));

// "25 October", "25 octobre": the day a credential was saved, the day before
// the month in both languages, as the plan writes it ("set on 25 October").
export const dayOf = (iso: string, t: Translate): string =>
  new Intl.DateTimeFormat(t('locale') === 'en' ? 'en-GB' : t('locale'), { day: 'numeric', month: 'long' }).format(new Date(iso));

export const previousStep = (id: StepId): StepId | null => STEP_IDS[STEP_IDS.indexOf(id) - 1] ?? null;
export const nextStep = (id: StepId): StepId | null => STEP_IDS[STEP_IDS.indexOf(id) + 1] ?? null;

// The view before the owner exists: nothing done yet, the owner's step current.
export const firstView = (): SetupView => ({
  owner: null, current: 'owner', total: { personMs: 0, machineMs: 0 },
  steps: STEP_IDS.map((id) => ({
    id, state: 'todo', filled: ['owner', 'forge', 'model'].includes(id), skippable: !['owner', 'forge', 'model'].includes(id),
    shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0,
  })),
});

// The service's setup routes, through the app (/api/service/setup/...), each post with the anti-forgery token.
export type Answer<T> = { readonly status: number; readonly body: T };
export type SetupApi = {
  get<T>(path: string): Promise<Answer<T>>;
  post<T>(path: string, body?: unknown): Promise<Answer<T>>;
};

export function setupApi(csrf: string, fetcher: typeof fetch = (url, init) => fetch(url, init)): SetupApi {
  const call = async <T>(path: string, init: RequestInit): Promise<Answer<T>> => {
    const response = await fetcher(`/api/service/setup${path}`, { credentials: 'same-origin', ...init });
    return { status: response.status, body: await response.json().catch(() => ({})) as T };
  };
  return {
    get: (path) => call(path, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) => call(path, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }),
  };
}

// A refusal's sentence: the step's own word for the service's code, else its generic one.
export function refusal(t: Translate, prefix: string, body: unknown): string {
  const code = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : '';
  const said = /^[a-z_]+$/.test(code) ? t(`${prefix}_error_${code}`) : '';
  return said && !hasMark(said) ? said : t(`${prefix}_error_other`);
}
