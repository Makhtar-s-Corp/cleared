import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARD_PATTERNS, HANDOVER_HEADINGS, hooks, hooksFor, type HookCallback } from '../../images/session/runner/hooks.ts';
import { commit, gitIn, plantedKey, tempDir } from '../workspace/git.ts';

const signal = new AbortController().signal;

function callback(event: string): HookCallback {
  const matchers = hooks[event];
  assert.ok(matchers && matchers.length === 1, `one ${event} matcher`);
  const [matcher] = matchers;
  assert.equal(matcher?.hooks.length, 1);
  return matcher!.hooks[0]!;
}

// A session's checkout, as ticketCheckout leaves it: the base marked by
// refs/cleared/base, the ticket branch checked out.
function sessionRepo(): string {
  const dir = tempDir('runner');
  gitIn(dir, ['init', '-q', '-b', 'main']);
  commit(dir, { 'README.md': '# Demo\n' }, 'first commit');
  gitIn(dir, ['update-ref', 'refs/cleared/base', 'HEAD']);
  gitIn(dir, ['checkout', '-q', '-b', 'cleared/DEMO-7']);
  return dir;
}

const base = (cwd: string) => ({ session_id: 's1', transcript_path: '/tmp/t.jsonl', cwd });
const bash = (cwd: string, command: string) => ({ ...base(cwd), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu1' });
const decision = (output: Record<string, unknown>) => (output.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;

test('the runner hooks are a PreToolUse hook on Bash and a Stop hook', () => {
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'Stop']);
  assert.equal(hooks.PreToolUse?.[0]?.matcher, 'Bash');
});

test('the Stop hook is an author\'s only: a reviewer cannot write HANDOVER.md and a lead hands over with its tool (issue 139)', () => {
  assert.equal(hooksFor('author'), hooks);
  for (const role of ['reviewer', 'lead']) {
    const set = hooksFor(role);
    assert.deepEqual(Object.keys(set), ['PreToolUse'], role);
    assert.equal(set.PreToolUse, hooks.PreToolUse, role);
  }
  // A run of its own keeps the role's choice.
  assert.deepEqual(Object.keys(hooksFor('lead', async () => '')), ['PreToolUse']);
  assert.deepEqual(Object.keys(hooksFor('author', async () => '')).sort(), ['PreToolUse', 'Stop']);
});

test('a git push to the base branch is blocked, in every form', async () => {
  const pre = callback('PreToolUse');
  const cwd = sessionRepo();
  for (const command of [
    'git push origin main', 'git push origin HEAD:main', 'git push origin HEAD:refs/heads/main', 'git push origin +main',
    'git -C . push origin main', 'git -c push.default=current push', 'cd src && git push origin main', 'npm test; git push',
    'git --git-dir=.git push origin main', 'sh -c "git push origin main"', 'env GIT_TRACE=1 git push', 'git push --force origin cleared/DEMO-7',
  ]) {
    const output = await pre(bash(cwd, command), 'tu1', { signal });
    assert.equal(decision(output), 'deny', command);
    assert.match(String((output.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason), /host/);
  }
});

test('other commands pass the push rule untouched', async () => {
  const pre = callback('PreToolUse');
  const cwd = sessionRepo();
  for (const command of ['git status', 'git commit -m "push the fix"', 'git log --grep push', 'npm test', 'git branch --show-current'])
    assert.deepEqual(await pre(bash(cwd, command), 'tu1', { signal }), {}, command);
});

test('gh pr create passes when the guard finds nothing in the diff', async () => {
  const pre = callback('PreToolUse');
  const cwd = sessionRepo();
  commit(cwd, { 'src/app.ts': 'export const order = "newest";\n' }, 'Newest first');
  assert.deepEqual(await pre(bash(cwd, 'gh pr create --base main --title "Newest first" --body "Sorted."'), 'tu1', { signal }), {});
});

test('gh pr create is blocked when the guard flags the diff, without repeating the value', async () => {
  const pre = callback('PreToolUse');
  const cwd = sessionRepo();
  commit(cwd, { 'src/settings.ts': `export const apiKey = "${plantedKey}";\n` }, 'Settings');
  const output = await pre(bash(cwd, 'gh pr create --fill'), 'tu1', { signal });
  assert.equal(decision(output), 'deny');
  const reason = String((output.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason);
  assert.match(reason, /guard/);
  assert.match(reason, /API key/);
  assert.ok(!reason.includes(plantedKey));
});

test('gh pr create is blocked when a commit added a secret that a later commit removed', async () => {
  const pre = callback('PreToolUse');
  const cwd = sessionRepo();
  commit(cwd, { 'src/settings.ts': `export const apiKey = "${plantedKey}";\n` }, 'Settings');
  commit(cwd, { 'src/settings.ts': 'export const apiKey = process.env.API_KEY;\n' }, 'Key from the environment');
  const output = await pre(bash(cwd, 'gh pr create --fill'), 'tu1', { signal });
  assert.equal(decision(output), 'deny');
  const reason = String((output.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason);
  assert.match(reason, /API key/);
  assert.ok(!reason.includes(plantedKey));
});

test('gh pr create is blocked when its own text or a commit message carries a secret', async () => {
  const pre = callback('PreToolUse');
  const inCommand = sessionRepo();
  commit(inCommand, { 'src/app.ts': 'export const x = 1;\n' }, 'Clean');
  assert.equal(decision(await pre(bash(inCommand, `gh pr create --body "key ${plantedKey}"`), 'tu1', { signal })), 'deny');
  const inMessage = sessionRepo();
  commit(inMessage, { 'src/app.ts': 'export const x = 1;\n' }, `Use ${plantedKey}`);
  assert.equal(decision(await pre(bash(inMessage, 'gh pr create --fill'), 'tu1', { signal })), 'deny');
});

test('gh pr create is blocked when the diff cannot be read: the guard fails closed', async () => {
  const pre = callback('PreToolUse');
  const cwd = tempDir('no-repo');
  assert.equal(decision(await pre(bash(cwd, 'gh pr create --fill'), 'tu1', { signal })), 'deny');
});

test('a session that stops without HANDOVER.md is asked for it once, with the five headings', async () => {
  const stop = callback('Stop');
  const cwd = sessionRepo();
  const first = await stop({ ...base(cwd), hook_event_name: 'Stop', stop_hook_active: false }, undefined, { signal });
  assert.equal(first.decision, 'block');
  const reason = String(first.reason);
  for (const heading of HANDOVER_HEADINGS) assert.ok(reason.includes(heading), heading);
  // The model stopped again after being asked: it is not asked a second time.
  assert.deepEqual(await stop({ ...base(cwd), hook_event_name: 'Stop', stop_hook_active: true }, undefined, { signal }), {});
  writeFileSync(join(cwd, 'HANDOVER.md'), HANDOVER_HEADINGS.join('\n\n'));
  assert.deepEqual(await stop({ ...base(cwd), hook_event_name: 'Stop', stop_hook_active: false }, undefined, { signal }), {});
});

test('the handover headings are those lib/memory checks, in its order', () => {
  const memory = readFileSync(new URL('../../../lib/memory/adapters/local.ts', import.meta.url), 'utf8');
  assert.ok(memory.includes(`const HEADINGS = [${HANDOVER_HEADINGS.map((h) => `'${h}'`).join(', ')}];`));
});

test('the hook keeps the guard patterns word for word (lib/guard/codex-guard.ts)', () => {
  const guard = readFileSync(new URL('../../../lib/guard/codex-guard.ts', import.meta.url), 'utf8');
  assert.equal(GUARD_PATTERNS.length, 10);
  for (const [category, pattern] of GUARD_PATTERNS) {
    assert.ok(guard.includes(`/${pattern.source}/${pattern.flags}`), `${category}: /${pattern.source}/${pattern.flags} is not in the guard`);
    assert.ok(guard.includes(`"${category}"`), `${category} is not a category of the guard`);
  }
});

test('the hook file imports nothing but Node built-ins: the image copies it alone', () => {
  const source = readFileSync(new URL('../../images/session/runner/hooks.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.match(name as string, /^node:/);
});
