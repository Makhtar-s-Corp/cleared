// The host tools' input schemas, turned into what the SDK's tool() takes
// (milestone 2 plan, lane 4). tool() of @anthropic-ai/claude-agent-sdk
// 0.3.306 takes a zod raw shape, not a JSON Schema (sdk.d.ts: tool<Schema
// extends AnyZodRawShape>), and the SDK converts that shape back to JSON
// Schema for the model. So the subset of session/contract.ts (JsonSchema) is
// built with the zod the image installs, which the runner passes in: the
// image copies this file next to main.ts and nothing else of the service,
// so it imports types only.
//
// Anything outside the subset is refused with the path of the key, never
// guessed: the host wrote the schema, and a tool the model sees with another
// schema than the host's would be a tool the host does not check.
import type { JsonSchema } from '../../../src/session/contract.ts';

// The part of zod 4's builder used here.
export type ZodTypeLike = { describe(text: string): ZodTypeLike; optional(): ZodTypeLike };
export type ZodLike = {
  string(): ZodTypeLike;
  number(): ZodTypeLike;
  boolean(): ZodTypeLike;
  enum(values: readonly [string, ...string[]]): ZodTypeLike;
  array(item: ZodTypeLike): ZodTypeLike;
  object(shape: Record<string, ZodTypeLike>): ZodTypeLike;
};

// A host tool as the start line carries it: what the model sees, without the handler.
export type HostToolSpec = { readonly name: string; readonly description: string; readonly inputSchema: JsonSchema & { readonly type: 'object' } };

const TOOL_NAME = /^[a-z_]+$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// Checks one schema of the subset, at `path`, and returns it typed.
function checked(value: unknown, path: string): JsonSchema {
  const schema = record(value);
  const at = path ? `${path}: ` : '';
  if (!schema) throw new Error(`${at}a schema is an object`);
  if (schema.description !== undefined && typeof schema.description !== 'string') throw new Error(`${at}a description is text`);
  switch (schema.type) {
    case 'string':
      if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error(`${at}an enum needs at least one value`);
        if (!schema.enum.every((v) => typeof v === 'string')) throw new Error(`${at}an enum holds strings only`);
      }
      return schema as JsonSchema;
    case 'number': case 'boolean':
      return schema as JsonSchema;
    case 'array':
      if (schema.items === undefined) throw new Error(`${at}an array needs items`);
      checked(schema.items, path ? `${path}[]` : '[]');
      return schema as JsonSchema;
    case 'object': {
      const properties = record(schema.properties);
      if (!properties) throw new Error(`${at}an object needs properties`);
      for (const [key, inner] of Object.entries(properties)) checked(inner, path ? `${path}.${key}` : key);
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)) throw new Error(`${at}required is a list`);
        for (const name of schema.required) if (typeof name !== 'string' || !(name in properties)) throw new Error(`${at}required names ${String(name)}, which is not a property`);
      }
      return schema as JsonSchema;
    }
    default:
      throw new Error(`${at}unsupported type ${String(schema.type)}`);
  }
}

function build(schema: JsonSchema, z: ZodLike): ZodTypeLike {
  let type: ZodTypeLike;
  switch (schema.type) {
    case 'string':
      type = schema.enum === undefined ? z.string() : z.enum(schema.enum as readonly [string, ...string[]]);
      break;
    case 'number': type = z.number(); break;
    case 'boolean': type = z.boolean(); break;
    case 'array': type = z.array(build(schema.items, z)); break;
    case 'object': type = z.object(shapeOf(schema, z)); break;
  }
  return schema.description === undefined ? type : type.describe(schema.description);
}

function shapeOf(schema: Extract<JsonSchema, { type: 'object' }>, z: ZodLike): Record<string, ZodTypeLike> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties).map(([key, inner]) => {
    const type = build(inner, z);
    return [key, required.has(key) ? type : type.optional()];
  }));
}

// A tool's input schema as tool()'s raw shape. Throws, naming the key, for
// anything outside the subset.
export function toZodShape(schema: JsonSchema & { readonly type: 'object' }, z: ZodLike): Record<string, ZodTypeLike> {
  const value = checked(schema, '');
  if (value.type !== 'object') throw new Error('the input schema must be an object');
  return shapeOf(value, z);
}

// The tools of a start line, checked: a list, each with a name of [a-z_]+
// given once, a description and an object schema of the subset.
export function hostToolsOf(value: unknown): HostToolSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('the host tools are a list');
  const seen = new Set<string>();
  return value.map((raw) => {
    const tool = record(raw);
    const name = tool?.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new Error(`tool name ${String(name)}: only a-z and _`);
    if (seen.has(name)) throw new Error(`a tool is given twice: ${name}`);
    seen.add(name);
    if (typeof tool?.description !== 'string' || tool.description === '') throw new Error(`${name}: a description is needed`);
    let schema: JsonSchema;
    try {
      schema = checked(tool.inputSchema, '');
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    if (schema.type !== 'object') throw new Error(`${name}: the input schema must be an object`);
    return { name, description: tool.description, inputSchema: schema };
  });
}
