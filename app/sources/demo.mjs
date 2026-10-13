// Demonstration data: invented tickets that cover every state the app can show.
// Used by the tests and by the screenshots; `cleared app --demo` serves it too.
import { createHash } from 'node:crypto';

const svg = (title, tone, lines) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
<rect width="640" height="400" fill="#f4f1ea"/><rect x="0" y="0" width="640" height="48" fill="${tone}"/>
<text x="20" y="31" font-family="monospace" font-size="18" fill="#1d1b17">${title}</text>
${lines.map((l, i) => `<text x="24" y="${110 + i * 44}" font-family="monospace" font-size="16" fill="#1d1b17">${l}</text>`).join('')}</svg>`;
const media = new Map();
const image = (title, tone, lines) => {
  const body = Buffer.from(svg(title, tone, lines));
  const id = createHash('sha256').update(body).digest('hex');
  media.set(id, { mime: 'image/svg+xml', body });
  return `/media/${id}`;
};

const NOW = () => Date.now();
const iso = (minutesAgo) => new Date(NOW() - minutesAgo * 60000).toISOString();

export function demoSource() {
  const tickets = [
    { id: 'EX-31', title: 'Let a customer change the delivery date from the order page', column: 'awaiting', waiting: true,
      reason: 'Your approval is needed before this ships', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 212,
      quotaShare: 6.4, statusLine: '1 044 tests green', screen: true, pr: { number: 88, url: 'https://github.com/example-org/sample-app/pull/88' } },
    { id: 'EX-34', title: 'Show the invoice total with and without tax', column: 'review', waiting: false,
      harness: 'codex', model: 'gpt-6-luna', flightMinutes: 95, quotaShare: 2.1, statusLine: 'second review round', screen: false, pr: { number: 91, url: 'https://github.com/example-org/sample-app/pull/91' } },
    { id: 'EX-36', title: 'Stop duplicate emails when a payment is retried', column: 'checks', waiting: false,
      harness: 'claude', model: 'claude-sonnet-5-5', flightMinutes: 41, quotaShare: 1.2, statusLine: '3 checks running', screen: false, pr: { number: 93, url: 'https://github.com/example-org/sample-app/pull/93' } },
    { id: 'EX-37', title: 'Rename the “Basket” tab to “Order”', column: 'progress', waiting: false,
      harness: 'claude', model: 'claude-haiku-4-5', flightMinutes: 12, quotaShare: 0.3, statusLine: 'writing the change', screen: true, pr: null },
    { id: 'EX-38', title: 'Export the monthly report as a spreadsheet', column: 'progress', waiting: false, queued: true,
      reason: 'Waiting for a place on the machine (1 of 1 teams open)', harness: 'codex', model: 'gpt-6-luna', flightMinutes: 0, quotaShare: 0, statusLine: 'not started', screen: false, pr: null },
    { id: 'EX-39', title: 'Ask the owner which carrier to use for large parcels', column: 'awaiting', waiting: true,
      reason: 'A question for you', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 33, quotaShare: 0.9, statusLine: 'a question is open', screen: false, pr: null },
  ];
  const before = image('Order page: before', '#d9d3c4', ['Delivery: 14 Nov', '[ contact support to change ]']);
  const after = image('Order page: after', '#d9d3c4', ['Delivery: 14 Nov  [ change ]', 'Pick a date: 15 – 21 Nov']);
  const details = {
    'EX-31': { where: ['The customer can now pick another delivery date from the order page.', 'All checks pass and a different model reviewed it with one fix.', 'It needs your approval before it ships.'],
      squad: [{ role: 'author', harness: 'claude', model: 'claude-opus-5-5' }, { role: 'reviewer', harness: 'claude', model: 'claude-sonnet-5-5' }, { role: 'project lead', harness: 'claude', model: 'claude-opus-5-5' }],
      show: { kind: 'screen', before: [{ url: before, caption: 'Order page, before' }], after: [{ url: after, caption: 'Order page, after' }] },
      blackBox: [[260, 'opened', 'Opened by the engine'], [212, 'run', 'Team started: claude-opus-5-5'], [120, 'review', 'Review by Sonnet: one fix requested'], [90, 'fix', 'Reopened, fixed, test added'], [30, 'review', 'Review by Sonnet: approved'], [20, 'ask', 'Approval requested']] },
    'EX-34': { where: ['The invoice now shows the total with and without tax.', 'A first review asked for a rounding fix; it is in a second round.'],
      squad: [{ role: 'author', harness: 'codex', model: 'gpt-6-luna' }, { role: 'reviewer', harness: 'claude', model: 'claude-opus-5-5' }],
      show: { kind: 'code', example: { before: 'Total: 120.00', after: 'Total: 100.00 excl. tax · 120.00 incl. tax' },
        tests: [{ name: 'invoice total with tax', state: 'pass', change: 'added' }, { name: 'invoice rounding', state: 'fail', change: 'modified' }], touches: 'It touches the invoice calculation and the PDF template.' },
      blackBox: [[140, 'opened', 'Opened by the engine'], [95, 'run', 'Team started: gpt-6-luna'], [40, 'review', 'Review by Opus: one fix requested']] },
    'EX-36': { where: ['Retried payments no longer send a second confirmation email.'], squad: [{ role: 'author', harness: 'claude', model: 'claude-sonnet-5-5' }],
      show: { kind: 'code', example: null, tests: [{ name: 'retry sends one email', state: 'unknown', change: 'added' }], touches: 'It touches the payment retry job.' },
      blackBox: [[60, 'opened', 'Opened by the engine'], [41, 'run', 'Team started: claude-sonnet-5-5']] },
    'EX-37': { where: ['The tab is being renamed.'], squad: [{ role: 'author', harness: 'claude', model: 'claude-haiku-4-5' }],
      show: { kind: 'screen', before: [{ url: before, caption: 'Before' }], after: [] }, blackBox: [[20, 'opened', 'Opened by the engine'], [12, 'run', 'Team started: claude-haiku-4-5']] },
    'EX-38': { where: ['This team has not started: the machine is full.'], squad: [], show: { kind: 'code', example: null, tests: [], touches: '' },
      blackBox: [[15, 'opened', 'Opened by the engine'], [14, 'queued', 'Waiting for a place on the machine']] },
    'EX-39': { where: ['The team stopped on a question about carriers.'], squad: [{ role: 'author', harness: 'claude', model: 'claude-opus-5-5' }],
      show: { kind: 'code', example: null, tests: [], touches: '' }, blackBox: [[50, 'opened', 'Opened by the engine'], [33, 'asks', 'The team asks a question']] },
  };
  const state = {
    project: 'sample-app',
    health: { ok: false, problems: [{ code: 'tracker_unreachable', message: 'The ticket tracker did not answer for 12 minutes.' }] },
    mode: { key: 'guarded', label: 'Guarded: you approve every application change' },
    fuel: [{ adapter: 'claude', measured: true, window: 'week', used: 62, resetsAt: iso(-60 * 40) },
      { adapter: 'codex', measured: true, window: 'short', used: 91, resetsAt: iso(-90) },
      { adapter: 'gemini', measured: false }],
  };
  return {
    // A test moves a card; the next read shows it, as the real source would.
    move(id, column) { tickets.find((t) => t.id === id).column = column; },
    async snapshot() {
      return structuredClone({ schema: 1, project: state.project, projects: [{ id: 'sample-app', name: 'sample-app' }], language: 'en', generatedAt: new Date().toISOString(),
        health: state.health, mode: state.mode, fuel: state.fuel, tickets });
    },
    async ticket(id) {
      const ticket = tickets.find((t) => t.id === id);
      if (!ticket) return null;
      const d = details[id];
      return { id, title: ticket.title, pr: ticket.pr, where: d.where, squad: d.squad, show: d.show,
        blackBox: d.blackBox.map(([ago, kind, text]) => ({ at: iso(ago), kind, text, raw: { kind, ticket: id, at: iso(ago) } })) };
    },
    async media(id) { return media.get(id) ?? null; },
  };
}
