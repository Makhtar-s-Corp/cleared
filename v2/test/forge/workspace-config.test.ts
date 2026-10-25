// The `forge` key of a service in the workspace file (milestone 5 plan,
// decision 10): github by default, the only forge until GitLab's adapter
// (section 11); never shown by GET /api/workspace, whose types are not
// changed by milestone 5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkspace, parseWorkspace, publicWorkspace, WorkspaceError } from '../../src/workspace/config.ts';
import { forgeKindOf } from '../../src/forge/index.ts';

const options = { file: '/srv/workspace.conf', authorModel: 'claude-opus-5-5', stateDir: '/srv/state' };
const file = (extra = '') => `[workspace]\nid = guestbook\n\n[service guestbook]\nrepository = example/guestbook\nurl = https://github.com/example/guestbook.git\n${extra}`;

test('a service with no forge key is on GitHub, and `forge = github` says the same', () => {
  const [plain] = parseWorkspace(file(), options).services;
  const [named] = parseWorkspace(file('forge = github\n'), options).services;
  assert.equal(plain?.forge, 'github');
  assert.equal(named?.forge, 'github');
  assert.equal(forgeKindOf(plain), 'github');
});

test('a forge Cleared has no adapter for is refused, and the message names the ones it has', () => {
  for (const forge of ['gitlab', 'GitHub', 'bitbucket', ''])
    assert.throws(() => parseWorkspace(file(`forge = ${forge}\n`), options), (error: unknown) =>
      error instanceof WorkspaceError && /\[service guestbook\] forge is github/.test(error.message), forge);
});

test('the one-service workspace of the milestone 1 variables is on GitHub', () => {
  const workspace = loadWorkspace({
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO: 'example/guestbook', CLEARED_V2_REPO_URL: 'https://github.com/example/guestbook.git',
  }, options);
  assert.equal(workspace?.services[0]?.forge, 'github');
});

test('GET /api/workspace does not show the forge key', () => {
  const shown = publicWorkspace(parseWorkspace(file('forge = github\n'), options));
  assert.equal('forge' in (shown.services[0] ?? {}), false);
});
