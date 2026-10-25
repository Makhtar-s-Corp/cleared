// A fake gh on PATH over a world file (fake.ts's World): it answers the
// calls the GitHub adapter makes as GitHub would, changes the world for
// create, edit and close, and records each call (its arguments, its folder,
// whether it was given a token, and the body file's text). No call reaches
// GitHub. `fail` names a call ("pr close", "api") that exits 1 instead.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../workspace/git.ts';
import type { World } from './fake.ts';

export type GhCall = { readonly args: string[]; readonly cwd: string; readonly token: boolean; readonly body: string | null };

const SCRIPT = (world: string, log: string, fail: string) => `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--body-file');
const body = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), token: Boolean(process.env.GH_TOKEN), body }) + '\\n');
const world = JSON.parse(fs.readFileSync(${JSON.stringify(world)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(world)}, JSON.stringify(world));
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = (value) => process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\\n');
const die = (text, code = 1) => { process.stderr.write(text); process.exit(code); };
if (${JSON.stringify(fail)} && args.join(' ').startsWith(${JSON.stringify(fail)})) die('HTTP 502: the forge is down');
const repo = flag('--repo');
const pull = (n) => world.pulls.find((p) => p.number === Number(n) && (repo === undefined || p.repo === repo)) || die('GraphQL: Could not resolve to a PullRequest with the number of ' + n + '.');
const STATE = { open: 'OPEN', closed: 'CLOSED', merged: 'MERGED' };
const CONCLUSION = { pass: 'SUCCESS', fail: 'FAILURE', cancel: 'CANCELLED', skipping: 'SKIPPED' };
const rollup = (p) => p.checks.map((c) => c.bucket === 'pending'
  ? { __typename: 'CheckRun', name: c.name, status: 'IN_PROGRESS', conclusion: '', detailsUrl: c.url || '' }
  : { __typename: 'CheckRun', name: c.name, status: 'COMPLETED', conclusion: CONCLUSION[c.bucket], detailsUrl: c.url || '' });
const [group, verb] = args;
if (group === 'api') {
  const endpoint = args[args.length - 1];
  const line = (r) => out(JSON.stringify({ repo: r.repo, url: r.url, base: r.base, private: r.private, archived: r.archived }));
  if (/^(user\\/repos|installation\\/repositories)\\?/.test(endpoint)) for (const r of world.repositories) line(r);
  else {
    const name = /^repos\\/(.+)$/.exec(endpoint)?.[1];
    const r = world.repositories.find((x) => x.repo === name) || die('gh: Not Found (HTTP 404)');
    out({ full_name: r.repo, clone_url: r.url, default_branch: r.base, private: r.private, archived: r.archived, description: 'not read' });
  }
} else if (group === 'pr' && verb === 'list') {
  out(world.pulls.filter((p) => p.repo === repo && p.head === flag('--head') && p.state === 'open').map((p) => ({ number: p.number, url: p.url })));
} else if (group === 'pr' && verb === 'view') {
  const p = pull(args[2]);
  const all = { body: p.body, state: STATE[p.state], headRefName: p.head, headRefOid: p.headCommit, statusCheckRollup: rollup(p) };
  out(Object.fromEntries(flag('--json').split(',').map((field) => [field, all[field]])));
} else if (group === 'pr' && verb === 'create') {
  const number = Math.max(0, ...world.pulls.filter((p) => p.repo === repo).map((p) => p.number)) + 1;
  const url = 'https://forge.invalid/' + repo + '/pull/' + number;
  world.pulls.push({ repo, number, url, base: flag('--base'), head: flag('--head'), headCommit: 'c'.repeat(40), title: flag('--title'), body, state: 'open', checks: [], comments: [] });
  save();
  out(url);
} else if (group === 'pr' && verb === 'edit') {
  pull(args[2]).body = body;
  save();
} else if (group === 'pr' && verb === 'close') {
  const p = pull(args[2]);
  p.comments.push(flag('--comment'));
  p.state = 'closed';
  save();
} else if (group === 'pr' && verb === 'checks') {
  const p = pull(args[2]);
  out(p.checks.map((c) => ({ bucket: c.bucket })));
  if (p.checks.some((c) => c.bucket === 'pending')) process.exit(8);
} else if (group === 'run' && verb === 'view') {
  const job = flag('--job');
  const check = world.pulls.flatMap((p) => p.checks).find((c) => c.url && c.url.endsWith('/job/' + job));
  if (!check || check.log === undefined) die('failed to get run log: not found');
  out(check.log);
} else die('unknown command: ' + args.join(' '), 3);
`;

export function fakeGh(world: World, options: { readonly fail?: string } = {}) {
  const root = tempDir('forge-gh');
  const bin = join(root, 'bin');
  const file = join(root, 'world.json');
  const log = join(root, 'gh.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(file, JSON.stringify(world));
  writeFileSync(join(bin, 'gh'), SCRIPT(file, log, options.fail ?? ''));
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = (): GhCall[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const now = (): World => JSON.parse(readFileSync(file, 'utf8'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return { root, env, calls, world: now };
}
