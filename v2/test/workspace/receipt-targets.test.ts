// What a proof receipt's captures need of a service (issue #505): the address of
// what its base runs and how a trial of it runs. Found in the repository when it
// says them, and written to the workspace file once a person confirms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectReceiptTargets, withReceiptTargets } from '../../src/workspace/receipt-targets.ts';
import { project } from '../container/prepared-fixture.ts';

const CONF = '[merge]\nverdict = no blocking issues\n\n[release]\nhealth_url = https://exemple.org/health\n';

test('found in the repository: the release\'s address, and the Dockerfile\'s first port', async () => {
  const made = project({ '.cleared/agents.conf': CONF, Dockerfile: 'FROM node:24\nEXPOSE 8793/tcp\nEXPOSE 9000\n' });
  assert.deepEqual(await detectReceiptTargets(made.source), { healthUrl: 'https://exemple.org/health', run: 'Dockerfile:8793' });
});

test('nothing said: nothing proposed, and never a made-up value', async () => {
  assert.deepEqual(await detectReceiptTargets(project({ Dockerfile: 'FROM node:24\n' }).source), { healthUrl: null, run: null });
  assert.deepEqual(await detectReceiptTargets(project({}).source), { healthUrl: null, run: null });
  const unusable = project({ '.cleared/agents.conf': '[release]\nhealth_url = not an address\n', Dockerfile: 'FROM node:24\nEXPOSE $PORT\n' });
  assert.deepEqual(await detectReceiptTargets(unusable.source), { healthUrl: null, run: null });
});

test('a folder of a monorepo: its own Dockerfile and its own settings first', async () => {
  const made = project({ '.cleared/agents.conf': CONF, 'web/.cleared/agents.conf': '[release]\nhealth_url = https://web.exemple.org/health\n', 'web/Dockerfile': 'FROM node:24\nEXPOSE 3000\n', Dockerfile: 'FROM node:24\nEXPOSE 9999\n' }, 'web');
  assert.deepEqual(await detectReceiptTargets(made.source), { healthUrl: 'https://web.exemple.org/health', run: 'Dockerfile:3000' });
});

test('a base that cannot be read proposes nothing', async () => {
  assert.deepEqual(await detectReceiptTargets({ dir: '/nowhere', base: 'main', path: null }), { healthUrl: null, run: null });
});

const FILE = '[workspace]\nid = demo\n\n[service web]\nkind = repository\nrepository = o/web\nhealth_url = http://old/health\n\n[service api]\nrepository = o/api\n';

test('written in its service\'s section, the old value replaced, the others untouched', () => {
  const text = withReceiptTargets(FILE, 'web', { healthUrl: 'https://exemple.org/health', run: 'Dockerfile:3000' });
  assert.ok(!text.includes('http://old/health'));
  const web = text.slice(text.indexOf('[service web]'), text.indexOf('[service api]'));
  assert.match(web, /health_url = https:\/\/exemple\.org\/health/);
  assert.match(web, /run = Dockerfile:3000/);
  assert.ok(text.endsWith('[service api]\nrepository = o/api\n'), text);
});

test('an empty value takes its key out', () => {
  const text = withReceiptTargets(FILE, 'web', { healthUrl: null, run: null });
  assert.doesNotMatch(text, /health_url|run =/);
});

test('a value cannot add a line to the file', () => {
  assert.throws(() => withReceiptTargets(FILE, 'web', { healthUrl: 'https://x/\n[service evil]', run: null }));
  assert.throws(() => withReceiptTargets(FILE, 'web', { healthUrl: null, run: 'Dockerfile:1\nforge = x' }));
});

test('a service the file does not hold is refused', () => {
  assert.throws(() => withReceiptTargets(FILE, 'other', { healthUrl: null, run: null }));
});
