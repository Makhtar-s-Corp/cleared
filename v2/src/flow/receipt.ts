// The proof receipt at the top of a pull request Cleared opens (issue #326,
// matrix P210, owner decision of 2026-10-25 01:09): the captures before and
// after with a video of the flow (flow/proof-capture.ts), the tests the
// reviewers ran with their result (flow/review-tests.ts, read from the
// ledger), and the cost: the tokens and the time, and dollars only when
// every session of the ticket reported a figure, never an estimate and
// never euros (no source gives them).
//
// The block is built from structured fields only: no report, no command
// output, no error's text, no path of this machine. A capture is linked
// through the app (`/api/service/tickets/<id>/proof/<service>/<file>`) when
// a link address is set, else said to be kept by Cleared. Its words are
// its own catalog's (messages/receipt.<language>.json), over the shell's
// for the units of a duration, in the project's language.
import { readFileSync } from 'node:fs';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import { lasted, quantity } from '../../app/web/lib/time.ts';
import { turnTokens } from '../consumption/usage.ts';
import type { SessionEvent } from '../session/events.ts';
import type { CaptureMissing, ProofCapture } from './proof-capture.ts';

export const RECEIPT_MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;
export const RECEIPT_START = '<!-- cleared:proof-receipt -->';
export const RECEIPT_END = '<!-- /cleared:proof-receipt -->';

export type ReceiptTest = { readonly round: number; readonly command: string; readonly outcome: 'passed' | 'failed' | 'unclear' | 'not_run' };
export type ReceiptCapture = ProofCapture & { readonly service: string };

export type ReceiptData = {
  readonly ticket: string;
  readonly tests: readonly ReceiptTest[];         // one per review round that ran with a declared command, oldest first
  readonly testsDeclared: boolean;
  readonly tokens: number | null;                 // null when no turn reported its usage
  readonly costUsd: number | null;                // null unless every session that ran a turn reported a total
  readonly elapsedMs: number;                     // from the first session's start to the publish
  readonly captures: readonly ReceiptCapture[];
  readonly linkBase?: string | undefined;         // the app's address, as CLEARED_NOTIFY_LINK_BASE gives it
};

function catalogOf(language: Language): Catalog {
  const read = (lang: Language) => JSON.parse(readFileSync(`${RECEIPT_MESSAGES_DIR}receipt.${lang}.json`, 'utf8')) as Record<string, string>;
  return { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
}

// The address of a capture through the app, or undefined when the link
// address is not a plain http(s) origin.
export function proofLink(linkBase: string | undefined, ticket: string, service: string, file: string): string | undefined {
  if (!linkBase) return undefined;
  let url: URL;
  try { url = new URL(linkBase); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  return `${url.origin}/api/service/tickets/${encodeURIComponent(ticket)}/proof/${encodeURIComponent(service)}/${encodeURIComponent(file)}`;
}

// A command in a code span: a backtick or a line break of its own cannot end it.
const code = (command: string) => `\`${command.replace(/`/g, "'").replace(/\s+/g, ' ').trim()}\``;

const dollars = (usd: number, language: Language) =>
  new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);

const PART_KEYS: Record<CaptureMissing['part'], string> = { before: 'receipt_before', after: 'receipt_after', video: 'receipt_video_part' };

function captureLine(capture: ReceiptCapture, data: ReceiptData, t: Translate): string {
  const taken: { label: string; file: string }[] = [];
  if (capture.before) taken.push({ label: t('receipt_before'), file: capture.before });
  if (capture.after) taken.push({ label: t('receipt_after'), file: capture.after });
  if (capture.video) taken.push({ label: t('receipt_video', { time: lasted(capture.videoMs ?? 0, t) }), file: capture.video });
  const parts: string[] = [];
  if (taken.length > 0) {
    const links = taken.map((p) => ({ ...p, url: proofLink(data.linkBase, data.ticket, capture.service, p.file) }));
    parts.push(links.every((l) => l.url)
      ? links.map((l) => `[${l.label}](${l.url})`).join(', ')
      : t('receipt_kept', { parts: taken.map((p) => p.label).join(', ') }));
  }
  for (const missing of capture.missing)
    parts.push(t('receipt_not_taken', { part: t(PART_KEYS[missing.part]), reason: t(`receipt_reason_${missing.reason}`) }));
  return t('receipt_captures_of', { service: capture.service, parts: parts.join('; ') });
}

export function renderReceipt(data: ReceiptData, language: Language): string {
  const t = translator(catalogOf(language));
  const lines = [RECEIPT_START, `### ${t('receipt_title')}`, ''];
  if (data.captures.length === 0) lines.push(`- ${t('receipt_captures_none')}`);
  for (const capture of data.captures) lines.push(`- ${captureLine(capture, data, t)}`);
  if (!data.testsDeclared) lines.push(`- ${t('receipt_tests_none')}`);
  else if (data.tests.length === 0) lines.push(`- ${t('receipt_tests_no_round')}`);
  else {
    lines.push(`- ${t('receipt_tests')}`);
    for (const run of data.tests) lines.push(`  - ${t(`receipt_test_${run.outcome}`, { round: run.round, command: code(run.command) })}`);
  }
  const cost = data.tokens === null ? t('receipt_tokens_unknown') : t('receipt_tokens', { tokens: quantity(data.tokens, t) });
  lines.push(`- ${data.costUsd === null ? cost : `${cost}, ${t('receipt_usd', { usd: dollars(data.costUsd, language) })}`}`);
  lines.push(`- ${t('receipt_time', { time: lasted(data.elapsedMs, t) })}`);
  lines.push(RECEIPT_END);
  return lines.join('\n');
}

// What a ticket's sessions spent: the tokens of every finished turn, and
// the dollars as the sum of each session's last reported total (Claude
// Code's `total_cost_usd` is the session's running total, decisions log of
// lane 25). A session that ran a turn and never reported a total (Codex,
// Cursor) leaves the dollars unknown: a partial sum is not the cost.
export function ticketUsage(sessions: readonly (readonly SessionEvent[])[]): { tokens: number | null; costUsd: number | null } {
  let tokens: number | null = null;
  let cost = 0;
  let known = true;
  for (const events of sessions) {
    let last: number | null = null;
    let turns = 0;
    for (const { event } of events) {
      if (event.type !== 'RUN_FINISHED') continue;
      turns += 1;
      tokens = (tokens ?? 0) + turnTokens(event);
      if (typeof event.result.total_cost_usd === 'number') last = event.result.total_cost_usd;
    }
    if (turns === 0) continue;
    if (last === null) known = false;
    else cost += last;
  }
  return { tokens, costUsd: tokens !== null && known ? Math.round(cost * 1e6) / 1e6 : null };
}

// The body with the receipt first: in place of the receipt it holds, else before it.
export function withReceipt(body: string, receipt: string): string {
  const start = body.indexOf(RECEIPT_START);
  const end = body.indexOf(RECEIPT_END, start);
  if (start >= 0 && end >= 0) return `${body.slice(0, start)}${receipt}${body.slice(end + RECEIPT_END.length)}`;
  return body.trim() ? `${receipt}\n\n${body}` : receipt;
}
