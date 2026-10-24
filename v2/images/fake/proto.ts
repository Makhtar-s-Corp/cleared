// A minimal protobuf reader for the fake (owner decision O11), with no
// dependency, as yaml.ts: the image has no `npm install`, and the fake needs
// the shape of the messages, not a codec. The subset (stated in the decisions-log entry of lane j3-contract-formats):
//   - `syntax = "proto3";` first, an optional `package`, top-level `option`s;
//   - messages (nested ones too), enums, `oneof`, `map<K, V>`, `repeated`,
//     `optional`, `reserved`, and services with unary `rpc`s;
//   - comments (// and /* */).
// Anything else (an `import`, `extend`, `extensions`, `group`, a field option
// in brackets, a streaming rpc, proto2) is refused with `file:line:`, so a
// contract cannot drift out of what the fake reads.
//
// The fake answers over HTTP with the proto3 JSON mapping, not gRPC: each rpc
// is `POST /<package>.<Service>/<Method>`, its response a generated example
// (lowerCamelCase names, 64-bit integers as strings, enums by name, one
// element in each list and map, a message that contains itself left out).
export class ProtoError extends Error {
  override name = 'ProtoError';
}

type Token = { readonly text: string; readonly kind: 'word' | 'number' | 'string' | 'symbol'; readonly line: number };

type Field = { readonly name: string; readonly number: number; readonly type: string; readonly repeated: boolean; readonly map: string | null; readonly oneof: number | null; readonly line: number };
type Message = { readonly name: string; readonly path: string; readonly fields: Field[] };
type Enum = { readonly name: string; readonly path: string; readonly values: string[] };
type Rpc = { readonly name: string; readonly request: string; readonly response: string; readonly line: number };
type Service = { readonly name: string; readonly rpcs: Rpc[] };

export type ProtoOperation = { readonly path: string; readonly name: string; readonly body: unknown };

const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);
const WIDE = new Set(['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64']);

function tokenize(text: string, file: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '\n') { line += 1; i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new ProtoError(`${file}:${line}: a comment is never closed`);
      line += text.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== c) throw new ProtoError(`${file}:${line}: a string is never closed`);
      tokens.push({ text: text.slice(i + 1, j), kind: 'string', line });
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i));
    if (word) { tokens.push({ text: word[0], kind: 'word', line }); i += word[0].length; continue; }
    const number = /^-?[0-9]+/.exec(text.slice(i));
    if (number) { tokens.push({ text: number[0], kind: 'number', line }); i += number[0].length; continue; }
    tokens.push({ text: c, kind: 'symbol', line });
    i += 1;
  }
  return tokens;
}

export function readProto(text: string, file: string): ProtoOperation[] {
  const tokens = tokenize(text, file);
  let at = 0;
  let last = 1;
  const fail = (line: number, reason: string): never => { throw new ProtoError(`${file}:${line}: ${reason}`); };
  const peek = (): Token | undefined => tokens[at];
  const next = (): Token => {
    const token = tokens[at];
    if (!token) return fail(last, 'unexpected end of file');
    at += 1;
    last = token.line;
    return token;
  };
  const expect = (symbol: string): Token => {
    const token = next();
    return token.text === symbol && token.kind !== 'string' ? token : fail(token.line, `expected "${symbol}", found "${token.text}"`);
  };
  const word = (what: string): Token => {
    const token = next();
    return token.kind === 'word' ? token : fail(token.line, `expected ${what}, found "${token.text}"`);
  };
  const number = (): number => {
    const token = next();
    return token.kind === 'number' ? Number(token.text) : fail(token.line, `expected a number, found "${token.text}"`);
  };
  const skipStatement = () => { while (next().text !== ';'); };

  const messages: Message[] = [];
  const enums: Enum[] = [];
  const services: Service[] = [];
  let pkg = '';

  const declared = (path: string, line: number) => {
    if (messages.some((m) => m.path === path) || enums.some((e) => e.path === path)) fail(line, `${path} is declared twice`);
  };

  const parseEnum = (scope: string): void => {
    const name = word('an enum name');
    const path = scope ? `${scope}.${name.text}` : name.text;
    declared(path, name.line);
    const found: Enum = { name: name.text, path, values: [] };
    enums.push(found);
    expect('{');
    for (;;) {
      const token = next();
      if (token.text === '}') return;
      if (token.text === ';') continue;
      if (token.kind !== 'word') fail(token.line, `expected an enum value, found "${token.text}"`);
      if (token.text === 'option' || token.text === 'reserved') { skipStatement(); continue; }
      expect('=');
      number();
      if (peek()?.text === '[') fail(token.line, 'an enum value option in brackets is not read');
      expect(';');
      found.values.push(token.text);
    }
  };

  const parseMessage = (scope: string): void => {
    const name = word('a message name');
    const path = scope ? `${scope}.${name.text}` : name.text;
    declared(path, name.line);
    const found: Message = { name: name.text, path, fields: [] };
    messages.push(found);
    let oneofs = 0;
    const numbers = new Set<number>();
    const field = (type: Token, repeated: boolean, oneof: number | null): void => {
      let map: string | null = null;
      let valueType = type.text;
      if (type.text === 'map' && peek()?.text === '<') {
        next();
        const key = word('a map key type').text;
        expect(',');
        valueType = word('a map value type').text;
        expect('>');
        map = key;
      }
      const label = word('a field name');
      expect('=');
      const num = number();
      if (peek()?.text === '[') fail(label.line, `an option in brackets on field ${label.text} is not read`);
      expect(';');
      if (numbers.has(num)) fail(label.line, `field number ${num} is used twice in ${path}`);
      numbers.add(num);
      found.fields.push({ name: label.text, number: num, type: valueType, repeated, map, oneof, line: label.line });
    };
    expect('{');
    for (;;) {
      const token = next();
      if (token.text === '}') return;
      if (token.text === ';') continue;
      if (token.kind !== 'word') fail(token.line, `expected a field, found "${token.text}"`);
      switch (token.text) {
        case 'message': parseMessage(path); break;
        case 'enum': parseEnum(path); break;
        case 'option': case 'reserved': skipStatement(); break;
        case 'extend': case 'extensions': case 'group': case 'required': fail(token.line, `${token.text} is not read: the fake reads proto3 messages, enums and services`); break;
        case 'oneof': {
          word('a oneof name');
          expect('{');
          oneofs += 1;
          for (let inner = next(); inner.text !== '}'; inner = next()) {
            if (inner.kind !== 'word') fail(inner.line, `expected a field, found "${inner.text}"`);
            field(inner, false, oneofs);
          }
          break;
        }
        case 'repeated': field(word('a field type'), true, null); break;
        case 'optional': field(word('a field type'), false, null); break;
        default: field(token, false, null);
      }
    }
  };

  const parseService = (): void => {
    const name = word('a service name');
    const service: Service = { name: name.text, rpcs: [] };
    services.push(service);
    expect('{');
    for (;;) {
      const token = next();
      if (token.text === '}') return;
      if (token.text === ';') continue;
      if (token.text === 'option') { skipStatement(); continue; }
      if (token.text !== 'rpc') fail(token.line, `expected rpc, found "${token.text}"`);
      const method = word('an rpc name');
      const side = (): string => {
        expect('(');
        const first = word('a message type');
        if (first.text === 'stream') fail(first.line, 'stream is not read: the fake answers unary rpcs only');
        expect(')');
        return first.text;
      };
      const request = side();
      const returns = word('returns');
      if (returns.text !== 'returns') fail(returns.line, `expected returns, found "${returns.text}"`);
      const response = side();
      if (peek()?.text === '{') { next(); expect('}'); } else expect(';');
      service.rpcs.push({ name: method.text, request, response, line: method.line });
    }
  };

  const first = peek();
  if (first?.text !== 'syntax') fail(first?.line ?? 1, 'the file must start with syntax = "proto3";');
  next();
  expect('=');
  const syntax = next();
  if (syntax.text !== 'proto3' || syntax.kind !== 'string') fail(syntax.line, `the syntax must be "proto3", not ${JSON.stringify(syntax.text)}: the fake reads proto3 only`);
  expect(';');
  while (peek()) {
    const token = next();
    switch (token.text) {
      case ';': break;
      case 'package': pkg = word('a package name').text; expect(';'); break;
      case 'option': skipStatement(); break;
      case 'message': parseMessage(''); break;
      case 'enum': parseEnum(''); break;
      case 'service': parseService(); break;
      case 'import': fail(token.line, 'import is not read: a contract is one file, with the types it uses'); break;
      default: fail(token.line, `${token.text === 'extend' ? 'extend is not read' : `unexpected "${token.text}"`}`);
    }
  }

  // ---- names resolve from the scope outward, as protoc does ----
  const find = (scope: string, name: string, line: number): Message | Enum | undefined => {
    const bare = pkg && name.startsWith(`${pkg}.`) ? name.slice(pkg.length + 1) : name;
    const parts = scope === '' ? [] : scope.split('.');
    for (let n = parts.length; n >= 0; n -= 1) {
      const path = [...parts.slice(0, n), bare].join('.');
      const hit = messages.find((m) => m.path === path) ?? enums.find((e) => e.path === path);
      if (hit) return hit;
    }
    return line < 0 ? undefined : fail(line, `unknown type ${name}`);
  };
  for (const message of messages)
    for (const f of message.fields) {
      if (f.map && !SCALARS.has(f.map)) fail(f.line, `map key ${f.map} must be a scalar`);
      if (!SCALARS.has(f.type)) find(message.path, f.type, f.line);
    }
  for (const service of services)
    for (const rpc of service.rpcs) {
      for (const type of [rpc.request, rpc.response]) {
        const hit = find('', type, rpc.line);
        if (!hit || !('fields' in hit)) fail(rpc.line, `${type} is not a message`);
      }
    }

  // ---- the examples ----
  const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const scalar = (type: string): unknown => (type === 'string' ? 'string' : type === 'bytes' ? '' : type === 'bool' ? false : WIDE.has(type) ? '0' : 0);
  const value = (scope: string, type: string, stack: readonly string[]): unknown => {
    if (SCALARS.has(type)) return scalar(type);
    const hit = find(scope, type, -1) as Message | Enum;
    return 'fields' in hit ? example(hit, stack) : (hit.values[0] ?? 0);
  };
  const example = (message: Message, stack: readonly string[]): unknown => {
    if (stack.includes(message.path)) return undefined;
    const out: Record<string, unknown> = {};
    const seen = new Set<number>();
    for (const f of message.fields) {
      if (f.oneof !== null) { if (seen.has(f.oneof)) continue; seen.add(f.oneof); }
      const item = value(message.path, f.type, [...stack, message.path]);
      if (f.map) out[camel(f.name)] = item === undefined ? {} : { [f.map === 'bool' ? 'false' : SCALARS.has(f.map) && f.map !== 'string' ? '0' : 'key']: item };
      else if (f.repeated) out[camel(f.name)] = item === undefined ? [] : [item];
      else if (item !== undefined) out[camel(f.name)] = item;
    }
    return out;
  };
  const operations: ProtoOperation[] = [];
  for (const service of services)
    for (const rpc of service.rpcs) {
      const name = `${pkg ? `${pkg}.` : ''}${service.name}/${rpc.name}`;
      operations.push({ path: `/${name}`, name, body: example(find('', rpc.response, -1) as Message, []) });
    }
  return operations;
}
