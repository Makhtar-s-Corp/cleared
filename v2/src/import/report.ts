// What the import says (docs/v2/milestone-4-plan.md, section 3.4): counts,
// ticket ids, sizes, durations a person reads and paths, never a decision's
// text. Its words are messages/import.<language>.json, over the shell's for
// the units of a duration, which app/web/lib/time.ts says as the app does;
// the language is CLEARED_V2_APP_LANGUAGE's, French by default.
import { readFileSync } from 'node:fs';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import { duration, quantity } from '../../app/web/lib/time.ts';
import type { ImportReport } from './apply.ts';

export const IMPORT_MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;

export function languageOf(env: NodeJS.ProcessEnv): Language {
  return env.CLEARED_V2_APP_LANGUAGE?.trim() === 'en' ? 'en' : 'fr';
}

export function importTranslator(language: Language): Translate {
  const read = (lang: Language) => JSON.parse(readFileSync(`${IMPORT_MESSAGES_DIR}import.${lang}.json`, 'utf8')) as Record<string, string>;
  const catalog: Catalog = { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
  return translator(catalog);
}

export function renderReport(report: ImportReport, t: Translate, language: Language): string[] {
  const rules = new Intl.PluralRules(language);
  const many = (n: number, one: string, other: string) => (rules.select(n) === 'one' ? one : other);
  const n = (count: number) => ({ n: quantity(count, t) });
  const day = new Intl.DateTimeFormat(language, { dateStyle: 'long' });
  const { samples, approvals } = report;
  const lines = [
    report.applied ? t('header_apply', { project: report.project }) : t('header_dry', { project: report.project }),
    many(report.measured, t('read_tickets_one', n(report.measured)), t('read_tickets_other', n(report.measured))),
  ];
  const count = samples.added.length;
  if (count > 0) {
    lines.push(report.applied
      ? many(count, t('samples_added_one', n(count)), t('samples_added_other', n(count)))
      : many(count, t('samples_would_one', n(count)), t('samples_would_other', n(count))));
    for (const s of samples.added) {
      const values = { ticket: s.ticket, size: s.size, lane: s.lane === 'fast' ? t('lane_fast') : t('lane_full'), time: duration(s.minutes, t) };
      lines.push(`  ${s.tokens === null ? t('sample_time_only', values) : t('sample', { ...values, tokens: quantity(s.tokens, t) })}`);
    }
  }
  if (samples.known.length > 0) lines.push(many(samples.known.length, t('samples_known_one', n(samples.known.length)), t('samples_known_other', n(samples.known.length))));
  for (const skip of samples.skipped) {
    const why = { no_size: t('skip_no_size', { ticket: skip.ticket }), unreadable: t('skip_unreadable', { ticket: skip.ticket }), taken: t('skip_taken', { ticket: skip.ticket }) };
    lines.push(why[skip.reason]);
  }

  const approved = approvals.added.length;
  if (approved > 0) {
    lines.push(report.applied
      ? many(approved, t('approvals_added_one', n(approved)), t('approvals_added_other', n(approved)))
      : many(approved, t('approvals_would_one', n(approved)), t('approvals_would_other', n(approved))));
    for (const a of approvals.added) lines.push(`  ${t('approval', { path: a.path, who: a.by, date: day.format(new Date(a.at)) })}`);
  }
  if (approvals.known.length > 0) lines.push(many(approvals.known.length, t('approvals_known_one', n(approvals.known.length)), t('approvals_known_other', n(approvals.known.length))));
  for (const skip of approvals.skipped) {
    const why = {
      changed: t('approval_changed', { path: skip.path }),
      missing: t('approval_missing', { path: skip.path }),
      other_owner: t('approval_other_owner', { path: skip.path }),
      no_owner: t('approval_no_owner', { path: skip.path }),
      no_record: t('approval_no_record', { path: skip.path }),
    };
    lines.push(why[skip.reason]);
  }
  if (report.handovers > 0) lines.push(many(report.handovers, t('handovers_one', n(report.handovers)), t('handovers_other', n(report.handovers))));
  if (count === 0 && approved === 0) lines.push(t('nothing'));
  return lines;
}
