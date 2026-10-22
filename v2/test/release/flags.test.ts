// The release card's groups and flags (docs/v2/milestone-2-plan.md,
// decision 23): lane 16 fixed the signature and placed the call; lane 18
// fills it. The groups come from the author's `report_changes` report, the
// flags from the diff the publish step read: `schema`, `dependency`,
// `config`, `secret_shape`, `contract` and `large`. The publish step reads
// the report from the session's last `cleared.changes` journal event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGES_EVENT, LARGE_LINES, OTHER_CHANGES, changesReport, flags } from '../../src/release/flags.ts';
import type { ReleaseFlag } from '../../src/api/types.ts';
import type { SessionEvent } from '../../src/session/events.ts';

const custom = (seq: number, name: string, value: unknown): SessionEvent =>
  ({ seq, at: '2026-10-22T10:00:00.000Z', sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name, value } } as unknown as SessionEvent);

// A file's diff as git prints it: `lines` are the hunk's lines, each with
// its ' ', '+' or '-' mark; the hunk header counts them.
function file(path: string, lines: readonly string[], options: { created?: boolean; deleted?: boolean; from?: number } = {}): string {
  const old = lines.filter((line) => !line.startsWith('+')).length;
  const now = lines.filter((line) => !line.startsWith('-')).length;
  const from = options.from ?? 1;
  return [
    `diff --git a/${path} b/${path}`,
    ...(options.created ? ['new file mode 100644'] : options.deleted ? ['deleted file mode 100644'] : []),
    `index 1111111..2222222${options.created || options.deleted ? '' : ' 100644'}`,
    `--- ${options.created ? '/dev/null' : `a/${path}`}`,
    `+++ ${options.deleted ? '/dev/null' : `b/${path}`}`,
    `@@ -${options.created ? 0 : from},${old} +${options.deleted ? 0 : from},${now} @@`,
    ...lines,
    '',
  ].join('\n');
}

const kinds = (out: { flags: readonly ReleaseFlag[] }) => out.flags.map((f) => f.kind);
const flag = (out: { flags: readonly ReleaseFlag[] }, kind: ReleaseFlag['kind']) => out.flags.find((f) => f.kind === kind);

const PAGE = file('src/page.ts', [' export function page() {', '-  return entries;', '+  return entries.toReversed();', ' }']);

test('nothing to read gives no group and no flag', () => {
  assert.deepEqual(flags({ diff: '' }), { groups: [], flags: [] });
  // A plain change raises no flag, and without a report it has no group.
  assert.deepEqual(flags({ diff: PAGE }), { groups: [], flags: [] });
});

test('the groups are the report\'s, each with the files the diff changes; the rest go to "Other changes"', () => {
  const diff = PAGE + file('test/page.test.ts', ['+test("newest first", () => {});'], { created: true }) + file('README.md', [' # Guestbook', '+Newest first.']);
  const out = flags({ diff, report: { groups: [
    { intent: '  Show the newest entry first ', files: ['src/page.ts', 'test/page.test.ts', 'src/gone.ts'] },
    { intent: 'Nothing that changed', files: ['src/other.ts'] },
  ] } });
  assert.deepEqual(out.groups, [
    { intent: 'Show the newest entry first', files: ['src/page.ts', 'test/page.test.ts'] },
    { intent: OTHER_CHANGES, files: ['README.md'] },
  ]);
  assert.equal(OTHER_CHANGES, 'Other changes');
});

test('a file the report names twice stays in its first group, and a group of no file is left out', () => {
  const out = flags({ diff: PAGE, report: { groups: [{ intent: 'Sort', files: ['src/page.ts'] }, { intent: 'Again', files: ['src/page.ts'] }, { intent: ' ', files: [] }] } });
  assert.deepEqual(out.groups, [{ intent: 'Sort', files: ['src/page.ts'] }]);
});

test('with a report and no diff to read, the report\'s groups are kept as the author gave them', () => {
  const out = flags({ diff: '', report: { groups: [{ intent: 'Sort the entries', files: ['src/page.ts'] }] } });
  assert.deepEqual(out, { groups: [{ intent: 'Sort the entries', files: ['src/page.ts'] }], flags: [] });
});

test('schema: a file in a migration folder, or a .sql file', () => {
  const diff = file('db/migrations/0003_entries.ts', ['+export const up = "ALTER TABLE entries ADD COLUMN held";'], { created: true })
    + file('schema/entries.SQL', ['+CREATE INDEX entries_at ON entries(at);'], { created: true })
    + file('prisma/migrate/readme.md', ['+notes'], { created: true })
    + PAGE;
  const out = flags({ diff });
  assert.deepEqual(kinds(out), ['schema']);
  assert.deepEqual(flag(out, 'schema')?.files, ['db/migrations/0003_entries.ts', 'prisma/migrate/readme.md', 'schema/entries.SQL']);
  assert.match(flag(out, 'schema')?.detail ?? '', /database/);
  // A word that only looks like one is not a migration folder.
  assert.deepEqual(kinds(flags({ diff: file('src/migrations-guide.ts', ['+x']) })), []);
});

test('dependency: a line of a dependencies block of package.json, or a lock file', () => {
  const added = file('package.json', ['   "dependencies": {', '+    "left-pad": "1.3.0",', '     "pg": "8.13.1"', '   },'], { from: 8 });
  assert.deepEqual(kinds(flags({ diff: added })), ['dependency']);
  assert.deepEqual(flag(flags({ diff: added }), 'dependency')?.files, ['package.json']);
  const dev = file('web/package.json', ['   "devDependencies": {', '-    "vite": "8.0.0"', '+    "vite": "8.0.1"', '   }'], { from: 20 });
  assert.deepEqual(flag(flags({ diff: dev }), 'dependency')?.files, ['web/package.json']);
  const lock = file('package-lock.json', ['-      "version": "8.0.0",', '+      "version": "8.0.1",'], { from: 400 })
    + file('pnpm-lock.yaml', ['+  left-pad: 1.3.0'], { from: 3 }) + file('yarn.lock', ['+left-pad@1.3.0:'], { from: 9 });
  assert.deepEqual(flag(flags({ diff: lock }), 'dependency')?.files, ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
});

test('dependency: a change to the scripts or the version of package.json is not one; a change the hunk cannot place is', () => {
  const scripts = file('package.json', ['   "scripts": {', '-    "test": "node --test"', '+    "test": "node --test --test-reporter=dot"', '   },'], { from: 5 });
  assert.deepEqual(kinds(flags({ diff: scripts })), []);
  const version = file('package.json', [' {', '   "name": "guestbook",', '-  "version": "1.0.0",', '+  "version": "1.0.1",'], { from: 1 });
  assert.deepEqual(kinds(flags({ diff: version })), []);
  // The block closed, the next one opened in the same hunk: its lines are the dependencies'.
  const after = file('package.json', ['   "scripts": {', '     "test": "node --test"', '   },', '   "dependencies": {', '+    "left-pad": "1.3.0",'], { from: 5 });
  assert.deepEqual(kinds(flags({ diff: after })), ['dependency']);
  // A hunk that starts inside a block it does not show: a chip is never a block, so it is flagged.
  const unplaced = file('package.json', ['     "pg": "8.13.1",', '+    "left-pad": "1.3.0"'], { from: 30 });
  assert.deepEqual(kinds(flags({ diff: unplaced })), ['dependency']);
});

test('config: .github/, .cleared/ and the guarded paths given', () => {
  const diff = file('.github/workflows/checks.yml', ['+      - run: npm test']) + file('.cleared/agents.conf', ['+guarded_paths = deploy/'])
    + file('deploy/watch.ts', ['+// probe']) + file('Dockerfile', ['+EXPOSE 8793']) + PAGE;
  assert.deepEqual(flag(flags({ diff }), 'config')?.files, ['.cleared/agents.conf', '.github/workflows/checks.yml']);
  assert.deepEqual(flag(flags({ diff, guarded: ['deploy/', 'Dockerfile', '.github/'] }), 'config')?.files, ['.cleared/agents.conf', '.github/workflows/checks.yml', 'Dockerfile', 'deploy/watch.ts']);
});

test('secret_shape: an added line the guard would flag, named by its kind and file, never by its text', () => {
  const secret = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const diff = file('src/config.ts', [` export const port = 8793;`, `+export const key = "${secret}";`])
    + file('src/old.ts', [`-const key = "${secret}";`]);
  const out = flags({ diff });
  assert.deepEqual(kinds(out), ['secret_shape']);
  assert.deepEqual(flag(out, 'secret_shape')?.files, ['src/config.ts'], 'a removed line is not flagged');
  assert.match(flag(out, 'secret_shape')?.detail ?? '', /API key/);
  assert.ok(!JSON.stringify(out).includes(secret), 'the card never carries the line');
  assert.ok(!JSON.stringify(out).includes('a1B2c3'), 'nor a part of it');
});

test('contract: a contract file of a service, given by the compatibility check', () => {
  const contract = file('contract/openapi.yaml', ['             ok:', '+              severity:', '+                type: string'], { from: 40 });
  assert.deepEqual(kinds(flags({ diff: contract + PAGE })), [], 'without the contracts given, a YAML file is a file');
  const out = flags({ diff: contract + PAGE, contracts: ['contract/openapi.yaml', 'api/openapi.yaml'] });
  assert.deepEqual(kinds(out), ['contract']);
  assert.deepEqual(flag(out, 'contract')?.files, ['contract/openapi.yaml']);
});

test('large: more than 400 lines added over the whole change', () => {
  assert.equal(LARGE_LINES, 400);
  const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `+${prefix} ${i}`);
  const exactly = file('src/a.ts', lines(250, 'a'), { created: true }) + file('src/b.ts', lines(150, 'b'), { created: true });
  assert.deepEqual(kinds(flags({ diff: exactly })), [], '400 lines is not more than 400');
  const more = exactly + file('src/c.ts', lines(1, 'c'), { created: true }) + file('src/d.ts', ['-gone'], { deleted: true });
  const out = flags({ diff: more });
  assert.deepEqual(kinds(out), ['large']);
  assert.deepEqual(flag(out, 'large')?.files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.match(flag(out, 'large')?.detail ?? '', /401 lines added/);
});

test('an added line that reads like a header is counted as a line, not as a new file', () => {
  // "+++ b/x" inside a hunk is the line "++ b/x" added; "--- a/y" there is the line "-- a/y" removed.
  const diff = file('notes.md', ['+++ b/.github/workflows/evil.yml', '--- a/package.json', ' kept']);
  const out = flags({ diff });
  assert.deepEqual(kinds(out), []);
  assert.deepEqual(flags({ diff, report: { groups: [] } }).groups, [{ intent: OTHER_CHANGES, files: ['notes.md'] }]);
});

test('a train\'s diffs, one repository after the other, name each file once and raise each flag once', () => {
  const diff = file('package.json', ['   "dependencies": {', '+    "left-pad": "1.3.0",']) + PAGE
    + file('package.json', ['   "dependencies": {', '+    "right-pad": "1.0.0",']) + file('src/check.ts', ['+export const held = true;']);
  const out = flags({ diff, report: { groups: [{ intent: 'Hold flagged entries', files: ['src/check.ts', 'src/page.ts'] }] } });
  assert.deepEqual(out.flags, [{ kind: 'dependency', files: ['package.json'], detail: out.flags[0]?.detail }]);
  assert.deepEqual(out.groups, [{ intent: 'Hold flagged entries', files: ['src/check.ts', 'src/page.ts'] }, { intent: OTHER_CHANGES, files: ['package.json'] }]);
});

test('the flags come in one order, and a renamed or deleted file is named by its path', () => {
  const diff = file('db/migrations/0004.sql', ['-DROP TABLE x;'], { deleted: true }) + file('.github/ci.yml', ['+x']) + file('package-lock.json', ['+x']);
  assert.deepEqual(kinds(flags({ diff })), ['schema', 'dependency', 'config']);
  assert.deepEqual(flag(flags({ diff }), 'schema')?.files, ['db/migrations/0004.sql']);
  const quoted = 'diff --git "a/docs/a b.md" "b/docs/a b.md"\nindex 1..2 100644\n--- "a/docs/a b.md"\n+++ "b/docs/a b.md"\n@@ -1 +1 @@\n-x\n+y\n';
  assert.deepEqual(flags({ diff: quoted, report: { groups: [{ intent: 'Docs', files: ['docs/a b.md'] }] } }).groups, [{ intent: 'Docs', files: ['docs/a b.md'] }]);
  const binary = 'diff --git a/img/logo.png b/img/logo.png\nnew file mode 100644\nindex 0000000..3333333\nBinary files /dev/null and b/img/logo.png differ\n';
  assert.deepEqual(flags({ diff: binary, report: { groups: [] } }).groups, [{ intent: OTHER_CHANGES, files: ['img/logo.png'] }]);
});

test('the report is the value of the last cleared.changes event, by that name', () => {
  assert.equal(CHANGES_EVENT, 'cleared.changes');
  const events = [
    custom(1, 'cleared.changes', { groups: [{ intent: 'First try', files: ['a.ts'] }] }),
    custom(2, 'cleared.question', { groups: [{ intent: 'Not a report', files: ['x.ts'] }] }),
    custom(3, 'cleared.changes', { groups: [{ intent: 'Sort the entries', files: ['src/page.ts', 'test/page.test.ts'] }, { intent: 'Docs', files: ['README.md'] }] }),
    custom(4, 'cleared.review_verdict', { verdict: 'pass' }),
  ];
  assert.deepEqual(changesReport(events), { groups: [{ intent: 'Sort the entries', files: ['src/page.ts', 'test/page.test.ts'] }, { intent: 'Docs', files: ['README.md'] }] });
});

test('no report, or a report of another shape, reads as none', () => {
  assert.equal(changesReport([]), undefined);
  assert.equal(changesReport([custom(1, 'cleared.changes', { groups: 'all of it' })]), undefined);
  assert.equal(changesReport([custom(1, 'cleared.changes', { groups: [{ intent: 3, files: [] }] })]), undefined);
  assert.equal(changesReport([custom(1, 'cleared.changes', null)]), undefined);
});
