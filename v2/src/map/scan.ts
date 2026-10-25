// What one service's code says about the others (docs/v2/milestone-4-plan.md,
// section 12.3), read line by line from its files, its agents.conf and its
// package.json, with no parser of any language:
//
//   a call       a path of another service's OpenAPI contract, on a line
//                that is not a comment, right after an interpolation or a
//                base address (`${base}/check`, http://host:8795/check),
//                after a concatenation ('+ "/check"'), or in quotes on a
//                line that calls fetch, request, axios, got, requests or
//                http.get; a route table or a comparison is not a call
//   a listen     a channel of another service's events contract, in quotes
//   a database   an engine named by an image of [session] services, a
//                client of package.json's dependencies, or node:sqlite; the
//                tables a CREATE TABLE makes, and the tables a FROM, JOIN,
//                INTO or UPDATE names
//
// A setting's value is never read ([session] env holds addresses and
// passwords). The sessions write these repositories and the map reaches the
// lead's prompt, so what is kept is an identifier that matches a strict
// pattern, or nothing: a name that does not is dropped and counted.
import { posix } from 'node:path';
import { readContract, type ContractFormat } from '../../images/fake/fake.ts';
import { parseConf } from '../workspace/config.ts';

export type MapFile = { readonly path: string; readonly text: string };   // the path inside the service (its folder, for a monorepo's)

// What a provider's contract offers, which the others' code is read against.
export type Provided = {
  readonly service: string;
  readonly operations: readonly { readonly method: string; readonly path: string }[];
  readonly channels: readonly string[];
};

export type Found = { readonly item: string; readonly file: string; readonly line: number };

export type Scan = {
  readonly calls: Readonly<Record<string, readonly Found[]>>;     // per provider, the operations called
  readonly listens: Readonly<Record<string, readonly Found[]>>;   // per provider, the channels named
  readonly engines: readonly string[];
  readonly creates: readonly Found[];                              // the tables it creates
  readonly uses: readonly Found[];                                 // the tables it reads or writes
  readonly dropped: number;                                        // names that are not identifiers
};

// The most places kept for one item of one link.
export const PLACES_MAX = 5;

const CODE = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rb', '.java', '.kt', '.rs', '.php', '.cs', '.sql']);
const SKIPPED_FOLDERS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'fixtures', 'node_modules', 'vendor', 'dist', 'build', '.git']);

// A file the scan reads: code, outside the tests, the dependencies and the builds.
export function isCodeFile(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((part) => SKIPPED_FOLDERS.has(part))) return false;
  const name = parts.at(-1) ?? '';
  if (/\.(?:test|spec)\.[^.]+$/.test(name)) return false;
  return CODE.has(posix.extname(name));
}

const FILE = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+){0,30}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const CHANNEL = /^[A-Za-z0-9_.:-]{1,100}$/;
const PATH = /^\/[A-Za-z0-9_.~{}/:-]{0,200}$/;
const METHOD = /^(?:GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)$/;

// The engines, by the image of a test service or the client a service depends on.
const IMAGES: Readonly<Record<string, string>> = {
  postgres: 'postgres', postgis: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongo: 'mongodb', redis: 'redis', valkey: 'redis',
};
const CLIENTS: Readonly<Record<string, string>> = {
  pg: 'postgres', postgres: 'postgres', 'pg-promise': 'postgres', '@neondatabase/serverless': 'postgres', slonik: 'postgres',
  mysql: 'mysql', mysql2: 'mysql', mariadb: 'mariadb', 'better-sqlite3': 'sqlite', sqlite3: 'sqlite', sqlite: 'sqlite',
  mongodb: 'mongodb', mongoose: 'mongodb', redis: 'redis', ioredis: 'redis',
};

// The operations and channels of a contract, by the fakes' own reader
// (images/fake/fake.ts). Only an OpenAPI contract's operations are read
// against the others' code: a protobuf or JSON Schema contract has none a
// line can show. Throws when the contract cannot be read.
export function contractFacts(format: ContractFormat, path: string, text: string): Pick<Provided, 'operations' | 'channels'> {
  const contract = readContract(text, path, format);
  if (format === 'events') {
    const channels = [...new Set(contract.operations.map((operation) => operation.path.replace(/^\/events\//, '')))];
    return { operations: [], channels: channels.filter((channel) => CHANNEL.test(channel)) };
  }
  if (format !== 'openapi') return { operations: [], channels: [] };
  return { operations: contract.operations.filter((op) => METHOD.test(op.method) && PATH.test(op.path)).map((op) => ({ method: op.method, path: op.path })), channels: [] };
}

const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--)/;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A path of the contract as a pattern: each {parameter} any value of a segment.
function pathPattern(path: string): RegExp | undefined {
  if (!path.replace(/\{[^}]*\}/g, '').replace(/\//g, '')) return undefined;     // "/" or "/{id}" alone says nothing
  const source = path.split(/\{[^}]*\}/).map(escape).join('[^/\\s\'"`?#]+');
  return new RegExp(`${source}(?![A-Za-z0-9_-])`, 'g');
}

const CALL_WORDS = /(?:\bfetch|\brequest|\baxios(?:\.\w+)?|\bgot(?:\.\w+)?|\brequests\.\w+|\burlopen|\bhttps?\.(?:get|request))\s*\(/;
const QUOTES = new Set(['\'', '"', '`']);

// Whether the path found at `at` of the line is the address of a request.
function calledAt(line: string, at: number): boolean {
  const before = line.slice(0, at);
  const previous = before.at(-1) ?? '';
  if (previous === '}') return true;                                             // `${base}/check`
  if (/:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(before)) return true;                 // http://host:8795/check
  if (!QUOTES.has(previous)) return false;
  if (/\+\s*$/.test(before.slice(0, -1))) return true;                           // base + '/check'
  return CALL_WORDS.test(line);
}

function push(into: Map<string, Found[]>, key: string, found: Found): void {
  const list = into.get(key) ?? [];
  list.push(found);
  into.set(key, list);
}

// The engines a service's settings and dependencies name, never a value.
function enginesOf(conf: string | null, packageJson: string | null): Set<string> {
  const engines = new Set<string>();
  const services = conf === null ? '' : parseConf(conf).session?.services ?? '';
  for (const entry of services.split(',')) {
    const image = entry.trim().split(/\s+/)[0] ?? '';
    const name = image.split('@')[0]?.split(':')[0]?.split('/').at(-1) ?? '';
    const engine = IMAGES[name];
    if (engine) engines.add(engine);
  }
  if (packageJson !== null) {
    let dependencies: unknown;
    try { dependencies = (JSON.parse(packageJson) as { dependencies?: unknown }).dependencies; } catch { dependencies = undefined; }
    if (typeof dependencies === 'object' && dependencies !== null)
      for (const name of Object.keys(dependencies)) if (CLIENTS[name]) engines.add(CLIENTS[name] as string);
  }
  return engines;
}

const CREATE = /\bcreate\s+(?:temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:[`"[]?[A-Za-z_][\w$]*[`"\]]?\.)?[`"[]?[^\s(`"\]]+[`"\]]?)/gi;
const USE = /\b(?:from|join|into|update)\s+((?:[`"[]?[A-Za-z_][\w$]*[`"\]]?\.)?[`"[]?[A-Za-z_][\w$]*[`"\]]?)/gi;

// The table's own name: its schema and its quotes taken off.
const tableName = (raw: string): string => (raw.split('.').at(-1) ?? '').replace(/^[`"[]|[`"\]]$/g, '');

export function scanService(input: {
  readonly name: string;
  readonly files: readonly MapFile[];
  readonly conf: string | null;
  readonly packageJson: string | null;
  readonly providers: readonly Provided[];
}): Scan {
  let dropped = 0;
  const calls = new Map<string, Found[]>();
  const listens = new Map<string, Found[]>();
  const creates: Found[] = [];
  const uses: Found[] = [];
  const engines = enginesOf(input.conf, input.packageJson);
  const providers = input.providers.filter((provider) => provider.service !== input.name).map((provider) => ({
    provider,
    paths: [...new Set(provider.operations.map((op) => op.path))].flatMap((path) => {
      const pattern = pathPattern(path);
      return pattern ? [{ path, pattern, operations: provider.operations.filter((op) => op.path === path).map((op) => `${op.method} ${op.path}`) }] : [];
    }),
    channels: provider.channels.map((channel) => ({ channel, pattern: new RegExp(`['"\`]${escape(channel)}['"\`]`) })),
  }));
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of files) {
    const fileOk = FILE.test(file.path);
    const lines = file.text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (COMMENT.test(line)) continue;
      const at = (item: string): Found | undefined => {
        if (fileOk) return { item, file: file.path, line: index + 1 };
        dropped++;
        return undefined;
      };
      for (const { provider, paths, channels } of providers) {
        for (const { pattern, operations } of paths) {
          pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          let called = false;
          while (!called && (match = pattern.exec(line)) !== null) called = calledAt(line, match.index);
          if (!called) continue;
          for (const operation of operations) {
            const found = at(operation);
            if (found) push(calls, provider.service, found);
          }
        }
        for (const { channel, pattern } of channels) {
          if (!pattern.test(line)) continue;
          const found = at(channel);
          if (found) push(listens, provider.service, found);
        }
      }
      if (/node:sqlite/.test(line)) engines.add('sqlite');
      for (const match of line.matchAll(CREATE)) {
        const table = tableName(match[1] as string);
        if (!TABLE.test(table)) { dropped++; continue; }
        const found = at(table);
        if (found) creates.push(found);
      }
      for (const match of line.matchAll(USE)) {
        const table = tableName(match[1] as string);
        if (!TABLE.test(table)) continue;                                        // a FROM in prose is not counted as dropped
        const found = at(table);
        if (found) uses.push(found);
      }
    }
  }
  // At most PLACES_MAX places per provider and item.
  const capped = (map: Map<string, Found[]>): Record<string, Found[]> => Object.fromEntries([...map].map(([key, list]) => {
    const count = new Map<string, number>();
    return [key, list.filter((found) => {
      const n = (count.get(found.item) ?? 0) + 1;
      count.set(found.item, n);
      return n <= PLACES_MAX;
    })];
  }));
  return { calls: capped(calls), listens: capped(listens), engines: [...engines].sort(), creates, uses, dropped };
}
