// The events contract (fake.ts, owner decision O11): AsyncAPI 2, in the YAML
// subset yaml.ts reads or in JSON. Each channel is one path of the fake:
//   GET  /events/<channel>   the channel's message example (its first
//                            `examples` payload, else a payload generated
//                            from its schema, else a 501 naming the channel)
//   POST /events/<channel>   202 {accepted: true}: the fake takes a
//                            publication, and /__fake/calls counts it
// A channel's name is letters, digits and `_ . : -`, so it is one path
// segment. AsyncAPI 3, a `message` that is a `oneOf`, and bindings are not
// read.
import { generate, isObject, OMIT, resolveRef, SchemaError } from './schema.ts';

export type EventOperation = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly answer: { readonly status: number; readonly body: unknown } | null;
};

export function eventOperations(document: unknown, file: string): EventOperation[] {
  if (!isObject(document) || typeof document.asyncapi !== 'string' || !document.asyncapi.startsWith('2.'))
    throw new SchemaError(`${file} is not an AsyncAPI 2 document: the events format reads AsyncAPI 2 only`);
  if (!isObject(document.channels) || Object.keys(document.channels).length === 0) throw new SchemaError(`${file} has no channels`);
  const operations: EventOperation[] = [];
  for (const [name, item] of Object.entries(document.channels)) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(name)) throw new SchemaError(`${file}: channel ${name} must be letters, digits and _ . : - only, to be one path of the fake`);
    const path = `/events/${name}`;
    const operation = isObject(item) ? (isObject(item.subscribe) ? item.subscribe : isObject(item.publish) ? item.publish : undefined) : undefined;
    let message: unknown = operation?.message;
    if (isObject(message) && typeof message.$ref === 'string') message = resolveRef(document, message.$ref);
    let body: unknown = OMIT;
    if (isObject(message)) {
      const first = Array.isArray(message.examples) ? message.examples[0] : undefined;
      if (isObject(first) && 'payload' in first) body = first.payload;
      else if (message.payload !== undefined) body = generate(message.payload, document);
    }
    operations.push({ method: 'GET', path, answer: body === OMIT ? null : { status: 200, body } });
    operations.push({ method: 'POST', path, answer: { status: 202, body: { accepted: true } } });
  }
  return operations;
}
