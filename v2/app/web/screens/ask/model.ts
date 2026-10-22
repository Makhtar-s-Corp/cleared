// A question to the code (decision 28, lane 25's reader): the /ask/:id
// screen shows the question and what it is about (a service, a file and a
// line, or the whole platform), each turn with its answer and its cost, the
// sum with the week share once measured, and a follow-up field. The model
// and the wording are pure, so the tests run them under Node; Ask.tsx draws
// the screen and polls the ask while a turn runs.
//
// The tower's bar asks (askBody, startAsk) and opens this screen. Every
// call goes through the app's forwarding with the signed-in user; the
// reader's own checks (MAX_QUESTION, a target's service, three asks at once)
// stay the service's, and the screen checks the length before it sends.
import type { Ask, AskAnswer, AskBody } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';

// The longest question the reader takes (MAX_QUESTION of
// src/reader/service.ts, which the browser cannot import; a test keeps the two equal).
export const QUESTION_MAX = 4000;
// How often the screen reads an ask while its turn runs.
export const POLL_MS = 2000;

type Api = ScreenContext['api'];
type Language = 'en' | 'fr';

export const askPath = (id: string) => `/asks/${encodeURIComponent(id)}`;
export const askHref = (id: string) => `/ask/${encodeURIComponent(id)}`;

// The ask an address names: /ask/<id>.
export function askIdOf(path: string): string | undefined {
  const raw = /^\/ask\/([^/]+)$/.exec(path)?.[1];
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

export const running = (ask: Pick<Ask, 'state'>) => ask.state === 'starting' || ask.state === 'running';

// The screen reads the ask again while a turn runs, and stops once it ended.
export const pollDelay = (ask: Pick<Ask, 'state'>): number | null => (running(ask) ? POLL_MS : null);

// ------------------------------------------------------------------ words

export function targetLine(ask: Pick<Ask, 'service' | 'target'>, t: Translate): string {
  if (ask.target) return t('ask_target', { service: ask.target.service, path: ask.target.path, line: ask.target.line });
  return ask.service ?? t('ask_platform');
}

export function stateLine(ask: Pick<Ask, 'state'>, t: Translate): string {
  return t(`ask_state_${ask.state}`);
}

// A turn: answered, still waiting for its answer, or lost (its reader
// stopped or failed before it answered).
export type TurnView = { readonly turn: AskAnswer; readonly kind: 'answered' | 'waiting' | 'lost' };

export function turnsOf(ask: Pick<Ask, 'turns' | 'state'>): TurnView[] {
  return ask.turns.map((turn) => ({ turn, kind: turn.answer !== null ? 'answered' : running(ask) ? 'waiting' : 'lost' }));
}

const decimals = (value: number, digits: number, language: Language) =>
  new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);
const count = (value: number, language: Language) => new Intl.NumberFormat(language).format(value);

// A reader's turn costs a fraction of a cent: under a cent it reads to the
// hundredth of a cent, else in cents.
export const money = (usd: number, language: Language, t: Translate) => t('ask_cost', { amount: decimals(usd, usd < 0.01 ? 4 : 2, language) });

// "$0.0023 · 38,064 tokens in, 1,017 out", once the turn has its cost.
export function usageLine(usage: Pick<AskAnswer, 'costUsd' | 'inputTokens' | 'outputTokens'>, language: Language, t: Translate): string | undefined {
  if (usage.costUsd === null) return undefined;
  return t('ask_usage', { cost: money(usage.costUsd, language, t), input: count(usage.inputTokens, language), output: count(usage.outputTokens, language) });
}

// The ask's sum, and the week as its reader last saw it, once measured.
export function totalLine(ask: Pick<Ask, 'costUsd' | 'inputTokens' | 'outputTokens' | 'weekPercent' | 'turns'>, language: Language, t: Translate): string | undefined {
  if (!ask.turns.some((turn) => turn.costUsd !== null)) return undefined;
  const usage = usageLine(ask, language, t) as string;
  return ask.weekPercent === null ? usage : `${usage} · ${t('ask_week', { n: Math.round(ask.weekPercent) })}`;
}

// -------------------------------------------------------------- questions

export function questionProblem(text: string): 'empty' | 'too_long' | undefined {
  const question = text.trim();
  if (!question) return 'empty';
  return question.length > QUESTION_MAX ? 'too_long' : undefined;
}

// A `service:path:line` the question names. A service of the workspace
// only, when the workspace is known; else the service checks it.
const TARGET = /(?:^|[\s(])([A-Za-z0-9][A-Za-z0-9._-]*):([^\s:]+):(\d+)(?=$|[\s,.;?!)])/g;

export function targetIn(text: string, services: readonly string[]): string | undefined {
  for (const match of text.matchAll(TARGET)) {
    const [, service, path, line] = match as unknown as [string, string, string, string];
    if (/^\d+$/.test(service) || /^\d+$/.test(path)) continue;          // a time, 10:30:15, is no target
    if (services.length === 0 || services.includes(service)) return `${service}:${path}:${line}`;
  }
  return undefined;
}

// What the tower's bar sends: the question; its target when it names one;
// else the one service picked; else nothing, a question to every service.
export function askBody(text: string, services: readonly string[], picked: readonly string[]): AskBody {
  const question = text.trim();
  const target = targetIn(question, services);
  if (target) return { question, target };
  return picked.length === 1 ? { question, service: picked[0] as string } : { question };
}

// --------------------------------------------------------------- gestures

export async function startAsk(api: Api, body: AskBody): Promise<Ask> {
  return await api<Ask>('/asks', { method: 'POST', body });
}

export async function readAsk(api: Api, id: string): Promise<Ask> {
  return await api<Ask>(askPath(id));
}

// A follow-up the screen refuses never reaches the service.
export async function followAsk(api: Api, id: string, text: string): Promise<Ask> {
  const problem = questionProblem(text);
  if (problem) throw new Error(problem === 'empty' ? 'ask_question_empty' : 'ask_question_long');
  return await api<Ask>(`${askPath(id)}/follow`, { method: 'POST', body: { question: text.trim() } });
}

// How a refusal of the reader's routes reads (src/reader/routes.ts): 409 is
// three asks at once for a new one, a turn that runs for a follow-up.
export function askFailure(error: unknown, gesture: 'ask' | 'follow' | 'read'): string {
  if (!(error instanceof ApiError)) return gesture === 'read' ? 'ask_load_failed' : 'ask_failed';
  switch (error.status) {
    case 401: return 'signed_out';
    case 400: return 'ask_failed_invalid';
    case 404: return 'ask_failed_gone';
    case 409: return gesture === 'ask' ? 'ask_failed_busy' : 'ask_failed_running';
    case 503: return 'ask_failed_off';
    default: return gesture === 'read' ? 'ask_load_failed' : 'ask_failed';
  }
}
