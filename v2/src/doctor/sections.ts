// The doctor's sections as files (docs/v2/milestone-5-plan.md, section 3.1):
// each file of sections/ is a section named as the file, which
// scripts/doctor.ts runs when it is named (or by default, when the section
// says so) and `cleared doctor` runs by its name. A later lane adds a
// section by adding a file, and never edits doctor.ts. A file named as one
// of doctor.ts's own sections, or whose section is named apart from it, is
// refused, so no file hides another. CLEARED_V2_DOCTOR_SECTIONS names
// another folder, for the tests.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorSection } from './section.ts';

export const SECTIONS_DIR = new URL('./sections/', import.meta.url).pathname;
// The sections scripts/doctor.ts holds itself.
export const BUILT_IN_SECTIONS: readonly string[] = ['docker', 'claude-code', 'host-tools', 'lead', 'workspace', 'pool', 'cursor', 'codex', 'mirror'];

// A section's name: lower-case words joined by dashes, as a command's.
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const sectionsDir = (env: NodeJS.ProcessEnv): string => env.CLEARED_V2_DOCTOR_SECTIONS || SECTIONS_DIR;

export function sectionFiles(dir: string): string[] {
  return readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => file.slice(0, -3)).filter((name) => NAME.test(name)).sort();
}

const isSection = (value: unknown, name: string): value is DoctorSection => {
  const section = value as Partial<DoctorSection> | null;
  return typeof section === 'object' && section !== null && section.name === name && typeof section.byDefault === 'boolean'
    && typeof section.title === 'function' && typeof section.run === 'function';
};

export async function loadSections(dir: string = SECTIONS_DIR): Promise<DoctorSection[]> {
  const sections: DoctorSection[] = [];
  for (const name of sectionFiles(dir)) {
    const file = join(dir, `${name}.ts`);
    if (BUILT_IN_SECTIONS.includes(name)) throw new Error(`${file}: ${name} is a section of scripts/doctor.ts itself; name the file otherwise`);
    const loaded = ((await import(file)) as { default?: unknown }).default;
    if (!isSection(loaded, name)) throw new Error(`${file} does not export by default a section named ${name} (name, byDefault, title, run)`);
    sections.push(loaded);
  }
  return sections;
}
