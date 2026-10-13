// The shape of every event sent to the browser. One envelope, stable names:
//
//   { id, type, at, data }
//
// `type` is a dotted name; `data` is plain JSON. See docs/app.md for the
// mapping to AG-UI, planned for later without any AG-UI library today.
export const EVENT_TYPES = ['snapshot', 'ticket.updated', 'ticket.removed', 'fuel.updated', 'health.updated', 'stats.updated', 'heartbeat'];

let counter = 0;
export function envelope(type, data, now = Date.now()) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown event type: ${type}`);
  counter += 1;
  return { id: counter, type, at: new Date(now).toISOString(), data };
}
export const frame = (event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What changed between two snapshots, as events (never the whole thing twice).
export function diffSnapshots(before, after, now = Date.now()) {
  const events = [];
  const old = new Map(before.tickets.map((t) => [t.id, t]));
  const next = new Set(after.tickets.map((t) => t.id));
  for (const ticket of after.tickets) if (!same(old.get(ticket.id), ticket)) events.push(envelope('ticket.updated', ticket, now));
  for (const id of old.keys()) if (!next.has(id)) events.push(envelope('ticket.removed', { id }, now));
  if (!same(before.fuel, after.fuel)) events.push(envelope('fuel.updated', after.fuel, now));
  if (!same([before.stats, before.landed, before.owner], [after.stats, after.landed, after.owner])) events.push(envelope('stats.updated', { stats: after.stats, landed: after.landed, owner: after.owner }, now));
  if (!same(before.health, after.health) || !same(before.mode, after.mode)) events.push(envelope('health.updated', { health: after.health, mode: after.mode }, now));
  return events;
}
