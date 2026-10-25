import test from 'node:test';
import assert from 'node:assert/strict';
import { hostToolsOf, toZodShape, type ZodLike, type ZodTypeLike } from '../../images/session/runner/schema.ts';
import { LEAD_TOOLS } from '../../src/lead/contract.ts';

// A stand-in for zod 4's builder: each call returns a plain record of what
// was built, so a test can compare it with deepEqual. The image's real zod
// is exercised by the doctor's host-tools section.
type Built = { kind: string; values?: readonly string[]; item?: Built; shape?: Record<string, Built>; description?: string; optional?: true };
function standIn(): ZodLike {
  const make = (built: Built): ZodTypeLike & { built: Built } => ({
    built,
    describe: (text: string) => make({ ...built, description: text }),
    optional: () => make({ ...built, optional: true }),
  });
  const of = (type: ZodTypeLike) => (type as unknown as { built: Built }).built;
  return {
    string: () => make({ kind: 'string' }),
    number: () => make({ kind: 'number' }),
    boolean: () => make({ kind: 'boolean' }),
    enum: (values) => make({ kind: 'enum', values }),
    array: (item) => make({ kind: 'array', item: of(item) }),
    object: (shape) => make({ kind: 'object', shape: Object.fromEntries(Object.entries(shape).map(([key, type]) => [key, of(type)])) }),
  };
}
const built = (shape: Record<string, ZodTypeLike>) => Object.fromEntries(Object.entries(shape).map(([key, type]) => [key, (type as unknown as { built: Built }).built]));

test('the schema subset becomes a zod raw shape: required keys as they are, the others optional, descriptions kept', () => {
  const shape = toZodShape({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What you will do.' },
      due: { type: 'string', description: 'When.' },
      lane: { type: 'string', enum: ['fast', 'full'] },
      count: { type: 'number' },
      urgent: { type: 'boolean' },
      after: { type: 'array', items: { type: 'number' }, description: 'Positions.' },
      items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    },
    required: ['text', 'lane', 'count', 'urgent', 'after', 'items'],
  }, standIn());
  assert.deepEqual(built(shape), {
    text: { kind: 'string', description: 'What you will do.' },
    due: { kind: 'string', description: 'When.', optional: true },
    lane: { kind: 'enum', values: ['fast', 'full'] },
    count: { kind: 'number' },
    urgent: { kind: 'boolean' },
    after: { kind: 'array', item: { kind: 'number' }, description: 'Positions.' },
    items: { kind: 'array', item: { kind: 'object', shape: { title: { kind: 'string' } } } },
  });
});

test('a schema without required makes every key optional; an empty object is an empty shape', () => {
  assert.deepEqual(built(toZodShape({ type: 'object', properties: { a: { type: 'string' } } }, standIn())), { a: { kind: 'string', optional: true } });
  assert.deepEqual(toZodShape({ type: 'object', properties: {}, required: [] }, standIn()), {});
});

test('every tool of the lead contract converts', () => {
  for (const tool of LEAD_TOOLS) assert.doesNotThrow(() => toZodShape(tool.inputSchema, standIn()), tool.name);
  const plan = built(toZodShape(LEAD_TOOLS.find((tool) => tool.name === 'propose_plan')?.inputSchema ?? { type: 'object', properties: {} }, standIn()));
  assert.equal(plan.items?.kind, 'array');
  assert.deepEqual(plan.items?.item?.shape?.size, { kind: 'enum', values: ['xs', 's', 'm', 'l'], description: 'The size of the change.' });
});

test('anything outside the subset is refused, never guessed', () => {
  const z = standIn();
  for (const [schema, reason] of [
    [{ type: 'string', properties: {} }, /must be an object/],
    [{ type: 'object' }, /properties/],
    [{ type: 'object', properties: { a: { type: 'integer' } } }, /a: unsupported type integer/],
    [{ type: 'object', properties: { a: { type: 'string', enum: [] } } }, /a: an enum needs at least one value/],
    [{ type: 'object', properties: { a: { type: 'string', enum: ['x', 1] } } }, /a: an enum holds strings only/],
    [{ type: 'object', properties: { a: { type: 'array' } } }, /a: an array needs items/],
    [{ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'null' } } } } }, /a\.b: unsupported type null/],
    [{ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, /required names b, which is not a property/],
    [{ type: 'object', properties: { a: { type: 'string', description: 3 } } }, /a: a description is text/],
  ] as const) assert.throws(() => toZodShape(schema as never, z), reason, JSON.stringify(schema));
});

test('the start line\'s tools are checked: names [a-z_]+, unique, a description, an object schema', () => {
  const schema = { type: 'object', properties: {} };
  assert.deepEqual(hostToolsOf(undefined), []);
  assert.deepEqual(hostToolsOf([{ name: 'ping', description: 'Ping.', inputSchema: schema }]), [{ name: 'ping', description: 'Ping.', inputSchema: schema }]);
  for (const [tools, reason] of [
    ['ping', /a list/],
    [[{ name: 'Ping', description: 'x', inputSchema: schema }], /tool name Ping/],
    [[{ name: 'ping-pong', description: 'x', inputSchema: schema }], /tool name ping-pong/],
    [[{ name: 'ping', description: 'x', inputSchema: schema }, { name: 'ping', description: 'y', inputSchema: schema }], /twice: ping/],
    [[{ name: 'ping', inputSchema: schema }], /ping: a description/],
    [[{ name: 'ping', description: 'x', inputSchema: { type: 'string' } }], /ping: .*must be an object/],
  ] as const) assert.throws(() => hostToolsOf(tools as never), reason, JSON.stringify(tools));
});
