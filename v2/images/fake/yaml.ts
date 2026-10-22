// Copied from examples/filter-api/test/helpers/yaml.ts (lane 28), which the
// filter API's contract is checked with, so the fake reads exactly the subset
// the contract keeps to. The image copies this file next to fake.ts.
//
// Reads the small block subset of YAML the contract is written in, with no
// dependency (Node has no YAML parser). The subset, which the README states:
//   - two spaces per level, no tab;
//   - `key: value` and `key:` followed by a more indented block;
//   - sequences of scalars only (`- value`), more indented than their key;
//   - scalars: plain, "double quoted" (JSON escapes), 'single quoted',
//     true, false, null, whole numbers, and the empty [] and {};
//   - comments on lines of their own only.
// Anything else (an anchor, a flow collection that is not empty, a block
// scalar, an inline comment, a tab) is refused with its line number, so the
// contract cannot drift out of what Cleared's fake reads.
export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

type Line = { readonly number: number; readonly indent: number; readonly text: string };

export class YamlError extends Error {
  override name = 'YamlError';
}

function scalar(raw: string, line: number): Yaml {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'string') return value;
    } catch {
      // refused below
    }
    throw new YamlError(`line ${line}: not a double-quoted string: ${text}`);
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new YamlError(`line ${line}: not a single-quoted string: ${text}`);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(text)) return Number(text);
  if (text === '' || /^[[{&*!|>%@`]/.test(text) || text.includes(' #') || text.includes(': ')) {
    throw new YamlError(`line ${line}: outside the contract's YAML subset: ${text}`);
  }
  return text;
}

function key(raw: string, line: number): string {
  const value = scalar(raw, line);
  if (typeof value !== 'string' && typeof value !== 'number') throw new YamlError(`line ${line}: a key must be a string`);
  return String(value);
}

// The colon that ends a key: the first ": " or a final ":", outside quotes.
function keyEnd(text: string): number {
  let quote = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === '\\' && quote === '"') at++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ':' && (at === text.length - 1 || text[at + 1] === ' ')) {
      return at;
    }
  }
  return -1;
}

function block(lines: readonly Line[], from: number, indent: number): [Yaml, number] {
  const first = lines[from];
  if (first === undefined || first.indent !== indent) throw new YamlError(`line ${first?.number ?? '?'}: expected a block at indent ${indent}`);
  if (first.text.startsWith('- ') || first.text === '-') {
    const list: Yaml[] = [];
    let at = from;
    while (at < lines.length && lines[at]!.indent === indent && lines[at]!.text.startsWith('-')) {
      const line = lines[at]!;
      if (!line.text.startsWith('- ')) throw new YamlError(`line ${line.number}: an item needs a value on its line`);
      const item = line.text.slice(2);
      if (keyEnd(item) >= 0) throw new YamlError(`line ${line.number}: a sequence holds scalars only`);
      list.push(scalar(item, line.number));
      at++;
    }
    return [list, at];
  }
  const map: { [key: string]: Yaml } = {};
  let at = from;
  while (at < lines.length && lines[at]!.indent === indent) {
    const line = lines[at]!;
    const end = keyEnd(line.text);
    if (end < 0) throw new YamlError(`line ${line.number}: expected "key: value"`);
    const name = key(line.text.slice(0, end), line.number);
    if (Object.hasOwn(map, name)) throw new YamlError(`line ${line.number}: the key "${name}" appears twice`);
    const rest = line.text.slice(end + 1).trim();
    if (rest !== '') {
      map[name] = scalar(rest, line.number);
      at++;
      continue;
    }
    const next = lines[at + 1];
    if (next === undefined || next.indent <= indent) throw new YamlError(`line ${line.number}: "${name}" has no value`);
    const [value, after] = block(lines, at + 1, next.indent);
    map[name] = value;
    at = after;
  }
  return [map, at];
}

export function parseYaml(source: string): Yaml {
  const lines: Line[] = [];
  source.split('\n').forEach((raw, index) => {
    const number = index + 1;
    if (raw.includes('\t')) throw new YamlError(`line ${number}: a tab`);
    const text = raw.trimEnd();
    const body = text.trimStart();
    if (body === '' || body.startsWith('#')) return;
    const indent = text.length - body.length;
    if (indent % 2 !== 0) throw new YamlError(`line ${number}: indent of ${indent} spaces, not a multiple of 2`);
    lines.push({ number, indent, text: body });
  });
  if (lines.length === 0) throw new YamlError('empty document');
  const [value, after] = block(lines, 0, 0);
  if (after !== lines.length) throw new YamlError(`line ${lines[after]!.number}: unexpected indent`);
  return value;
}
