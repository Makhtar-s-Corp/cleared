// Whether a ticket's change needs captures before and after (issue #368,
// matrix P226, after P210): only when the diff changes something a person
// sees (components, styles, displayed words and their catalogs, page
// routes, templates); none for a change of the backend alone, of tests, of
// CI or of docs. The human's choice on the ticket wins over the rule. A
// pure function of the diff's paths, as the pull request shows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNeed, screensOf, visiblePath } from '../../src/flow/capture-need.ts';

test('what a person sees: components, styles, catalogs, page routes, templates and the assets a page draws', () => {
  for (const path of [
    'app/web/screens/inbox/Inbox.tsx',
    'app/web/components/ui/button.tsx',
    'app/web/styles/app.css',
    'src/styles/theme.scss',
    'app/messages/session.fr.json',
    'src/locales/fr.json',
    'src/i18n/en.yaml',
    'po/fr.po',
    'src/pages/about.ts',
    'src/routes/settings/+page.svelte',
    'src/app/billing/page.tsx',
    'src/components/Card.vue',
    'templates/email.hbs',
    'views/list.ejs',
    'public/index.html',
    'public/logo.svg',
    'static/fonts/inter.woff2',
    // The guestbook's only page is a plain TypeScript file named page.
    'src/page.ts',
    'examples/guestbook/src/page.ts',
  ]) assert.equal(visiblePath(path), true, path);
});

test('what no person sees: the backend, tests, CI, docs and the files around them', () => {
  for (const path of [
    'src/flow/engine.ts',
    'examples/guestbook/src/server.ts',
    'examples/guestbook/src/store.ts',
    'src/routes/api/users.ts',
    'src/pages/api/users.ts',
    'src/routes/feed/+page.server.ts',
    'test/flow/engine.test.ts',
    'app/web/test/session/render.test.tsx',
    'src/components/Card.test.tsx',
    'src/components/Card.spec.ts',
    'src/components/Card.stories.tsx',
    'src/components/__snapshots__/Card.test.tsx.snap',
    'test/fixtures/page.html',
    'e2e/login.spec.ts',
    '.github/workflows/checks.yml',
    '.gitlab-ci.yml',
    'docs/v2/decisions-log.md',
    'docs/images/screen.png',
    'README.md',
    'app/DESIGN.md',
    'CHANGELOG',
    'package.json',
    'package-lock.json',
    '.cleared/agents.conf',
    'Dockerfile',
    'migrations/0003_entries.sql',
  ]) assert.equal(visiblePath(path), false, path);
});

test('the screens a change touches are named: a screen\'s folder, a catalog\'s screen, else the file', () => {
  assert.deepEqual(screensOf([
    'app/web/screens/inbox/Inbox.tsx',
    'app/web/screens/inbox/inbox.css',
    'app/messages/session.fr.json',
    'app/web/screens/session/Session.tsx',
    'app/web/styles/app.css',
    'src/pages/about.tsx',
    'src/flow/engine.ts',
    'test/flow/engine.test.ts',
  ]), ['inbox', 'session', 'app.css', 'about']);
  assert.deepEqual(screensOf(['examples/guestbook/src/page.ts', 'examples/guestbook/src/server.ts']), ['page.ts']);
  assert.deepEqual(screensOf(['src/flow/engine.ts', 'README.md']), []);
});

test('a visible change needs captures, and names its screens', () => {
  assert.deepEqual(captureNeed(['app/web/screens/inbox/Inbox.tsx', 'src/flow/engine.ts']), { take: true, reason: 'screens', screens: ['inbox'] });
  assert.deepEqual(captureNeed(['examples/guestbook/src/page.ts', 'examples/guestbook/test/page.test.ts']), { take: true, reason: 'screens', screens: ['page.ts'] });
});

test('a change of the backend, the tests, CI or the docs alone needs none, and says no screen changed', () => {
  assert.deepEqual(captureNeed(['src/flow/engine.ts', 'test/flow/engine.test.ts']), { take: false, reason: 'no_screen', screens: [] });
  assert.deepEqual(captureNeed(['.github/workflows/v2.yml']), { take: false, reason: 'no_screen', screens: [] });
  assert.deepEqual(captureNeed(['docs/v2/decisions-log.md', 'README.md']), { take: false, reason: 'no_screen', screens: [] });
  assert.deepEqual(captureNeed([]), { take: false, reason: 'no_screen', screens: [] });
});

test('the human\'s choice on the ticket wins over the rule, both ways', () => {
  assert.deepEqual(captureNeed(['src/flow/engine.ts'], 'on'), { take: true, reason: 'forced_on', screens: [] });
  assert.deepEqual(captureNeed(['app/web/screens/inbox/Inbox.tsx'], 'off'), { take: false, reason: 'forced_off', screens: ['inbox'] });
  assert.deepEqual(captureNeed(['app/web/screens/inbox/Inbox.tsx'], 'on'), { take: true, reason: 'forced_on', screens: ['inbox'] });
  assert.deepEqual(captureNeed(['src/flow/engine.ts'], 'auto'), { take: false, reason: 'no_screen', screens: [] });
});

test('a diff that could not be read takes the captures, unless the human turned them off', () => {
  assert.deepEqual(captureNeed(undefined), { take: true, reason: 'unread', screens: [] });
  assert.deepEqual(captureNeed(undefined, 'off'), { take: false, reason: 'forced_off', screens: [] });
  assert.deepEqual(captureNeed(undefined, 'on'), { take: true, reason: 'forced_on', screens: [] });
});
