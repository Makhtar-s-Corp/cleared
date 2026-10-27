// `cleared doctor` (docs/v2/milestone-5-plan.md, section 7, issue #415).
//   cleared doctor [ready]          the ready section: read only, no build,
//                                   no session, no model call
//   cleared doctor --full [args]    scripts/doctor.ts with the arguments, as
//                                   the lanes run it: it builds the images
//                                   and starts a session by default
// The settings file the setup assistant wrote applies first, as for the
// service. Each line is marked in words (ok, failed, note, not run), what to
// do is said under it, then how many checks failed. Exit 0 when none
// failed, 1 when one did, 64 for an argument it does not know; --full ends
// with scripts/doctor.ts's code. Words: src/doctor/messages/doctor.<language>.json,
// in CLEARED_V2_APP_LANGUAGE (French by default, as the app).
import '../setup/load.ts';
import { spawnSync } from 'node:child_process';
import type { Language } from '../../app/src/catalog.ts';
import { doctorTranslator, type DoctorLine, type DoctorSection } from '../doctor/section.ts';
import { loadSections, sectionsDir } from '../doctor/sections.ts';
import { languageOf } from './cleared.ts';

const DOCTOR_SCRIPT = new URL('../../scripts/doctor.ts', import.meta.url).pathname;

// The section's lines as a person reads them in a terminal: the mark, then
// the text, what to do under it at the text's column.
export function report(section: DoctorSection, lines: readonly DoctorLine[], language: Language): string {
  const t = doctorTranslator('doctor', language);
  const marks = { ok: t('mark_ok'), fail: t('mark_fail'), notice: t('mark_notice'), off: t('mark_off') };
  const width = Math.max(...Object.values(marks).map((mark) => mark.length));
  const out = [section.title(language), ''];
  for (const line of lines) {
    out.push(`${marks[line.level].padEnd(width)}  ${line.text}`);
    if (line.todo && line.level !== 'ok') out.push(`${' '.repeat(width + 2)}${line.todo}`);
  }
  const failed = lines.filter((line) => line.level === 'fail').length;
  const values = { count: lines.length, failed };
  out.push('', failed === 0 ? t('summary_ok', values) : failed === 1 ? t('summary_fail_one', values) : t('summary_fail_many', values));
  return `${out.join('\n')}\n`;
}

if (import.meta.main) {
  const language = languageOf(process.env);
  const t = doctorTranslator('doctor', language);
  const usage = `${t('usage')}\n${t('usage_ready')}\n${t('usage_full')}\n`;
  const args = process.argv.slice(2);
  if (args[0] === '--full') {
    const run = spawnSync(process.execPath, [DOCTOR_SCRIPT, ...args.slice(1)], { stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  } else if (args[0] === 'help' && args.length === 1) {
    process.stdout.write(usage);
  } else if (args.length > 1 || (args.length === 1 && args[0] !== 'ready')) {
    process.stderr.write(`${t('unknown_argument', { argument: args.find((arg) => arg !== 'ready') ?? args[0] ?? '' })}\n${usage}`);
    process.exitCode = 64;
  } else {
    const ready = (await loadSections(sectionsDir(process.env))).find((section) => section.name === 'ready');
    if (!ready) throw new Error(`no ready section in ${sectionsDir(process.env)}`);
    const lines = await ready.run(process.env, language);
    process.stdout.write(report(ready, lines, language));
    process.exitCode = lines.some((line) => line.level === 'fail') ? 1 : 0;
  }
}
