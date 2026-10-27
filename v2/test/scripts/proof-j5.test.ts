// The pure parts of the milestone 5 rehearsal (scripts/proof-j5.ts,
// docs/v2/milestone-5-plan.md section 16): the ten steps, the ports, the
// fakes it gives the service, the report, and the cleanup's filter, whose
// fixtures are the labelled objects this server already runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRehearsalScript } from '../../src/session/adapters/index.ts';
import { STEPS } from '../../src/setup/steps.ts';
import type { StepView } from '../../src/setup/types.ts';
import { RESERVED_PORTS } from '../../scripts/proof-rehearsal.ts';
import {
  PROOF_STEPS, choosePorts, cleanupPlan, keepName, fakeGitHub, firstTicketScript, ghApiAnswer, overrideFile, proofRows, renderReport, scratchName, spoken,
  type DockerObject, type ProofRun,
} from '../../scripts/proof-j5.ts';

test('the ten steps of section 1, the assistant\'s eight in the registry\'s order between the command and the live', () => {
  assert.deepEqual(PROOF_STEPS.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(PROOF_STEPS[0]?.id, 'command');
  assert.equal(PROOF_STEPS[9]?.id, 'live');
  assert.deepEqual(PROOF_STEPS.slice(1, 9).map((s) => s.id), STEPS.map((s) => s.id));
  for (const step of PROOF_STEPS) assert.ok(step.name.length > 0);
});

test('three ports, distinct, free, never a reserved one; none left refuses', () => {
  const inUse = new Set([9700, 9701, 9702, 8791, 8792]);
  for (let i = 0; i < 50; i++) {
    const ports = choosePorts(inUse, () => i / 50);
    assert.equal(new Set(Object.values(ports)).size, 3);
    for (const port of Object.values(ports)) {
      assert.ok(!inUse.has(port) && !RESERVED_PORTS.has(port), `${port}`);
      for (const banned of [80, 443, 8787, 8788, 8790, 8791, 8792, 8793]) assert.notEqual(port, banned);
    }
  }
  const full = new Set(Array.from({ length: 98 }, (_, i) => 9700 + i));
  assert.throws(() => choosePorts(full), /no free port/);
});

test('a scratch Compose project name, never the default one', () => {
  const name = scratchName(() => 0.5);
  assert.match(name, /^cleared-v2-proof-[0-9a-f]{8}$/);
  assert.notEqual(scratchName(() => 0.1), scratchName(() => 0.9));
});

const PROJECT = 'cleared-v2-proof-0a1b2c3d';
const compose = (project: string, service: string) => ({ 'cleared.dev': 'v2', 'com.docker.compose.project': project, 'com.docker.compose.service': service });
// What this server runs before the rehearsal: another Compose project of
// Cleared, the example apps and their database, and the image they share.
const BEFORE: DockerObject[] = [
  { kind: 'container', id: 'e2e1', name: 'cleared-v2-e2e-service-1', labels: compose('cleared-v2-e2e', 'service') },
  { kind: 'container', id: 'e2e2', name: 'cleared-v2-e2e-app-1', labels: compose('cleared-v2-e2e', 'app') },
  { kind: 'container', id: 'gb1', name: 'cleared-guestbook', labels: { 'cleared.dev': 'v2' } },
  { kind: 'container', id: 'gb2', name: 'cleared-guestbook-db', labels: { 'cleared.dev': 'v2' } },
  { kind: 'container', id: 'fa1', name: 'cleared-filter-api', labels: { 'cleared.dev': 'v2' } },
  { kind: 'image', id: 'old', name: 'cleared-v2:local', labels: compose('cleared-v2-e2e', 'install') },
  { kind: 'image', id: 'gbi', name: 'cleared-guestbook:d711d6bd7f02', labels: { 'cleared.dev': 'v2' } },
];

const KEEP = 'cleared-v2-proof-keep:0a1b2c3d';

test('the cleanup removes what the rehearsal made, by the label, and nothing that was there before', () => {
  const after: DockerObject[] = [
    ...BEFORE.filter((o) => o.id !== 'old'),
    { kind: 'image', id: 'old', name: KEEP, labels: compose('cleared-v2-e2e', 'install') },                // kept by its second name while the build took the tag
    { kind: 'container', id: 's1', name: `${PROJECT}-service-1`, labels: compose(PROJECT, 'service') },
    { kind: 'container', id: 'a1', name: `${PROJECT}-app-1`, labels: compose(PROJECT, 'app') },
    { kind: 'container', id: 'b1', name: `${PROJECT}-broker-1`, labels: compose(PROJECT, 'broker') },
    { kind: 'image', id: 'new', name: 'cleared-v2:local', labels: compose(PROJECT, 'install') },
    { kind: 'image', id: 'ses', name: 'cleared-v2-session:2.1.306', labels: compose(PROJECT, 'session') },
    { kind: 'image', id: 'egr', name: 'cleared-v2-egress:1', labels: compose(PROJECT, 'egress') },
    // Made by the service with the label only: a prepared image and a network.
    { kind: 'image', id: 'prep', name: 'cleared-v2-prep-guestbook:1234abcd', labels: { 'cleared.dev': 'v2', 'cleared.service': 'guestbook' } },
    { kind: 'network', id: 'net', name: 'cleared-v2-egress-xyz', labels: { 'cleared.dev': 'v2' } },
    // Made meanwhile by someone else: another project's, and an object without the label.
    { kind: 'container', id: 'e2e3', name: 'cleared-v2-e2e-broker-2', labels: compose('cleared-v2-e2e', 'broker') },
    { kind: 'container', id: 'x', name: 'unrelated', labels: {} },
  ];
  const plan = cleanupPlan({ before: BEFORE, after, project: PROJECT, kept: KEEP, image: 'cleared-v2:local' });
  assert.deepEqual(plan.remove.map((o) => o.id).sort(), ['a1', 'b1', 'egr', 'net', 'new', 'prep', 's1', 'ses']);
  for (const kept of ['e2e1', 'e2e2', 'e2e3', 'gb1', 'gb2', 'fa1', 'old', 'gbi', 'x']) assert.ok(!plan.remove.some((o) => o.id === kept), kept);
  const kinds = plan.commands.map((c) => c.slice(0, 2).join(' '));
  assert.deepEqual(kinds, ['rm --force', 'network rm', 'image rm', `tag ${KEEP}`, 'image rm']);
  assert.deepEqual(plan.commands[0]?.slice(2).sort(), ['a1', 'b1', 's1']);
  assert.deepEqual(plan.commands[2]?.slice(2).sort(), ['egr', 'new', 'prep', 'ses']);
  // The shared tag goes back to the image it named before, once the build's is gone, and the second name goes.
  assert.deepEqual(plan.commands[3], ['tag', KEEP, 'cleared-v2:local']);
  assert.deepEqual(plan.commands[4], ['image', 'rm', KEEP]);
  for (const command of plan.commands) for (const word of command) assert.doesNotMatch(word, /^(prune|system|-a|--all|--filter)$/);
});

test('the cleanup never removes an object without the label, even one of the scratch project', () => {
  const after: DockerObject[] = [...BEFORE, { kind: 'container', id: 'odd', name: `${PROJECT}-odd`, labels: { 'com.docker.compose.project': PROJECT } }];
  const plan = cleanupPlan({ before: BEFORE, after, project: PROJECT, kept: null, image: 'cleared-v2:local' });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.commands, []);
});

test('no tag to give back when the image was not there before; the second name goes even when the build changed nothing', () => {
  const made: DockerObject = { kind: 'image', id: 'new', name: 'cleared-v2:local', labels: compose(PROJECT, 'install') };
  const fresh = cleanupPlan({ before: [], after: [made], project: PROJECT, kept: null, image: 'cleared-v2:local' });
  assert.deepEqual(fresh.commands, [['image', 'rm', 'new']]);
  const cached = cleanupPlan({ before: BEFORE, after: BEFORE, project: PROJECT, kept: KEEP, image: 'cleared-v2:local' });
  assert.deepEqual(cached.commands, [['tag', KEEP, 'cleared-v2:local'], ['image', 'rm', KEEP]]);
});

test('the image\'s second name, labelled with the scratch project\'s suffix', () => {
  assert.equal(keepName(PROJECT), KEEP);
});

test('the override gives the service its fakes and nothing else: no port, no other service, its folder at its own path', () => {
  const text = overrideFile({ fakes: '/tmp/r/fakes', path: '/usr/local/bin:/usr/bin', script: '/tmp/r/fakes/script.json', api: 'http://127.0.0.1:40001', socket: '/tmp/r/fakes/release.sock', conf: '/tmp/r/fakes/agents.conf', repo: '/tmp/r/state/repositories/o/r' });
  assert.match(text, /^services:\n {2}service:\n/m);
  assert.doesNotMatch(text, /^ {2}(app|broker|install):/m);
  assert.doesNotMatch(text, /ports:|privileged|docker\.sock/);
  assert.match(text, /- "\/tmp\/r\/fakes:\/tmp\/r\/fakes"/);
  assert.match(text, /PATH: "\/tmp\/r\/fakes\/bin:\/usr\/local\/bin:\/usr\/bin"/);
  assert.match(text, /CLEARED_V2_ADAPTER: "fake"/);
  assert.match(text, /CLEARED_V2_FORGE_GITHUB_API: "http:\/\/127\.0\.0\.1:40001"/);
  assert.match(text, /CLEARED_RELEASE_SOCKET: "\/tmp\/r\/fakes\/release.sock"/);
  assert.match(text, /CLEARED_CONF: "\/tmp\/r\/fakes\/agents.conf"/);
  assert.match(text, /CLEARED_REPO: "\/tmp\/r\/state\/repositories\/o\/r"/);
  assert.throws(() => overrideFile({ fakes: '/tmp/r "x', path: '/bin', script: '/s', api: 'http://127.0.0.1:1', socket: '/s', conf: '/c', repo: '/r' }), /quote/);
});

const REPOS = [{ repo: 'rehearsal/guestbook', url: '/tmp/r/fakes/guestbook.git', base: 'main' }];

test('the fake GitHub: the account, its repositories with the right to push, 401 for any other credential', () => {
  const ok = fakeGitHub('GET', '/user/repos?per_page=100', 'Bearer good', 'good', REPOS);
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as { full_name: string }[]).map((r) => r.full_name), ['rehearsal/guestbook']);
  assert.equal(fakeGitHub('GET', '/user', 'Bearer good', 'good', REPOS).status, 200);
  const repo = fakeGitHub('GET', '/repos/rehearsal/guestbook', 'token good', 'good', REPOS);
  assert.equal(repo.status, 200);
  assert.equal((repo.body as { permissions: { push: boolean } }).permissions.push, true);
  assert.equal(fakeGitHub('GET', '/repos/rehearsal/other', 'Bearer good', 'good', REPOS).status, 404);
  assert.equal(fakeGitHub('GET', '/user/repos', 'Bearer bad', 'good', REPOS).status, 401);
  assert.equal(fakeGitHub('GET', '/user/repos', undefined, 'good', REPOS).status, 401);
  assert.equal(fakeGitHub('POST', '/user/repos', 'Bearer good', 'good', REPOS).status, 404);
});

test('the gh stand-in answers the forge contract\'s reads in the shape gh api gives after its --jq', () => {
  const list = ghApiAnswer(['api', '--paginate', '--jq', '.[] | {repo: .full_name} | tojson', 'user/repos?per_page=100'], REPOS);
  assert.equal(list?.code, 0);
  const lines = (list?.stdout ?? '').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ repo: 'rehearsal/guestbook', url: '/tmp/r/fakes/guestbook.git', base: 'main', private: true, archived: false }]);
  const one = ghApiAnswer(['api', 'repos/rehearsal/guestbook'], REPOS);
  assert.deepEqual(JSON.parse(one?.stdout ?? ''), { full_name: 'rehearsal/guestbook', clone_url: '/tmp/r/fakes/guestbook.git', default_branch: 'main', private: true, archived: false });
  assert.equal(ghApiAnswer(['api', 'repos/rehearsal/other'], REPOS)?.code, 1);
  assert.equal(ghApiAnswer(['pr', 'list'], REPOS), undefined, 'the pull requests are the milestone 2 stand-in\'s');
});

test('the fake harness: an author that proposes its plan, then adds the first ticket\'s line at the end of the README at its Go; a reviewer that passes it', () => {
  const readme = '# Guestbook\n\nThe last line.\n';
  const script = parseRehearsalScript(JSON.stringify(firstTicketScript(readme, 'The line the ticket asks for.')));
  const rule = script.authorRules?.[0];
  assert.ok(rule);
  assert.deepEqual(rule.files, [{ path: 'README.md', replace: ['The last line.', 'The last line.\n\nThe line the ticket asks for.'] }]);
  assert.ok(JSON.stringify(script.reviewer).includes('no blocking issues'));
  const plan = rule.steps.findIndex((s) => 'hostCall' in s && s.hostCall.name === 'propose_session_plan');
  const go = rule.steps.findIndex((s) => 'awaitMessage' in s);
  assert.ok(plan >= 0 && go > plan, 'the plan, then the wait for its Go');
  assert.equal((rule.steps[plan] as { hostCall: { input: { confidence: string } } }).hostCall.input.confidence, 'high');
  assert.doesNotMatch(JSON.stringify(script), /"total_cost_usd":\d/, 'no cost: no money from a fake');
});

const view = (id: StepView['id'], state: StepView['state'], personMs: number, machineMs: number): StepView =>
  ({ id, state, filled: true, skippable: id !== 'owner', shownAt: null, doneAt: null, skippedAt: null, personMs, machineMs } as StepView);
const VIEW: StepView[] = [
  view('owner', 'done', 40_000, 0), view('forge', 'done', 30_000, 1_000), view('model', 'done', 20_000, 0),
  view('workspace', 'done', 25_000, 9_000), view('environment', 'done', 5_000, 300_000), view('secrets', 'skipped', 3_000, 0),
  view('checks', 'done', 4_000, 6_000), view('first-ticket', 'done', 15_000, 120_000),
];
const MOMENTS = { todo: '2026-10-27T10:00:00.000Z', approvalAsked: '2026-10-27T10:01:30.000Z', approved: '2026-10-27T10:01:45.000Z', live: '2026-10-27T10:02:45.000Z' };

test('each step\'s time: the command\'s from the rehearsal\'s clock, the assistant\'s from its records, 9 and 10 split at the approval', () => {
  const rows = proofRows(VIEW, { commandMs: 420_000, buildMs: 600_000, moments: MOMENTS });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[0], { n: 1, name: PROOF_STEPS[0]?.name, status: 'done', personMs: 0, machineMs: 1_020_000, note: 'of which the build of Cleared\'s image, run just before the command: 10 min 00 s' });
  assert.equal(rows[4]?.machineMs, 9_000);
  assert.equal(rows[6]?.status, 'skipped');
  assert.equal(rows[8]?.personMs, null, 'the first ticket\'s record is one for 9 and 10, given on 9');
  assert.equal(rows[8]?.note, 'Todo to approved: 1 min 45 s, of which 15 s for the approval, its grace to undo included');
  assert.equal(rows[9]?.note, 'approved to live: 1 min 00 s');
  const planned = proofRows(VIEW, { commandMs: 1, buildMs: null, moments: { ...MOMENTS, planAsked: '2026-10-27T10:00:10.000Z', go: '2026-10-27T10:00:40.000Z' } });
  assert.equal(planned[8]?.note, 'Todo to approved: 1 min 45 s, of which 30 s for the session plan\'s Go and 15 s for the approval, its grace to undo included');
  assert.equal(planned[0]?.note, '', 'no build, no note');
  const missing = proofRows(VIEW.filter((v) => v.id !== 'checks'), { commandMs: 1, buildMs: null, moments: {} });
  assert.equal(missing[7]?.status, 'not seen');
  assert.equal(missing[9]?.status, 'not seen');
});

const RUN: ProofRun = {
  startedAt: '2026-10-27T09:40:00.000Z', project: PROJECT, ports: { service: 9701, app: 9702, preview: 9703 }, language: 'en',
  rows: proofRows(VIEW, { commandMs: 420_000, buildMs: 600_000, moments: MOMENTS }),
  view: VIEW, typedAfterCommand: 0, editedByHand: 0,
  standIns: ['the forge: a fake GitHub'], cleanup: { removed: 8, left: 0, restored: 'cleared-v2:local' }, problems: ['the checks step: one line failed'],
};

test('the report: the steps, the person\'s and the machine\'s time, the total against the hour, what was replaced; no millisecond, no money', () => {
  const text = renderReport(RUN);
  assert.match(text, /^# Milestone 5 proof: durations \(rehearsal\)$/m);
  for (const step of PROOF_STEPS) assert.ok(text.includes(step.name), step.name);
  assert.match(text, /\| 1 \| .+ \| done \| 0 s \| 17 min 00 s \|/);
  // 17 min for the build and the command, 9 min 38 s of the assistant.
  assert.match(text, /Total: 26 min 38 s \(the person 2 min 22 s, the machine 24 min 16 s\), under the hour\./);
  assert.match(text, /Commands typed after the one command: 0\. Files edited by hand: 0\./);
  assert.match(text, /the forge: a fake GitHub/);
  assert.match(text, /8 objects removed by the label, 0 left; cleared-v2:local named again the image it named before\./);
  assert.match(text, /the checks step: one line failed/);
  assert.doesNotMatch(text, /\d ?ms\b|milli/i);
  assert.doesNotMatch(text, /[$€]|USD|EUR|dollar|euro/i);
  assert.doesNotMatch(text, /—/);
});

test('a total over the hour says so', () => {
  const rows = RUN.rows.map((r) => (r.n === 1 ? { ...r, machineMs: 3_600_000 } : r));
  assert.match(renderReport({ ...RUN, rows }), /, over the hour\./);
});

test('durations as a person reads them', () => {
  assert.equal(spoken(0), '0 s');
  assert.equal(spoken(40_400), '40 s');
  assert.equal(spoken(65_000), '1 min 05 s');
  assert.equal(spoken(3_900_000), '1 h 05');
});
