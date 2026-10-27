// Issue #431: before the assistant connected a repository the service runs
// no tickets and answers 503. The Tower and the Inbox then say the setup is
// not finished and point to /setup, instead of an error; and the setup page
// offers the language choice the shell's menu offers.
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { json } from '../lib/api.ts';
import { ApiError } from '../lib/screen.ts';
import { SetupPending, setupPending } from '../lib/setup-pending.tsx';
import { setupTranslator } from '../screens/setup/model.ts';
import { LanguageChoice } from '../screens/setup/Setup.tsx';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../lib/i18n.ts';
import { html, visibleText } from './render.tsx';

afterEach(() => { vi.unstubAllGlobals(); });

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

test('a refusal keeps the service\'s reason beside its status', async () => {
  vi.stubGlobal('fetch', answer(503, { error: 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md' }));
  const error = await json('/api/service/inbox').catch((caught: unknown) => caught);
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 503);
  assert.equal(error.reason, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 502 })));
  const bare = await json('/api/service/inbox').catch((caught: unknown) => caught);
  assert.ok(bare instanceof ApiError);
  assert.equal(bare.reason, undefined);
});

test('the setup is pending when the service answers 503, not while the app waits for the service to start, nor on another error', () => {
  assert.equal(setupPending(new ApiError(503, '/api/service/inbox: 503', 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md')), true);
  assert.equal(setupPending(new ApiError(503, '/api/service/inbox: 503', 'service_starting')), false);
  assert.equal(setupPending(new ApiError(502, '/api/service/inbox: 502')), false);
  assert.equal(setupPending(new ApiError(401, '/api/service/inbox: 401')), false);
  assert.equal(setupPending(new Error('offline')), false);
});

test('the pending setup is said in words and links to the assistant, in both languages', () => {
  for (const language of ['en', 'fr'] as const) {
    const t = translator(loadCatalog('shell', language));
    const markup = html(<SetupPending t={t} />);
    assert.doesNotMatch(markup, /⟦/, `${language}: no missing key`);
    assert.match(markup, /<a [^>]*href="\/setup"/);
    assert.doesNotMatch(markup, /role="alert"/, 'not an error');
    const text = visibleText(markup).join(' ');
    assert.doesNotMatch(text, /CLEARED_V2_|README/, 'no setting name nor file for a newcomer');
  }
});

test('the setup page offers both languages, each named in itself, the page\'s pressed', () => {
  for (const language of ['en', 'fr'] as const) {
    const markup = html(<LanguageChoice t={setupTranslator(language)} language={language} onLanguage={() => undefined} />);
    assert.doesNotMatch(markup, /⟦/);
    assert.match(markup, /role="group"/);
    assert.match(markup, /lang="en"[^>]*>English</);
    assert.match(markup, /lang="fr"[^>]*>Français</);
    assert.match(markup, new RegExp(`data-language="${language}"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-language="${language}"`));
  }
});
