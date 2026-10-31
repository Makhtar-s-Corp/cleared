// The token step once GitHub has the token (issues #503 and #506): what it may do
// on the repository picked there, in one sentence, with the rights behind "Voir
// le détail". Every word from the catalogs, both languages.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { StepView } from '../../../../src/setup/types.ts';
import { setupTranslator, refusal } from '../../screens/setup/model.ts';
import { accessFailed, accessLine, ForgeStep } from '../../screens/setup/steps/Forge.tsx';
import { html, visibleText } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({}), post: async () => ({ status: 200, body: {} }) } as never;
const step: StepView = { id: 'forge', state: 'done', filled: true, skippable: false, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 };
const SAVED = { set: true, at: '2026-10-31T10:00:00.000Z', source: 'assistant' } as const;
const REPO = 'exemple-org/livre-or';
const drawn = (t: typeof fr, contents: 'ok' | 'refused' | 'unknown', pullRequests: 'ok' | 'refused' | 'unknown', repositories: readonly string[] = [REPO]) =>
  html(<ForgeStep t={t} step={step} api={api} onDone={noop} initial={{ credential: SAVED, repositories, access: { repository: REPO, contents, pullRequests } }} />);

test('a token that cannot write: one sentence that names the repository and what to change, in French and in English', () => {
  for (const [t, words] of [[fr, /sur GitHub/], [en, /on GitHub/]] as const) {
    for (const access of [{ contents: 'refused', pullRequests: 'refused' }, { contents: 'refused', pullRequests: 'ok' }, { contents: 'ok', pullRequests: 'refused' }] as const) {
      const line = accessLine(t, { repository: REPO, ...access });
      assert.match(line, words);
      assert.ok(line.includes(REPO));
      assert.equal(line.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, `one sentence: ${line}`);
      assert.doesNotMatch(line, /⟦|\u2014/);
    }
  }
  assert.notEqual(accessLine(fr, { repository: REPO, contents: 'refused', pullRequests: 'ok' }), accessLine(fr, { repository: REPO, contents: 'ok', pullRequests: 'refused' }), 'it says which right is missing');
});

test('refused: the sentence is an alert and the rights are in the fold, each with what GitHub answered', () => {
  const markup = drawn(fr, 'refused', 'ok');
  assert.match(markup, /role="alert"[^>]*data-forge-access="refused"|data-forge-access="refused"[^>]*role="alert"/);
  const [front, fold] = markup.split('<details');
  assert.ok(front?.includes(REPO));
  assert.doesNotMatch(front ?? '', /Contents/, 'the permission\'s name stays in the fold');
  assert.match(fold ?? '', /data-access-right="contents"[^]*Refusé/);
  assert.match(fold ?? '', /data-access-right="pull_requests"[^]*Accordé/);
  assert.match(markup, /data-act="setup_forge_access"/);
  assert.ok(accessFailed({ repository: REPO, contents: 'refused', pullRequests: 'ok' }));
});

test('both rights: the step says so, plainly, and asks for nothing', () => {
  const markup = drawn(fr, 'ok', 'ok');
  assert.match(markup, /data-forge-access="ok"/);
  assert.ok(visibleText(markup).join(' ').includes(REPO));
  assert.doesNotMatch(markup, /data-act="setup_forge_access"/);
  assert.ok(!accessFailed({ repository: REPO, contents: 'ok', pullRequests: 'ok' }));
});

test('GitHub did not answer: never said as a refusal, and it can be asked again', () => {
  const markup = drawn(fr, 'unknown', 'ok');
  assert.match(markup, /data-forge-access="unknown"/);
  assert.doesNotMatch(markup, /data-forge-access="refused"/);
  assert.match(markup, /data-act="setup_forge_access"/);
});

test('several repositories: a labelled list to pick from; one: no list', () => {
  const several = drawn(fr, 'ok', 'ok', [REPO, 'exemple-org/autre']);
  assert.match(several, /<label[^>]*for="setup-forge-repository"/);
  assert.match(several, /<select[^>]*id="setup-forge-repository"/);
  assert.doesNotMatch(drawn(fr, 'ok', 'ok'), /<select/);
});

test('the workspace step\'s refusal names the repository, in both languages', () => {
  for (const t of [fr, en]) {
    const said = refusal(t, 'workspace', { error: 'cannot_write', repository: REPO });
    assert.ok(said.includes(REPO), said);
    assert.doesNotMatch(said, /⟦|\{repository\}/);
  }
});
