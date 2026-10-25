// The rehearsal of the milestone 2 proof (scripts/proof-rehearsal.ts): the
// scripted lead's rules against the texts the lead engine really sends, the
// plan against lane 7's validation, and the stand-ins for the forge's gh and
// for the lock, against what publish.ts, the flow and the approval send them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDOVER_REQUEST, commitmentDue, eventTurn, goalTurn } from '../../src/lead/prompts.ts';
import { validatePlan } from '../../src/lead/plans/tools.ts';
import { parseVerdict } from '../../src/flow/prompts.ts';
import { parseRehearsalScript, type LeadRule } from '../../src/session/adapters/index.ts';
import { LOGIN_WAIT, PLANTED } from '../../scripts/proof-report.ts';
import { serviceTurn } from '../../src/lead/prompts.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readApprovalRecord } from '../../src/approval/record.ts';
import { REHEARSAL_PLAN, RESERVED_PORTS, brokerRequest, ghStub, freePort, rehearsalScript, writeNodeStub, writeSendmailStub, writeValidation, type Forge } from '../../scripts/proof-rehearsal.ts';

const DUE = '2026-10-23T06:00:00.000Z';
const script = rehearsalScript({ due: DUE });
const rule = (text: string): LeadRule | undefined => script.lead.rules.find((r) => new RegExp(r.when, 's').test(text));
const calls = (r: LeadRule | undefined) => (r?.acts ?? []).flatMap((a) => ('call' in a ? [a.call] : 'ask' in a ? ['ask'] : []));

test('the rehearsal script is one the service accepts, and its plan one lane 7 accepts', () => {
  assert.deepEqual(parseRehearsalScript(JSON.stringify(script)), script);
  const plan = validatePlan({ goal: 'goal-1', ...REHEARSAL_PLAN });
  assert.equal(plan.items.length, 5);
  // "3 after 2", planted commitment 3, and four items with no dependency on a later one.
  assert.deepEqual(plan.items.map((i) => i.after), [[], [], [2], [], [3]]);
  assert.ok(plan.items.some((i) => i.lane === 'fast'));
  // The reviewer passes with the guestbook's verdict phrase.
  const report = script.reviewer.flatMap((s) => ('emit' in s && s.emit.type === 'TEXT_MESSAGE_CONTENT' ? [s.emit.delta] : [])).join('');
  assert.deepEqual(parseVerdict(report, 'no blocking issues'), { verdict: 'pass' });
});

test('the scripted lead answers the engine\'s own texts: the goal, the planted commitments, a landing, a due commitment, the handover', () => {
  assert.deepEqual(calls(rule(goalTurn('goal-4', 'Make the guestbook ready for a small team.'))), ['ask', 'propose_plan']);
  const [landing, reminder] = PLANTED;
  assert.deepEqual(calls(rule(landing.text)), ['commit']);
  assert.deepEqual(calls(rule(reminder.text)), ['commit']);
  const reminderCommit = rule(reminder.text)?.acts.find((a) => 'call' in a && a.call === 'commit');
  assert.deepEqual((reminderCommit as { input: { due: string } }).input.due, DUE);
  assert.deepEqual(calls(rule(eventTurn(['06:10 LOCAL-1: pull request #101 is live (healthy).'], 'State: ...'))), ['tell_owner', 'fulfil']);
  assert.equal(rule(eventTurn(['06:10 LOCAL-1: pull request #101 is live (healthy).'], ''))?.once, true);
  assert.deepEqual(calls(rule(eventTurn([commitmentDue('c2', reminder.text, DUE)], ''))), ['tell_owner', 'fulfil']);
  assert.deepEqual(calls(rule(HANDOVER_REQUEST)), ['handover']);
});

test('the rehearsal scripts a login cut on the lead\'s generation 1 and on an author, each relaunched by its next turn (review 1, F3)', () => {
  const approved = rule(serviceTurn('The owner approved plan plan-1 ("Ready for a small team"): its 5 tickets are created and start in order, at most 2 at a time.'));
  const leadCut = approved?.acts.find((a) => 'emit' in a);
  assert.ok(leadCut && JSON.stringify(leadCut).includes(LOGIN_WAIT), 'the approval turn plays the cut');
  assert.equal(approved?.once, true);
  const second = script.authors?.[1] ?? [];
  const at = second.findIndex((step) => 'emit' in step && JSON.stringify(step.emit).includes(LOGIN_WAIT));
  assert.ok(at > 0, 'the second author waits for a new login');
  const next = second[at + 1];
  assert.ok(next && 'emit' in next && next.emit.type === 'RUN_STARTED', 'then its next turn starts: the relaunch');
});

test('an event turn whose state lists the commitments does not record them again', () => {
  const state = `Open commitments:\n- c1: When the first ticket of the plan lands, tell the owner how long it took from start to live.\n- c2 (due ${DUE}): At 08:00, remind the owner to check the texts of the page.`;
  assert.equal(rule(eventTurn(['21:05 LOCAL-1: started by lead.'], state)), undefined);
});

test('the gh stand-in opens one pull request per branch, lists the open one, passes its checks and gives its head', () => {
  let forge: Forge = { next: 101, prs: [] };
  const head = (branch: string, _repo: string) => (branch === 'local-1' ? 'abc123' : undefined);
  const gh = (...args: string[]) => {
    const out = ghStub(args, forge, head);
    forge = out.forge;
    return out;
  };
  assert.deepEqual(gh('pr', 'list', '--repo', 'rehearsal/guestbook', '--head', 'local-1', '--state', 'open', '--json', 'number,url'), { code: 0, stdout: '[]\n', forge });
  const created = gh('pr', 'create', '--repo', 'rehearsal/guestbook', '--base', 'main', '--head', 'local-1', '--title', 'LOCAL-1: Entries as JSON', '--body-file', '/tmp/x');
  assert.equal(created.code, 0);
  assert.equal(created.stdout, 'https://forge.invalid/rehearsal/guestbook/pull/101\n');
  assert.deepEqual(JSON.parse(gh('pr', 'list', '--repo', 'rehearsal/guestbook', '--head', 'local-1', '--state', 'open', '--json', 'number,url').stdout), [{ number: 101, url: 'https://forge.invalid/rehearsal/guestbook/pull/101' }]);
  assert.deepEqual(JSON.parse(gh('pr', 'checks', '101', '--repo', 'rehearsal/guestbook', '--json', 'bucket').stdout), [{ bucket: 'pass' }]);
  assert.deepEqual(JSON.parse(gh('pr', 'view', '101', '--json', 'headRefOid').stdout), { headRefOid: 'abc123' });
  assert.equal(gh('pr', 'create', '--repo', 'rehearsal/guestbook', '--base', 'main', '--head', 'local-2', '--title', 'T', '--body-file', '/tmp/y').stdout, 'https://forge.invalid/rehearsal/guestbook/pull/102\n');
  // Anything else is refused, so nothing reaches a real forge by mistake.
  assert.equal(gh('pr', 'merge', '101').code, 1);
  assert.equal(gh('api', 'user').code, 1);
  assert.equal(gh('pr', 'checks', '999', '--json', 'bucket').code, 1);
});

test('a stand-in on PATH is the script itself run by Node, in one process, with its words, the caller\'s arguments, input and exit code (D11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-stub-'));
  try {
    const script = join(dir, 'target.mjs');
    writeFileSync(script, "import { readFileSync } from 'node:fs';\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(1), pid: process.pid, input: readFileSync(0, 'utf8') }));\nprocess.exit(3);\n");
    const stub = join(dir, 'gh');
    writeNodeStub(stub, script, ['gh-stub', 'a forge.json']);
    assert.ok(readFileSync(stub, 'utf8').startsWith(`#!${process.execPath} `), 'Node runs it, no shell');
    const ran = spawnSync(stub, ['pr', 'view', '1 2'], { input: 'body', encoding: 'utf8' });
    assert.equal(ran.status, 3);
    assert.deepEqual(JSON.parse(ran.stdout), { argv: [script, 'gh-stub', 'a forge.json', 'pr', 'view', '1 2'], pid: ran.pid, input: 'body' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sendmail stand-in appends each message to the mail file after a dated line, in Node (D11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mail-'));
  try {
    const mail = join(dir, 'mail.log');
    writeSendmailStub(dir, mail);
    for (const body of ['To: a\n\nfirst\n', 'To: b\n\nsecond\n']) assert.equal(spawnSync(join(dir, 'sendmail'), ['-t'], { input: body }).status, 0);
    assert.match(readFileSync(mail, 'utf8'), /^---- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\nTo: a\n\nfirst\n---- \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\nTo: b\n\nsecond\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the lock stand-in reads the requests of release-request.ts and of the approval\'s broker client', () => {
  // release-request.ts request_release T PR --ask (the flow's requestRelease).
  assert.deepEqual(brokerRequest(JSON.stringify({ operation: 'request_release', ticket: 'LOCAL-1', pr: 101, approval_request: 'Release?', announcement: '', approval_prs: [101], captures: [] })), { op: 'ask', ticket: 'LOCAL-1', pr: 101, prs: [101] });
  // Without --ask (the flow's mergeRelease, ORCH_FROM_QUEUE) and the approval writer's own call.
  assert.deepEqual(brokerRequest(JSON.stringify({ operation: 'request_release', ticket: 'LOCAL-1', pr: 101, announcement: 'What changes', from_queue: true })), { op: 'merge', ticket: 'LOCAL-1', pr: 101 });
  assert.deepEqual(brokerRequest(JSON.stringify({ operation: 'request_release', ticket: 'LOCAL-1', pr: 101, announcement: 'What changes' })), { op: 'merge', ticket: 'LOCAL-1', pr: 101 });
  assert.deepEqual(brokerRequest(JSON.stringify({ operation: 'status', ticket: 'LOCAL-1' })), { op: 'status', ticket: 'LOCAL-1', pr: null });
  assert.deepEqual(brokerRequest('nonsense'), { op: 'invalid', ticket: '', pr: null });
  // The train's reverse rollback (release/train.ts), through approval/broker.ts.
  assert.deepEqual(brokerRequest(JSON.stringify({ operation: 'request_rollback', ticket: 'LOCAL-1' })), { op: 'rollback', ticket: 'LOCAL-1', pr: null });
  assert.deepEqual(brokerRequest(JSON.stringify({ operation: 'request_rollback' })), { op: 'invalid', ticket: '', pr: null });
});

test('the gh stand-in keeps each repository apart: one branch name on two services gives two pull requests (lane 29)', () => {
  let forge: Forge = { next: 101, prs: [] };
  const heads: Record<string, string> = { 'rehearsal/guestbook local-1': 'aaa', 'rehearsal/filter-api local-1': 'fff' };
  const gh = (...args: string[]) => {
    const out = ghStub(args, forge, (branch, repo) => heads[`${repo} ${branch}`]);
    forge = out.forge;
    return out;
  };
  const list = (repo: string) => JSON.parse(gh('pr', 'list', '--repo', repo, '--head', 'local-1', '--state', 'open', '--json', 'number,url').stdout);
  assert.equal(gh('pr', 'create', '--repo', 'rehearsal/filter-api', '--base', 'main', '--head', 'local-1', '--title', 'LOCAL-1: x', '--body-file', '/tmp/x').stdout, 'https://forge.invalid/rehearsal/filter-api/pull/101\n');
  assert.deepEqual(list('rehearsal/guestbook'), [], 'the filter API\'s pull request is not the guestbook\'s');
  assert.equal(gh('pr', 'create', '--repo', 'rehearsal/guestbook', '--base', 'main', '--head', 'local-1', '--title', 'LOCAL-1: x', '--body-file', '/tmp/x').stdout, 'https://forge.invalid/rehearsal/guestbook/pull/102\n');
  assert.deepEqual(list('rehearsal/filter-api'), [{ number: 101, url: 'https://forge.invalid/rehearsal/filter-api/pull/101' }]);
  // The approval's `gh pr view` names no repository: the number is unique across the forge.
  assert.deepEqual(JSON.parse(gh('pr', 'view', '101', '--json', 'headRefOid').stdout), { headRefOid: 'fff' });
  assert.deepEqual(JSON.parse(gh('pr', 'view', '102', '--json', 'headRefOid').stdout), { headRefOid: 'aaa' });
  assert.deepEqual(forge.prs.map((pr) => [pr.number, pr.repo]), [[101, 'rehearsal/filter-api'], [102, 'rehearsal/guestbook']]);
});

test('the lock stand-in keeps the request for agreement as ask-validation.ts does, so the approval finds it', () => {
  const state = mkdtempSync(join(tmpdir(), 'cleared-rehearsal-state-'));
  const head = 'a'.repeat(40);
  writeValidation(state, { ticket: 'LOCAL-1', prs: [101] }, () => head, '2026-10-22T21:20:00.000Z');
  assert.deepEqual(readApprovalRecord(state, 'LOCAL-1'), { at: '2026-10-22T21:20:00.000Z', versions: [{ pr: 101, head }] });
  assert.equal(statSync(join(state, 'validations', 'LOCAL-1.json')).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(state, 'validations', 'LOCAL-1.json'), 'utf8').includes('"pulls"'));
  // A pull request whose head is unknown keeps no record: the approval is refused, as it should be.
  writeValidation(state, { ticket: 'LOCAL-2', prs: [102] }, () => undefined, '2026-10-22T21:20:00.000Z');
  assert.equal(readApprovalRecord(state, 'LOCAL-2'), undefined);
  rmSync(state, { recursive: true, force: true });
});

test('a free port is never a reserved one nor one in use', () => {
  // 8794 and 8795: the preview listener's and the filter API's on this server (lane 29).
  const reserved = [80, 443, 8787, 8788, 8790, 8791, 8792, 8793, 8794, 8795];
  for (const port of reserved) assert.ok(RESERVED_PORTS.has(port), String(port));
  const port = freePort(new Set([9700, 9701]), () => 0);
  assert.equal(port, 9702);
  assert.ok(!reserved.includes(port));
});

// The authors of the replanned milestone 2 (lane 29): each proposes its
// session plan, waits for the Go, then works and reports its changes.
const hostCalls = (steps: readonly unknown[]) => steps.flatMap((s) => (typeof s === 'object' && s !== null && 'hostCall' in s ? [(s as { hostCall: { name: string; input: { confidence?: string } } }).hostCall] : []));

test('every rehearsal author proposes its session plan before it works, and reports its changes at the end (lane 29)', () => {
  for (const steps of [script.author.steps, ...(script.authors ?? [])]) {
    const calls = hostCalls(steps);
    assert.deepEqual(calls.map((c) => c.name), ['propose_session_plan', 'report_changes']);
    const proposal = steps.findIndex((s) => 'hostCall' in s && s.hostCall.name === 'propose_session_plan');
    const wait = steps.findIndex((s) => 'awaitMessage' in s);
    assert.ok(proposal >= 0 && wait > proposal, 'the turn ends on the plan, and the Go is a message');
    assert.ok(steps.slice(wait).some((s) => 'hostCall' in s && s.hostCall.name === 'report_changes'), 'the report comes after the Go');
  }
  // Most are high, so the lead's Go starts them by the plan; one is medium, so the morning gives its Go.
  const confidences = [script.author.steps, ...(script.authors ?? [])].map((steps) => hostCalls(steps)[0]?.input.confidence);
  assert.ok(confidences.includes('medium'));
  assert.ok(confidences.filter((c) => c === 'high').length >= 2);
  // One author leaves a handover with a lesson: the morning counts the knowledge item and leaves it to the owner.
  assert.ok([script.author, ...(script.authorRules ?? [])].some((a) => a.handover?.includes('## Lessons for the workspace')), 'a handover with a lesson');
});
