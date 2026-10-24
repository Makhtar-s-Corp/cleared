// The example a JSON Schema stands for, shared by the JSON Schema reader and
// the events reader (fake.ts, events.ts). No validator: the fake answers, it
// does not check. An example is, in order: `example`, the first of
// `examples`, `default`, `const`, the first of `enum`, then what the type
// says, going down `properties`, `items`, `allOf` (merged), and the first of
// `oneOf` and `anyOf`. A `$ref` is read inside the document only
// (`#/...`); one that leads back into itself leaves its property out.
// The strings are plain words: never a shape a secret could have.
export class SchemaError extends Error {
  override name = 'SchemaError';
}

export const OMIT: unique symbol = Symbol('omit');
export type Generated = unknown | typeof OMIT;

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const FORMATS: Readonly<Record<string, string>> = {
  'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00Z',
  uuid: '00000000-0000-0000-0000-000000000000',
  email: 'user@example.com',
  uri: 'https://example.com/',
};

// The value a local `$ref` points to.
export function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new SchemaError(`$ref ${JSON.stringify(ref)}: only a local $ref (#/...) is read`);
  let at: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isObject(at) || !(key in at)) throw new SchemaError(`$ref ${ref} is not in the document (${key} is missing)`);
    at = at[key];
  }
  return at;
}

export function generate(schema: unknown, root: unknown, stack: readonly string[] = []): Generated {
  if (!isObject(schema)) return {};
  if (typeof schema.$ref === 'string') {
    if (stack.includes(schema.$ref)) return OMIT;
    return generate(resolveRef(root, schema.$ref), root, [...stack, schema.$ref]);
  }
  if ('example' in schema) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if ('default' in schema) return schema.default;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const parts = schema.allOf.map((part) => generate(part, root, stack));
    return parts.every(isObject) ? Object.assign({}, ...parts) : parts[0];
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) return generate(options[0], root, stack);
  }
  const declared = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  const type = typeof declared === 'string' ? declared : isObject(schema.properties) ? 'object' : schema.items !== undefined ? 'array' : undefined;
  const bound = typeof schema.minimum === 'number' ? schema.minimum : 0;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      if (isObject(schema.properties))
        for (const [name, property] of Object.entries(schema.properties)) {
          const value = generate(property, root, stack);
          if (value !== OMIT) out[name] = value;
        }
      return out;
    }
    case 'array': {
      const item = schema.items === undefined ? OMIT : generate(schema.items, root, stack);
      return item === OMIT ? [] : [item];
    }
    case 'string': return typeof schema.format === 'string' ? FORMATS[schema.format] ?? 'string' : 'string';
    case 'integer':
    case 'number': return bound;
    case 'boolean': return false;
    case 'null': return null;
    default: return {};
  }
}
