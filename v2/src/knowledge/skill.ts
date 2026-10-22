// A service's skill (docs/v2/milestone-2-plan.md, decision 27, lane 24):
// `.claude/skills/cleared-<service>/SKILL.md` in the service's repository,
// in the standard skill format (front matter `name` and `description`, then
// the body), with the knowledge the owner approved for that service in
// sections per level. The file is Cleared's: it is rendered whole from every
// approved entry and written by a fast-lane ticket through the lock, so the
// ticket's author copies it and decides nothing.
import type { KnowledgeLevel } from '../api/types.ts';
import type { ProposalKind } from './proposals.ts';

export type SkillEntry = { readonly kind: ProposalKind; readonly level: KnowledgeLevel; readonly service: string | null; readonly text: string };

// workspace/config.ts's service name rule; the skill's name is cleared-<service>.
const SERVICE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// The standard format's limits: a name of lowercase letters, digits and
// hyphens, at most 64; a description of at most 1024 characters, no tag.
const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
const MAX_DESCRIPTION = 1024;

export function skillName(service: string): string {
  if (!SERVICE_NAME.test(service)) throw new Error(`"${service}" is not a service name`);
  return `cleared-${service}`;
}

export function skillPath(service: string): string {
  return `.claude/skills/${skillName(service)}/SKILL.md`;
}

// One entry as one list item: its other lines indented under it, so a
// heading or a fence line in it opens nothing.
function item(text: string): string {
  const [first, ...rest] = text.replace(/\r\n?/g, '\n').trim().split('\n');
  return [`- ${first}`, ...rest.map((line) => (line.trim() === '' ? '' : `  ${line}`))].join('\n');
}

function part(title: string, entries: readonly SkillEntry[]): string[] {
  if (entries.length === 0) return [];
  const out = ['', `## ${title}`];
  for (const [kind, heading] of [['decision', 'Decisions'], ['lesson', 'Lessons']] as const) {
    const of = entries.filter((entry) => entry.kind === kind);
    if (of.length) out.push('', `### ${heading}`, '', ...of.map((entry) => item(entry.text)));
  }
  return out;
}

export type SkillInput = { readonly service: string; readonly workspace: string; readonly entries: readonly SkillEntry[] };

// The levels in order: the workspace, the service, then each contract by
// the service that provides it; within a level, decisions before lessons,
// each in the order they were approved.
export function renderSkill(input: SkillInput): string {
  const { service, workspace, entries } = input;
  const description = `Decisions and lessons the owner of the ${workspace} workspace approved for the ${service} service, its workspace and the contracts it touches. Read it before changing ${service}.`;
  const providers = [...new Set(entries.filter((entry) => entry.level === 'contract').map((entry) => entry.service as string))];
  const lines = [
    '---', `name: ${skillName(service)}`, `description: ${description}`, '---', '',
    `# Approved knowledge for ${service}`, '',
    'Written by Cleared from the knowledge its owner approved in the inbox. Do not edit it by hand: the next update rewrites it.',
    ...part('The workspace', entries.filter((entry) => entry.level === 'workspace')),
    ...part(`The service ${service}`, entries.filter((entry) => entry.level === 'service')),
    ...providers.flatMap((provider) => part(`The contract of ${provider}`, entries.filter((entry) => entry.level === 'contract' && entry.service === provider))),
  ];
  return `${lines.join('\n')}\n`;
}

// What is wrong with a skill file for `service`, or nothing: the front
// matter between two `---` lines first, holding exactly `name` (the service's
// skill name) and `description` (not empty, at most 1024 characters, no
// tag), then a body that is not empty.
export function checkSkill(text: string, service: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return ['the file does not start with its front matter (a --- line)'];
  const end = lines.indexOf('---', 1);
  if (end < 0) return ['the front matter has no closing --- line'];
  const problems: string[] = [];
  const keys = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(line);
    if (!match) { problems.push(`the front matter holds a line that is not a key: ${JSON.stringify(line)}`); continue; }
    const key = match[1] as string;
    if (keys.has(key)) problems.push(`the front matter names ${key} twice`);
    else if (key !== 'name' && key !== 'description') problems.push(`the front matter holds ${key}, which a Cleared skill does not set`);
    keys.set(key, (match[2] ?? '').trim());
  }
  const name = keys.get('name');
  if (name === undefined) problems.push('the front matter has no name');
  else if (!SKILL_NAME.test(name) || name !== skillName(service)) problems.push(`the name is ${JSON.stringify(name)}, not ${skillName(service)}`);
  const description = keys.get('description');
  if (!description) problems.push('the front matter has no description');
  else if (description.length > MAX_DESCRIPTION) problems.push(`the description is longer than ${MAX_DESCRIPTION} characters`);
  else if (/<[^>]*>/.test(description)) problems.push('the description holds a tag');
  if (lines.slice(end + 1).join('\n').trim() === '') problems.push('the body is empty');
  return problems;
}

const OPENING = /^(`{3,})markdown$/m;

// The fence around the file in the ticket: longer than any backtick run in it.
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export type SkillTicket = { readonly title: string; readonly body: string };

// The ticket that lands the file: its path, the whole file, and what not to do.
export function skillTicket(input: SkillInput & { readonly added: number }): SkillTicket {
  const file = renderSkill(input);
  const fence = fenceFor(file);
  const entries = `${input.added} new approved ${input.added === 1 ? 'entry' : 'entries'}`;
  return {
    title: `Update the skill ${skillName(input.service)} (${entries})`,
    body: [
      `Update the skill of the ${input.service} service with the knowledge the owner approved in the inbox (${entries} since the last update).`,
      '',
      `Write the file \`${skillPath(input.service)}\`, from the root of the repository, with exactly the text between the two fences below, replacing the file if it exists. Do not reword, reorder or add anything: Cleared renders the whole file from the approved entries.`,
      'Change no other file. The tests of the repository stay as they are; run them before you commit.',
      '',
      `${fence}markdown`,
      file.replace(/\n$/, ''),
      fence,
      '',
    ].join('\n'),
  };
}

// The file a skill ticket asks for, or undefined when its body holds none.
export function skillOfTicket(body: string): string | undefined {
  const open = OPENING.exec(body);
  if (!open) return undefined;
  const start = open.index + open[0].length + 1;
  const close = body.indexOf(`\n${open[1]}\n`, start - 1);
  return close < 0 ? undefined : `${body.slice(start, close)}\n`;
}
