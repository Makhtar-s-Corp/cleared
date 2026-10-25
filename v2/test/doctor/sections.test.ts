// The doctor's sections as files (docs/v2/milestone-5-plan.md, section 3.1,
// issue #415): scripts/doctor.ts also runs each file of src/doctor/sections/,
// named by its file, so a later lane adds a section by adding a file and
// never edits doctor.ts. Run here with a scratch folder of sections, so no
// test reaches Docker.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_SECTIONS, SECTIONS_DIR, loadSections, sectionFiles } from '../../src/doctor/sections.ts';

const DOCTOR = new URL('../../scripts/doctor.ts', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'cleared-doctor-sections-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A section that says one line of each level; it fails when FAIL_HERE is set.
writeFileSync(join(scratch, 'hello.ts'), `export default {
  name: 'hello',
  byDefault: false,
  title: (language) => (language === 'en' ? 'hello: a section of a test' : 'hello : une section de test'),
  run: async (env) => [
    { id: 'one', level: 'ok', text: 'the first line' },
    { id: 'two', level: 'notice', text: 'a thing to know', todo: 'nothing to do' },
    { id: 'three', level: env.FAIL_HERE ? 'fail' : 'ok', text: 'the third line', todo: 'do the third thing' },
    { id: 'four', level: 'off', text: 'not run here' },
  ],
};
`);
// A file whose name is a section of doctor.ts itself, and one that is not a section.
writeFileSync(join(scratch, 'pool.ts'), "export default { name: 'pool', byDefault: false, title: () => 'pool', run: async () => [] };\n");
writeFileSync(join(scratch, 'Not_A_Name.ts'), 'export default {};\n');
writeFileSync(join(scratch, 'broken.ts'), "export default { name: 'other', title: () => 'x', run: async () => [] };\n");

function doctor(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DOCTOR, ...args], {
      env: { PATH: process.env.PATH, HOME: scratch, CLEARED_V2_DOCTOR_SECTIONS: scratch, CLEARED_V2_APP_LANGUAGE: 'en', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the sections are the files of src/doctor/sections, and ready is one of them', async () => {
  assert.ok(sectionFiles(SECTIONS_DIR).includes('ready'));
  const sections = await loadSections(SECTIONS_DIR);
  const ready = sections.find((section) => section.name === 'ready');
  assert.ok(ready);
  assert.equal(typeof ready.run, 'function');
  assert.notEqual(ready.title('en'), ready.title('fr'));
});

test('a file named as a section of doctor.ts, a name that is not one, or a section named apart from its file is refused', async () => {
  assert.deepEqual(sectionFiles(scratch), ['broken', 'hello', 'pool']);
  await assert.rejects(loadSections(scratch), /broken\.ts/);
  rmSync(join(scratch, 'broken.ts'));
  assert.ok(BUILT_IN_SECTIONS.includes('pool'));
  await assert.rejects(loadSections(scratch), /pool\.ts/);
  rmSync(join(scratch, 'pool.ts'));
  assert.deepEqual((await loadSections(scratch)).map((section) => section.name), ['hello']);
});

test('doctor.ts runs a section file when it is named: each line with its level, what to do under a failure, and the exit code', async () => {
  for (const file of ['broken.ts', 'pool.ts']) rmSync(join(scratch, file), { force: true });
  const well = await doctor(['hello']);
  assert.equal(well.code, 0, well.out + well.err);
  assert.match(well.out, /== hello: a section of a test/);
  assert.match(well.out, /^PASS the first line$/m);
  assert.match(well.out, /^NOTE a thing to know$/m);
  assert.match(well.out, /^NOT RUN not run here$/m);
  assert.match(well.out, /doctor: all checks passed/);
  const failed = await doctor(['hello'], { FAIL_HERE: '1' });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /^FAIL the third line$/m);
  assert.match(failed.out, /^ {4}do the third thing$/m);
  assert.match(failed.out, /doctor: 1 check\(s\) failed/);
});

test('an unknown section is refused with the list, the section files in it', async () => {
  const unknown = await doctor(['nope']);
  assert.equal(unknown.code, 64);
  assert.match(unknown.err, /hello/);
  assert.match(unknown.err, /mirror/);
});
