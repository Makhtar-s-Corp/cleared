// What a doctor section is (docs/v2/milestone-5-plan.md, section 3.1: one
// doctor, sections as files): each file of sections/ exports one by default,
// named as the file, and scripts/doctor.ts, `cleared doctor` and the setup
// assistant's checks step run it through this shape. A line is passed,
// failed with what to do, a notice (said, never a failure), or not run (what
// it needs is missing, said by a line above it). Its words are the section's
// own, in the language it is given.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Translate } from '../../app/web/lib/i18n.ts';

export type DoctorLevel = 'ok' | 'fail' | 'notice' | 'off';

export type DoctorLine = {
  readonly id: string;                 // the check, stable: what docs/troubleshooting.md names
  readonly level: DoctorLevel;
  readonly text: string;
  readonly todo?: string;              // what to do; every failure has one
};

export type DoctorSection = {
  readonly name: string;               // as the command line names it: the file's name
  readonly byDefault: boolean;         // run by scripts/doctor.ts when no section is named
  title(language: Language): string;
  run(env: NodeJS.ProcessEnv, language: Language): Promise<readonly DoctorLine[]>;
};

export const DOCTOR_MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;

// A catalog of messages/, over the shell's units of time; a word French
// lacks falls back to English.
export function doctorTranslator(catalog: string, language: Language): Translate {
  const read = (lang: Language) => JSON.parse(readFileSync(join(DOCTOR_MESSAGES_DIR, `${catalog}.${lang}.json`), 'utf8')) as Record<string, string>;
  return translator({ ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) });
}
