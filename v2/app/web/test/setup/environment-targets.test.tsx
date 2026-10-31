// The receipt's addresses on the environment step (issue #505): what Cleared found
// in the repository, for the owner to confirm or correct; what the receipt will
// then be able to show, in a sentence. Both languages, every word from the catalogs.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { EnvironmentService, EnvironmentView } from '../../../../src/container/types.ts';
import { setupTranslator } from '../../screens/setup/model.ts';
import { EnvironmentStep, receiptLine } from '../../screens/setup/steps/Environment.tsx';
import { html } from '../render.tsx';

const en = setupTranslator('en');
const fr = setupTranslator('fr');
const noop = () => undefined;
const api = { get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) } as never;
const step = { id: 'environment', state: 'todo', filled: true, skippable: true, shownAt: null, doneAt: null, skippedAt: null, personMs: 0, machineMs: 0 } as const;
const service = (proof: EnvironmentService['proof']): EnvironmentService => ({
  name: 'api', readable: true, devcontainer: 'image', foreignImage: null, install: 'npm ci', state: 'ready', image: 'x', builtAt: '2026-10-25T20:00:00.000Z', buildMs: 1000, startedAt: null, error: null, checkCommand: null, check: null, proposal: null, setupTicket: null, ...(proof ? { proof } : {}),
});
const drawn = (t: typeof fr, proof: EnvironmentService['proof']) => {
  const initial: EnvironmentView = { workspace: true, sessions: 'ready', services: [service(proof)] };
  return html(<EnvironmentStep t={t} step={step as never} api={api} onDone={noop} initial={initial} />);
};
const FOUND = { healthUrl: 'https://exemple.org/health', run: 'Dockerfile:8793' };

test('found in the repository and not saved: prefilled, labelled, and it asks for a confirmation', () => {
  for (const t of [fr, en]) {
    const markup = drawn(t, { healthUrl: null, run: null, detected: FOUND });
    assert.doesNotMatch(markup, /⟦/);
    assert.match(markup, /data-targets="proposed"/);
    assert.match(markup, /<label[^>]*for="setup-targets-url-api"/);
    assert.match(markup, /<label[^>]*for="setup-targets-run-api"/);
    assert.match(markup, /value="https:\/\/exemple\.org\/health"/);
    assert.match(markup, /value="Dockerfile:8793"/);
    assert.match(markup, /data-act="setup_targets_save"/);
  }
  assert.match(drawn(fr, { healthUrl: null, run: null, detected: FOUND }), /Confirmer/);
});

test('nothing found: the fields are empty, and it says the receipt will have no captures', () => {
  const markup = drawn(fr, { healthUrl: null, run: null, detected: { healthUrl: null, run: null } });
  assert.match(markup, /data-targets="missing"/);
  assert.match(markup, /sans capture/i);
  assert.match(markup, /data-act="setup_targets_save"/);
});

test('saved: a sentence says what the receipt will show, and the form waits behind a gesture', () => {
  const markup = drawn(fr, { ...FOUND, detected: FOUND });
  assert.match(markup, /data-targets="saved"/);
  assert.doesNotMatch(markup, /data-act="setup_targets_save"/);
  assert.match(markup, /data-act="setup_targets_change"/);
});

test('the sentence says what is true of each capture', () => {
  for (const t of [fr, en]) {
    const both = receiptLine(t, { healthUrl: 'https://x/', run: 'Dockerfile:1' });
    const before = receiptLine(t, { healthUrl: 'https://x/', run: null });
    const after = receiptLine(t, { healthUrl: null, run: 'Dockerfile:1' });
    const none = receiptLine(t, { healthUrl: null, run: null });
    assert.equal(new Set([both, before, after, none]).size, 4);
    for (const line of [both, before, after, none]) assert.doesNotMatch(line, /⟦|\u2014/);
  }
});

test('the fields are never indigo: the step\'s one primary action stays its own', () => {
  const markup = drawn(fr, { healthUrl: null, run: null, detected: FOUND });
  assert.doesNotMatch(/data-act="setup_targets_save"[^>]*/.exec(markup)?.[0] ?? '', /primary/);
});
