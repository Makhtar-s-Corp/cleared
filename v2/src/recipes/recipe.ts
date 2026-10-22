// A recipe (docs/v2/milestone-2-plan.md, decision 29): a file
// `.cleared/recipes/<name>.md` of a service's repository, read at its base
// branch (source.ts). Its front matter says what it is; its body is the
// ticket's body, or the goal's text, with {{parameter}} marks:
//
//   ---
//   name: bump-dependency          the file's name, a-z, 0-9 and dashes
//   kind: ticket                   ticket (a one-item plan) or goal (an owner turn to the lead)
//   title: Bump {{package}}        a ticket's title; the name when absent
//   lane: fast                     fast or full (full when absent); a ticket's only
//   size: xs                       xs, s, m or l (s when absent); a ticket's only
//   services: [guestbook]          the services it touches (its own when absent)
//   parameters:                    names, or a list of name, description, required
//     - name: package
//       description: The package to bump
//   ---
//   Bump {{package}}.
//
//   - [ ] npm test passes          a ticket needs one criterion, as a plan item does
//
// The front matter is a strict subset of YAML read with no dependency: a
// key it does not know is refused, so a typo never passes for a default.
import type { Recipe } from '../api/types.ts';

export const RECIPES_FOLDER = '.cleared/recipes';
export const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MARK = /\{\{\s*([^{}\s]*)\s*\}\}/g;
const CRITERION = /^\s*[-*] \[ \] \S/m;
const KEYS = ['name', 'kind', 'title', 'lane', 'size', 'services', 'parameters'];
const PARAMETER_KEYS = ['name', 'description', 'required'];

export const MAX_VALUE = 500;
const MAX_TITLE = 120;          // a plan item's (lead/plans/tools.ts)
const MAX_BODY = 20_000;        // a plan item's, and the lead's owner message's

export type RecipeErrorKind = 'invalid' | 'not_found' | 'conflict';

export class RecipeError extends Error {
  override name = 'RecipeError';
  readonly kind: RecipeErrorKind;
  constructor(kind: RecipeErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// A recipe as read, with its title, which the API's Recipe does not show.
export type RecipeFile = Recipe & { readonly title: string | null; readonly file: string };

export function publicRecipe(recipe: RecipeFile): Recipe {
  const { title: _title, file: _file, ...rest } = recipe;
  return rest;
}

type Scalar = string;
type Entry = Scalar | Scalar[] | Record<string, Scalar>[];

const unquote = (value: string): string => {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
};

// `[a, b]` or `a, b`; an empty value is an empty list.
const inlineList = (value: string): string[] => {
  const v = value.trim().replace(/^\[(.*)\]$/s, '$1');
  return v.trim() === '' ? [] : v.split(',').map(unquote).filter((item) => item !== '');
};

// The front matter's lines into keys: a scalar on its line, or a block list
// below it of scalars (`- a`) or of maps (`- name: a` then indented keys).
function frontMatter(lines: readonly string[], refuse: (message: string) => never): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    i++;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const top = /^([a-z_]+):(.*)$/.exec(line);
    if (!top) return refuse(`the front matter's line "${line.trim().slice(0, 60)}" is not "key: value"`);
    const key = top[1] as string;
    if (!KEYS.includes(key)) return refuse(`the front matter has no key "${key}" (it has ${KEYS.join(', ')})`);
    if (out.has(key)) return refuse(`the front matter names "${key}" twice`);
    const rest = (top[2] as string).trim();
    if (rest !== '') { out.set(key, rest); continue; }
    // A block list: the indented lines that follow.
    const block: string[] = [];
    while (i < lines.length && /^\s+\S/.test(lines[i] as string)) block.push(lines[i++] as string);
    if (block.length === 0) { out.set(key, ''); continue; }
    const items: (string | Record<string, string>)[] = [];
    for (const b of block) {
      const dash = /^\s*- (.*)$/.exec(b);
      const pair = (text: string) => /^([a-z_]+):\s*(.*)$/.exec(text.trim());
      if (dash) {
        const kv = pair(dash[1] as string);
        items.push(kv ? { [kv[1] as string]: unquote(kv[2] as string) } : unquote(dash[1] as string));
        continue;
      }
      const kv = pair(b);
      const last = items.at(-1);
      if (!kv || typeof last !== 'object') return refuse(`the list under "${key}" has a line that is neither "- item" nor "key: value" of an item`);
      if ((kv[1] as string) in last) return refuse(`an item under "${key}" names "${kv[1]}" twice`);
      last[kv[1] as string] = unquote(kv[2] as string);
    }
    if (items.every((item) => typeof item === 'string')) out.set(key, items as string[]);
    else if (items.every((item) => typeof item === 'object')) out.set(key, items as Record<string, string>[]);
    else return refuse(`the list under "${key}" mixes names and items`);
  }
  return out;
}

// Reads one recipe file; `services` are the workspace's service names.
export function parseRecipe(text: string, input: { readonly file: string; readonly service: string; readonly services: readonly string[] }): RecipeFile {
  const refuse = (message: string): never => { throw new RecipeError('invalid', `${input.service}:${input.file}: ${message}`); };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return refuse('a recipe starts with its front matter between two "---" lines');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return refuse('the front matter has no closing "---" line');
  const fields = frontMatter(lines.slice(1, end), refuse);
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  const scalar = (key: string): string | undefined => {
    const value = fields.get(key);
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return refuse(`"${key}" is one value, not a list`);
    return unquote(value);
  };

  const name = scalar('name') ?? refuse('the front matter has no name');
  if (name.includes('{{')) return refuse(`a recipe's name holds no {{ mark: "${name}"`);
  if (!RECIPE_NAME.test(name)) return refuse(`the name "${name}" is lower-case letters, digits and dashes, at most 64`);
  const stem = input.file.split('/').at(-1)?.replace(/\.md$/, '');
  if (stem !== name) return refuse(`the file holds the recipe ${name}, whose file is ${RECIPES_FOLDER}/${name}.md`);

  const kind = scalar('kind');
  if (kind !== 'ticket' && kind !== 'goal') return refuse('the kind is ticket or goal');
  const lane = scalar('lane');
  const size = scalar('size');
  if (kind === 'goal' && (lane !== undefined || size !== undefined)) return refuse('a goal recipe has no lane or size: the lead chooses them in its plan');
  if (lane !== undefined && lane !== 'fast' && lane !== 'full') return refuse('the lane is fast or full');
  if (size !== undefined && !['xs', 's', 'm', 'l'].includes(size)) return refuse('the size is xs, s, m or l');

  const listed = fields.get('services');
  const named = listed === undefined ? [input.service] : typeof listed === 'string' ? inlineList(listed) : listed;
  if (named.some((s) => typeof s !== 'string')) return refuse('the services are names');
  const services = [...new Set(named as string[])];
  if (services.length === 0) return refuse('the services name at least one service');
  for (const service of services) if (!input.services.includes(service)) refuse(`${service} is not a service of this workspace (${input.services.join(', ')})`);

  const rawParameters = fields.get('parameters');
  const entries: Record<string, string>[] = rawParameters === undefined ? []
    : typeof rawParameters === 'string' ? inlineList(rawParameters).map((n) => ({ name: n }))
    : rawParameters.map((p) => (typeof p === 'string' ? { name: p } : p));
  const parameters = entries.map((entry) => {
    for (const key of Object.keys(entry)) if (!PARAMETER_KEYS.includes(key)) refuse(`a parameter has no key "${key}" (it has ${PARAMETER_KEYS.join(', ')})`);
    const parameter = entry.name ?? refuse('a parameter has no name');
    if (!PARAMETER_NAME.test(parameter)) refuse(`the parameter "${parameter}" is a lower-case letter then letters, digits or _, at most 32`);
    const required = entry.required === undefined ? true : entry.required === 'true' ? true : entry.required === 'false' ? false : refuse(`the parameter ${parameter}'s required is true or false`);
    return { name: parameter, ...(entry.description ? { description: entry.description } : {}), required };
  });
  if (new Set(parameters.map((p) => p.name)).size !== parameters.length) return refuse('a parameter is named twice');

  const title = scalar('title') ?? null;
  for (const [where, value] of [['body', body], ['title', title ?? '']] as const)
    for (const match of value.matchAll(MARK))
      if (!parameters.some((p) => p.name === match[1])) refuse(`the ${where}'s mark ${match[0]} names no parameter of the recipe`);
  if (body.trim() === '') return refuse('the body is empty');
  if (body.length > MAX_BODY) return refuse(`the body is longer than ${MAX_BODY} characters`);
  if (kind === 'ticket' && !CRITERION.test(body)) return refuse('a ticket recipe\'s body needs at least one "- [ ]" acceptance criterion');

  return {
    name, service: input.service, kind, parameters,
    ...(kind === 'ticket' ? { lane: (lane ?? 'full') as 'fast' | 'full', size: (size ?? 's') as 'xs' | 's' | 'm' | 'l' } : {}),
    services, body, title, file: input.file,
  };
}

// The recipe with the values in place of its marks, in one pass: a value
// is never read for marks. Every required parameter is given, no unknown
// one is; a value is one line of at most MAX_VALUE characters with no mark.
export function substitute(recipe: RecipeFile, values: Readonly<Record<string, string>>): { readonly title: string; readonly body: string } {
  const refuse = (message: string): never => { throw new RecipeError('invalid', `the recipe ${recipe.name} ${message}`); };
  for (const key of Object.keys(values)) if (!recipe.parameters.some((p) => p.name === key)) refuse(`has no parameter ${key}`);
  const given = new Map<string, string>();
  for (const parameter of recipe.parameters) {
    const raw = values[parameter.name];
    if (raw !== undefined && typeof raw !== 'string') return refuse(`takes text for ${parameter.name}`);
    if (raw === undefined || raw.trim() === '') {
      if (parameter.required) refuse(`needs the parameter ${parameter.name}`);
      given.set(parameter.name, '');
      continue;
    }
    const value = raw.trim();
    if (/[\r\n]/.test(value)) refuse(`takes ${parameter.name} on one line`);
    if (value.length > MAX_VALUE) refuse(`takes ${parameter.name} in at most ${MAX_VALUE} characters`);
    if (value.includes('{{') || value.includes('}}')) refuse(`takes no {{ or }} in ${parameter.name}`);
    given.set(parameter.name, value);
  }
  const fill = (text: string) => text.replace(MARK, (_whole, name: string) => given.get(name) ?? '');
  const title = fill(recipe.title ?? recipe.name).replace(/\s+/g, ' ').trim();
  return { title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title || recipe.name, body: fill(recipe.body) };
}
