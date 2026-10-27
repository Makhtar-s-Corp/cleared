// The v2 docs say where each feature is (lane `j3-docs-slop`, matrix P221):
// a developer reads v2/README.md first, then docs/adapters.md for the
// harnesses and docs/fast-lane.md for the fast lane. Each feature of
// milestone 3's ten ideas, the fast lane and the skills has its section
// there, naming the file that holds it; and a message that sends the reader
// to v2/README.md for a setting finds that setting there.
//
// A newcomer's pages (lane `v2-j5-docs`, docs/v2/milestone-5-plan.md
// section 15, B6.5): the root README.md, then docs/install.md (the one
// command and the assistant's steps), docs/troubleshooting.md (each line of
// `cleared doctor` that is not green, quoted from its catalog) and
// docs/run.md (`cleared run` and its API). Each names what it documents,
// every link and capture it shows is in the repository, and its prose keeps
// the catalogs' wording rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { READY_CHECKS } from '../src/doctor/ready.ts';
import { RUN_STATES } from '../src/run/types.ts';
import { STEPS } from '../src/setup/steps.ts';
import { TICKET_TEMPLATES } from '../src/tickets/templates.ts';

const v2 = new URL('..', import.meta.url).pathname;
const root = join(v2, '..');
const readme = readFileSync(join(v2, 'README.md'), 'utf8');
const headings = new Set([...readme.matchAll(/^#{2,4} (.+)$/gm)].map(([, title]) => title!.trim()));

// The section, and a file of v2/ it must name, which must exist.
const FEATURES: readonly (readonly [string, string])[] = [
  ['The flow', 'src/flow/config.ts'],
  ['The proof receipt', 'src/flow/receipt.ts'],
  ['The cost of a ticket', 'src/consumption/ticket-cost.ts'],
  ['A ticket from a chat', 'src/flow/chat.ts'],
  ['The harness pick', 'src/flow/harness-pick.ts'],
  ['Ticket templates', 'src/tickets/templates.ts'],
  ['Code questions and their links', 'src/reader/citations.ts'],
  ["The lanes' MCP server", 'src/mcp/lanes.ts'],
  ['On a phone', 'app/web/screens/inbox/inbox.css'],
  ['After a release: the production page', 'src/flow/production.ts'],
  ['The prompt cache', 'scripts/prompt-cache.ts'],
  ['The fast lane', 'src/flow/fast-lane.ts'],
  ['Skills', 'images/session/runner/main.ts'],
];

const section = (title: string): string => {
  const start = readme.search(new RegExp(`^#{2,4} ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  const rest = readme.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^#{2,4} /.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
};

test('v2/README.md has a section for each feature, naming the file that holds it', () => {
  for (const [title, file] of FEATURES) {
    assert.ok(headings.has(title), `no section "${title}" in v2/README.md`);
    assert.ok(existsSync(join(v2, file)), `${file} does not exist`);
    assert.ok(section(title).includes(`\`${file}\``), `"${title}" does not name \`${file}\``);
  }
});

test('a message that says "see X in v2/README.md" finds X there', () => {
  const tracked = execFileSync('git', ['-C', v2, 'ls-files'], { encoding: 'utf8' }).split('\n')
    .filter((file) => /\.(ts|tsx|json)$/.test(file) && !/(^|\/)(test|fixtures)\//.test(file) && file !== 'package-lock.json');
  const named = new Map<string, string>();
  for (const file of tracked) {
    for (const [, name] of readFileSync(join(v2, file), 'utf8').matchAll(/\b([A-Z][A-Z0-9_]{3,}) (?:in|dans) v2\/README\.md/g)) named.set(name!, file);
  }
  assert.ok(named.has('CLEARED_V2_PROJECT'), 'the flow\'s "not configured" message is still read');
  for (const [name, file] of named) assert.ok(readme.includes(`\`${name}\``), `${file} sends the reader to ${name} in v2/README.md, which does not name it`);
});

test('docs/fast-lane.md says what Cleared v2 does with the fast lane', () => {
  const page = readFileSync(join(root, 'docs/fast-lane.md'), 'utf8');
  assert.match(page, /^## In Cleared v2$/m);
  assert.ok(page.includes('`v2/src/flow/fast-lane.ts`'));
});

test('docs/adapters.md points to the harness pick and to the skills a session reads', () => {
  const page = readFileSync(join(root, 'docs/adapters.md'), 'utf8');
  assert.ok(page.includes('CLEARED_V2_PICK_HARNESSES'));
  assert.ok(page.includes("settingSources: ['user']"));
});

const NEWCOMER = ['README.md', 'docs/install.md', 'docs/troubleshooting.md', 'docs/run.md'] as const;
const page = (file: string): string => readFileSync(join(root, file), 'utf8');
const ONE_COMMAND = 'docker compose -f v2/compose.yaml run --rm install';

// A page's section under a heading of any level, to the next heading of the same level or above.
function under(text: string, heading: RegExp): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const level = /^#+/.exec(lines[start]!)![0].length;
  const end = lines.findIndex((line, i) => i > start && /^#+ /.test(line) && /^#+/.exec(line)![0].length <= level);
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

test('no em dash in the docs a developer reads first', () => {
  for (const file of ['README.md', 'v2/README.md', 'docs/adapters.md', 'docs/fast-lane.md', 'docs/configuration.md', ...NEWCOMER]) {
    assert.doesNotMatch(page(file), /\u2014/, file);
  }
});

test('the newcomer\'s pages keep the catalogs\' wording rules outside their code', () => {
  for (const file of NEWCOMER) {
    const prose = page(file).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    assert.doesNotMatch(prose, /\S [\u2013-] /, `${file}: a dash used as a pause`);
    assert.doesNotMatch(prose, /\p{Extended_Pictographic}/u, `${file}: an emoji`);
    assert.doesNotMatch(prose, /\b(?:simply|seamless(?:ly)?|effortless(?:ly)?|easily|feel free|please note|note that|don't worry|oops|awesome|just)\b/i, `${file}: a filler word`);
  }
});

test('every link and capture of the newcomer\'s pages is in the repository', () => {
  for (const file of NEWCOMER) {
    for (const [, target] of page(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/.test(target!)) continue;
      const path = join(root, dirname(file), decodeURI(target!.split('#')[0]!));
      assert.ok(existsSync(path), `${file} links ${target}, which is not in the repository`);
    }
  }
});

test('the root README says what Cleared is, the one command, the assistant, what it needs, and where to read more', () => {
  const readmeRoot = page('README.md');
  for (const heading of ['What it needs', 'Install', 'The setup assistant', 'Read more']) {
    assert.match(readmeRoot, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.ok(under(readmeRoot, /^## Install$/)!.includes(ONE_COMMAND));
  for (const target of ['docs/install.md', 'docs/troubleshooting.md', 'docs/run.md', 'v2/README.md']) {
    assert.ok(readmeRoot.includes(`](${target})`), `README.md does not link ${target}`);
  }
  assert.doesNotMatch(readmeRoot, /systemd|Tailscale|Orca terminal/, 'README.md still describes v1\'s install');
});

test('docs/install.md: the one command, each step of the assistant with a capture, SSH, updating, stopping, removing by label', () => {
  const install = page('docs/install.md');
  assert.ok(under(install, /^## The one command$/)!.includes(ONE_COMMAND));
  for (const file of ['v2/compose.yaml', 'v2/src/cli/install.ts']) assert.ok(install.includes(`\`${file}\``), file);
  // The steps, in the registry's order, each under the name the assistant shows.
  const setup = JSON.parse(readFileSync(join(v2, 'app/messages/setup.en.json'), 'utf8')) as Record<string, string>;
  STEPS.forEach((step, i) => {
    const name = setup[`setup_step_${step.id === 'secrets' ? 'test_values' : step.id.replace('-', '_')}`]!;
    const section = under(install, new RegExp(`^### ${i + 1}\\. ${name}$`));
    assert.ok(section !== undefined, `no section "${i + 1}. ${name}" in docs/install.md`);
    assert.match(section, /!\[[^\]]+\]\([^)]+\.png\)/, `"${name}" shows no capture`);
  });
  assert.ok(under(install, /^## From another computer$/)!.includes('ssh -L 8792:127.0.0.1:8792'));
  for (const heading of ['Updating', 'Stopping']) assert.ok(under(install, new RegExp(`^## ${heading}$`)), heading);
  const removing = under(install, /^## Removing everything$/)!;
  for (const kind of ['ps -a', 'network ls', 'volume ls', 'image ls']) {
    assert.ok(removing.includes(`docker ${kind} -q --filter label=cleared.dev=v2`), `docker ${kind} by label`);
  }
});

test('docs/troubleshooting.md quotes each line of cleared doctor that is not green, under its check, with what to do', () => {
  const trouble = page('docs/troubleshooting.md');
  assert.ok(trouble.includes('`cleared doctor`'));
  const doctor = JSON.parse(readFileSync(join(v2, 'src/doctor/messages/doctor.en.json'), 'utf8')) as Record<string, string>;
  for (const mark of ['mark_fail', 'mark_notice', 'mark_off']) assert.ok(trouble.includes(`\`${doctor[mark]}\``), mark);
  const ready = JSON.parse(readFileSync(join(v2, 'src/doctor/messages/ready.en.json'), 'utf8')) as Record<string, string>;
  const sections = new Map(READY_CHECKS.map((id) => [id, under(trouble, new RegExp(`^### \`${id}\`: `))]));
  for (const [id, section] of sections) assert.ok(section !== undefined, `no section for the check ${id}`);
  for (const [key, text] of Object.entries(ready)) {
    if (key === 'section_title' || /^(?:size|after)_/.test(key) || key.endsWith('_ok')) continue;
    const prefix = key.split('_')[0]!;
    const id = prefix === 'workspace' ? 'checkout' : prefix;
    assert.ok((READY_CHECKS as readonly string[]).includes(id), `${key}: no check ${id}`);
    assert.ok(sections.get(id as (typeof READY_CHECKS)[number])!.includes(text), `${key} is not quoted under ${id}: ${text}`);
  }
});

test('docs/run.md: cleared run, its options and exit codes, the token, and the API\'s two routes and states', () => {
  const run = page('docs/run.md');
  for (const word of ['cleared run', '--service', '--template', '--wait', 'CLEARED_V2_API_TOKEN_FILE', 'CLEARED_V2_API_TOKEN', 'POST /api/run', 'GET /api/run/:id', 'authorization: Bearer', 'v2/src/cli/run.ts', 'v2/src/run/types.ts']) {
    assert.ok(run.includes(`\`${word}`), word);
  }
  for (const template of TICKET_TEMPLATES) assert.ok(run.includes(`\`${template}\``), template);
  for (const state of RUN_STATES) assert.ok(run.includes(`\`${state}\``), state);
  const exits = under(run, /^### Exit codes$/)!;
  for (const code of [0, 1, 64, 69, 77]) assert.match(exits, new RegExp(`\\| ${code} \\|`), `exit ${code}`);
});

test('v2/README.md points to the newcomer\'s pages', () => {
  for (const target of ['../docs/install.md', '../docs/troubleshooting.md', '../docs/run.md']) {
    assert.ok(readme.includes(`](${target})`), `v2/README.md does not link ${target}`);
  }
});
