// Close and the forge (issue #249, P114, owner decision of 2026-10-24 23:51):
// closing a ticket also closes its pull request on GitHub, with a comment
// that gives the reason, and never deletes the branch. Done on the host
// through gh, as the CI repair is (P77), for a pull request Cleared opened
// only, once (a pull request already closed or merged is left alone), and a
// failure is said on the ticket without stopping the Close. gh is a fake on
// PATH that records its calls: no call reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeComment, closePullRequest, PrCloseRefused, type PrCloseInput } from '../../src/flow/pr-close.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import { setup } from './support.ts';
import { tempDir } from '../workspace/git.ts';

const agents = { kind: 'agents', id: 'cleared-v2' } as const;
const BRANCH = 'cleared/DEMO-7';

// A fake gh on PATH: `pr view` answers `view` (JSON or an exit code), every
// other call is recorded and succeeds, `fail` makes `pr close` exit 1.
function fakeGh(view: unknown, options: { readonly fail?: boolean } = {}) {
  const root = tempDir('close-pr');
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') { process.stdout.write(${JSON.stringify(JSON.stringify(view))} + '\\n'); }
else if (args[0] === 'pr' && args[1] === 'close' && ${JSON.stringify(options.fail === true)}) { process.stderr.write('GraphQL: could not close'); process.exit(1); }
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = (): { args: string[]; cwd: string }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
  return { root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, calls };
}

const input = (gh: ReturnType<typeof fakeGh>, over: Partial<PrCloseInput> = {}): PrCloseInput => ({
  pr: 101, repo: 'example/guestbook', dir: gh.root, base: 'main', branches: [BRANCH], reason: 'A rehearsal ticket of a proof run.', env: gh.env, ...over,
});
const open = { state: 'OPEN', headRefName: BRANCH };
const closes = (gh: ReturnType<typeof fakeGh>) => gh.calls().filter((c) => c.args[1] === 'close');

test('an open pull request of the ticket branch is closed with a comment that gives the reason, and the branch is kept', async () => {
  const gh = fakeGh(open);
  assert.equal(await closePullRequest(input(gh)), 'closed');
  const [view, close, ...rest] = gh.calls();
  assert.deepEqual(view?.args, ['pr', 'view', '101', '--repo', 'example/guestbook', '--json', 'state,headRefName']);
  assert.deepEqual(close?.args.slice(0, 5), ['pr', 'close', '101', '--repo', 'example/guestbook']);
  assert.equal(close?.args[5], '--comment');
  assert.equal(close?.args[6], closeComment('A rehearsal ticket of a proof run.', BRANCH));
  assert.match(close?.args[6] ?? '', /A rehearsal ticket of a proof run\./);
  assert.match(close?.args[6] ?? '', /branch cleared\/DEMO-7 is kept/);
  assert.equal(close?.args.length, 7, 'nothing else is passed to gh pr close');
  assert.deepEqual(rest, []);
  assert.equal(gh.calls().some((c) => c.args.some((a) => /delete/i.test(a))), false, 'the branch is never deleted');
});

test('a pull request already closed or already merged is left alone: nothing is closed, nothing is commented', async () => {
  for (const [state, outcome] of [['CLOSED', 'already_closed'], ['MERGED', 'already_merged']] as const) {
    const gh = fakeGh({ state, headRefName: BRANCH });
    assert.equal(await closePullRequest(input(gh)), outcome);
    assert.deepEqual(gh.calls().map((c) => c.args[1]), ['view']);
  }
});

test('a pull request that is not the ticket branch’s, or whose branch is the base or main, is refused and nothing is closed', async () => {
  for (const [head, base] of [['someone/else', 'main'], ['main', 'main'], ['master', 'main'], ['develop', 'develop']] as const) {
    const gh = fakeGh({ state: 'OPEN', headRefName: head });
    await assert.rejects(closePullRequest(input(gh, { base, branches: [BRANCH, head] })), (error: unknown) => error instanceof PrCloseRefused);
    assert.equal(closes(gh).length, 0, `${head} is not closed`);
  }
  const gh = fakeGh({ state: 'OPEN', headRefName: 'someone/else' });
  await assert.rejects(closePullRequest(input(gh)), (error: unknown) => error instanceof PrCloseRefused);
  assert.equal(closes(gh).length, 0);
});

test('a ticket resumed on another branch: the pull request of any of its branches is closed', async () => {
  const gh = fakeGh({ state: 'OPEN', headRefName: 'cleared/DEMO-7-r2' });
  assert.equal(await closePullRequest(input(gh, { branches: ['cleared/DEMO-7-r2', BRANCH] })), 'closed');
  assert.equal(closes(gh).length, 1);
});

test('a gh that fails, or answers a shape it does not know, is an error and closes nothing', async () => {
  const failing = fakeGh(open, { fail: true });
  await assert.rejects(closePullRequest(input(failing)), /pr close/);
  const odd = fakeGh({ state: 'WHATEVER' });
  await assert.rejects(closePullRequest(input(odd)));
  assert.equal(closes(odd).length, 0);
});

test('a reason that looks like a flag or a shell line reaches gh as one argument, in the comment', async () => {
  const gh = fakeGh(open);
  const reason = '--delete-branch; rm -rf $HOME `x` "quoted"';
  await closePullRequest(input(gh, { reason }));
  const close = closes(gh)[0];
  assert.equal(close?.args.length, 7);
  assert.equal(close?.args[6], closeComment(reason, BRANCH));
  assert.notEqual(close?.args[6]?.startsWith('-'), true, 'the comment never starts like a flag');
});

// ---- the engine --------------------------------------------------------------

const release = (ticket: string, requestedAt: string, number = 101) => ({
  ticket, project: 'guestbook', title: 'Newest entry first', announcement: 'The list shows the newest entry first.', requestedAt,
  pr: { number, url: `https://example.invalid/pull/${number}`, checks: 'passed' as const }, heads: [{ pr: number, head: 'a'.repeat(40) }],
  captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
});

type Closed = { pr: number; branches: readonly string[]; reason: string; service: string | undefined };
function recording(outcome: 'closed' | 'already_closed' | 'already_merged' | Error = 'closed') {
  const seen: Closed[] = [];
  const effects: Partial<FlowEffects> = {
    async closePullRequest(request) {
      seen.push({ pr: request.pr, branches: request.branches, reason: request.reason, service: request.service?.name });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return { seen, effects };
}

test('a Close closes the pull request of the ticket’s release card with the reason, once the ticket is out of the flow', async () => {
  const forge = recording();
  const t = await setup({ effects: forge.effects });
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  await t.engine.closeTicket(t.ticket.id, '  Not needed any more.  ', 'u1');
  assert.deepEqual(forge.seen, [{ pr: 101, branches: [`cleared/${t.ticket.id}`], reason: 'Not needed any more.', service: undefined }]);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.equal(t.calls.some((c) => c.startsWith('mergeRelease')), false);
});

test('a refused Close touches no pull request: an empty reason, a done ticket, an unknown one', async () => {
  const forge = recording();
  const t = await setup({ effects: forge.effects });
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  await assert.rejects(t.engine.closeTicket(t.ticket.id, '  ', 'u1'));
  await assert.rejects(t.engine.closeTicket('NOPE-1', 'x', 'u1'));
  await t.tickets.move(t.ticket.id, 'Done', agents);
  await assert.rejects(t.engine.closeTicket(t.ticket.id, 'too late', 'u1'));
  assert.deepEqual(forge.seen, []);
});

test('a ticket with no pull request (still running, never published) closes no pull request', async () => {
  const forge = recording();
  const t = await setup({ effects: forge.effects });
  await t.engine.start(t.ticket.id, 'u1');
  await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
  assert.deepEqual(forge.seen, []);
});

test('a failure of the forge is said on the ticket and never stops the Close', async () => {
  const forge = recording(new Error('gh pr close failed: GraphQL: could not close'));
  const t = await setup({ effects: forge.effects });
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  const card = t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  const result = await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
  assert.deepEqual(result, { sessions: 0, items: 1 });
  assert.equal(t.inbox.item(card.id)?.state, 'handled');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  const last = (await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '';
  assert.match(last, /pull request #101/);
  assert.match(last, /not closed on GitHub/);
  assert.match(last, /by hand/);
});

test('a refused pull request (not the ticket branch’s) is said on the ticket too', async () => {
  const forge = recording(new PrCloseRefused('the pull request #101 is on someone/else'));
  const t = await setup({ effects: forge.effects });
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /not closed on GitHub/);
});

test('a pull request already closed or merged is not said as a failure, and the same card is not closed twice', async () => {
  for (const outcome of ['already_closed', 'already_merged'] as const) {
    const forge = recording(outcome);
    const t = await setup({ effects: forge.effects });
    await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
    t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
    await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
    assert.doesNotMatch((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /not closed on GitHub/);
  }
});

test('a Close without the forge effect (a service that has none) still closes the ticket', async () => {
  const t = await setup();
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  t.inbox.addRelease(release(t.ticket.id, new Date(t.clock.now).toISOString()));
  await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
});

test('the same pull request on two cards of the ticket is closed once', async () => {
  const forge = recording();
  const t = await setup({ effects: forge.effects });
  await t.tickets.move(t.ticket.id, 'Needs Approval', agents);
  const at = new Date(t.clock.now).toISOString();
  const first = t.inbox.addRelease(release(t.ticket.id, at));
  t.inbox.handle(first.id, 'system');                      // a card the repair handled, the pull request reused by the next
  t.inbox.addRelease(release(t.ticket.id, at));
  await t.engine.closeTicket(t.ticket.id, 'Not needed any more.', 'u1');
  assert.deepEqual(forge.seen.map((s) => s.pr), [101]);
});
