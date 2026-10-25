// Cleared never deploys (P218, issue #334, and B3.5): a release is merged
// by the lock after the human's approval, and the deploy is the human's or
// their CI's. Cleared only reads what was deployed (the release watch's
// health check, the production page's capture). This test fails if any of
// these grows a deploy action: a route of a module, an effect of the flow,
// or a command of the service's code that starts a deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { realEffects } from '../../src/flow/effects.ts';
import approval from '../../src/modules/approval.ts';
import flow from '../../src/modules/flow.ts';
import inbox from '../../src/modules/inbox.ts';
import knowledge from '../../src/modules/knowledge.ts';
import lead from '../../src/modules/lead.ts';
import notify from '../../src/modules/notify.ts';
import sessions from '../../src/modules/sessions.ts';
import tickets from '../../src/modules/tickets.ts';
import users from '../../src/modules/users.ts';
import { API_ROUTES } from '../../src/api/types.ts';
import { CONFIG } from './support.ts';

const DEPLOY = /deploy|rollout|ship[-_]?it|promote/i;

test('no route of any module, and no route of the API, deploys', () => {
  const routes = [approval, flow, inbox, knowledge, lead, notify, sessions, tickets, users].flatMap((m) => m.routes.map((r) => `${r.method} ${r.path}`));
  assert.ok(routes.length > 50, 'the modules were read');
  assert.deepEqual(routes.filter((route) => DEPLOY.test(route)), []);
  assert.deepEqual(API_ROUTES.filter((route) => DEPLOY.test(route)), []);
  // What the post-deploy check adds is two reads.
  assert.ok(routes.includes('GET /api/tickets/:id/production'));
  assert.ok(!routes.some((route) => /production/.test(route) && !route.startsWith('GET ')));
});

test('no effect of the flow deploys: what it does outside the process is git, the forge, the lock and a browser that reads', () => {
  const effects = realEffects(CONFIG, { env: {} });
  const names = Object.keys(effects);
  assert.ok(names.includes('mergeRelease') && names.includes('captureProduction'));
  assert.deepEqual(names.filter((name) => DEPLOY.test(name)), []);
});

// The commands that start a deploy on the usual hosts and CIs. The service's
// code names none of them: it runs git, gh for pull requests and checks, the
// lock's scripts, docker for its own sessions, and Playwright.
const COMMANDS: readonly RegExp[] = [
  /['"`]workflow['"`]\s*,\s*['"`]run['"`]/, /gh workflow run/, /workflow_dispatch/, /\/dispatches\b/, /\/deployments\b/,
  /kubectl/, /\bhelm\b/, /\bvercel\b/, /\bnetlify\b/, /\bflyctl\b/, /\bfly\s+deploy\b/, /\bheroku\b/, /\brailway\s+up\b/, /\bwrangler\b/,
  /terraform\s+apply/, /\bpulumi\b/, /\bansible-playbook\b/, /\bcapistrano\b/, /gcloud\s+(app|run|functions)\s+deploy/, /aws\s+(ecs|lambda|s3\s+sync|deploy)/,
  /firebase\s+deploy/, /serverless\s+deploy/, /\bdocker['"`]?\s*,?\s*['"`]?push\b/, /['"`]push['"`]\s*,\s*['"`]--force/,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

test('the service\'s code runs no deploy command', () => {
  const root = join(import.meta.dirname, '..', '..');
  const files = [...sources(join(root, 'src')), ...sources(join(root, 'app', 'src'))];
  assert.ok(files.length > 100, 'the sources were read');
  const found = files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return COMMANDS.filter((command) => command.test(text)).map((command) => `${file.slice(root.length + 1)}: ${command}`);
  });
  assert.deepEqual(found, []);
});
