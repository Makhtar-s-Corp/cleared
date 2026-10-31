// A publication that fails after a review that passed (issue #507): what the
// error says is read into a code, journaled on the reviewer's session so that the
// screen can say it in the person's words, with the cleaned reason for the fold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishFailureCode, publishHint, PUBLISH_FAILURES } from '../../src/flow/publish-failure.ts';
import { PublishError, PublishRefused } from '../../src/workspace/publish.ts';
import { quickAuthor, setup, until } from './support.ts';

const REFUSED = "git push failed in /srv/x: remote: Permission to exemple-org/livre-or.git/ denied to exemple-compte. fatal: unable to access 'https://github.com/exemple-org/livre-or.git/': The requested URL returned error: 403";

test('each cause is told apart from the words git and the forge use', () => {
  assert.equal(publishFailureCode(new Error(REFUSED)), 'token_denied');
  assert.equal(publishFailureCode(new Error('fatal: Authentication failed for https://github.com/x.git')), 'token_denied');
  assert.equal(publishFailureCode(new Error("! [rejected] cleared/LOCAL-1 -> cleared/LOCAL-1 (non-fast-forward) error: failed to push some refs")), 'branch_taken');
  assert.equal(publishFailureCode(new Error('! [rejected] (fetch first)')), 'branch_taken');
  assert.equal(publishFailureCode(new Error("fatal: unable to access 'https://github.com/x.git/': Could not resolve host: github.com")), 'network');
  assert.equal(publishFailureCode(new PublishError('cleared/LOCAL-1 is pushed, but gh pr create failed: HTTP 403')), 'pull_request');
  assert.equal(publishFailureCode(new PublishRefused('guard', 'the guard refuses it')), 'guard');
  assert.equal(publishFailureCode(new PublishRefused('empty', 'no commit of its own')), 'no_commit');
  assert.equal(publishFailureCode(new PublishRefused('generated', 'HANDOVER.md')), 'generated');
  assert.equal(publishFailureCode(new PublishRefused('unsafe', 'cannot be read safely')), 'unsafe');
  assert.equal(publishFailureCode(new PublishRefused('base', 'the base branch')), 'unsafe');
  assert.equal(publishFailureCode(new Error('something else')), 'other');
  assert.ok(PUBLISH_FAILURES.includes('other'));
});

test('the note on the ticket names the token, not the account, when GitHub refuses the push (issue #506)', () => {
  assert.match(publishHint('token_denied'), /token/);
  assert.match(publishHint('token_denied'), /Contents/);
  assert.match(publishHint('branch_taken'), /never forced|not forced/);
  assert.equal(publishHint('other'), '');
});

test('a refused push: the failure is journaled on the reviewer\'s session, cleaned, and the ticket goes back to Todo with its reason', async () => {
  const t = await setup({
    scripts: { author: quickAuthor },
    clean: (text) => text.replace('/srv/x', '[removed: service path]'),
    effects: { async publish() { throw new Error(REFUSED); } },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo' && t.flowEvents.some((event) => event.type === 'ticket_put_back'), 'the ticket back in Todo', 5000);
  await t.engine.settled();
  const reviewer = t.startedSessions.find((one) => one.input.role === 'reviewer')?.id as string;
  const journaled = t.store.events.after(reviewer).map((stored) => stored.event).filter((event) => event.type === 'CUSTOM' && event.name === 'cleared.publish_failed');
  assert.equal(journaled.length, 1);
  const { value } = journaled[0] as { value: { code: string; detail: string; service: string | null } };
  assert.equal(value.code, 'token_denied');
  assert.equal(value.service, null);
  assert.ok(value.detail.includes('[removed: service path]') && !value.detail.includes('/srv/x'), value.detail);
  const put = t.flowEvents.find((event) => event.type === 'ticket_put_back');
  assert.match(JSON.stringify(put), /the token/);
});
