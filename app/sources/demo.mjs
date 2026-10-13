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
  const base = { kind: 'normal', harness: '', model: '', flightMinutes: 0, quotaShare: 0, statusLine: '', screen: false, pr: null, queued: false, live: false, round: 0, tests: null, captures: null, reason: '' };
  const tickets = [
    { ...base, id: 'EX-31', title: 'Payments already taken no longer count in what is left to pay', column: 'awaiting', waiting: true, kind: 'ready',
      reason: 'Your approval is needed before this ships', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 84, quotaShare: 0.7, round: 1,
      statusLine: '1 044 tests green', tests: 1044, screen: true, pr: { number: 88, url: 'https://github.com/example-org/sample-app/pull/88' } },
    { ...base, id: 'EX-39', title: 'For a freelancer, take out social charges before counting the 30 days?', column: 'awaiting', waiting: true, kind: 'question',
      reason: '4 500 earned, 1 000 of charges: we count on 3 500. The squad recommends yes.', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 33, quotaShare: 0.9, statusLine: 'a question is open' },
    { ...base, id: 'EX-34', title: 'Your typical month: you start working for yourself on the 29th', column: 'review',
      harness: 'codex', model: 'gpt-6-luna', flightMinutes: 95, quotaShare: 0.4, round: 2, statusLine: 'second review round', pr: { number: 91, url: 'https://github.com/example-org/sample-app/pull/91' } },
    { ...base, id: 'EX-36', title: 'Two reads crossing no longer leave a stale figure on screen', column: 'checks',
      harness: 'claude', model: 'claude-sonnet-5-5', flightMinutes: 70, quotaShare: 1.9, tests: 812, statusLine: 'checks running', pr: { number: 93, url: 'https://github.com/example-org/sample-app/pull/93' } },
    { ...base, id: 'EX-37', title: 'Create a fixed charge straight from a bank operation', column: 'progress', live: true,
      harness: 'codex', model: 'gpt-6-sol', flightMinutes: 42, quotaShare: 0.6, statusLine: 'writing the form and its tests', screen: true },
    { ...base, id: 'EX-38', title: 'Previous months on an envelope: three fixes', column: 'progress', queued: true, kind: 'queued',
      reason: 'Waiting for a free slot on the machine', harness: 'codex', model: 'gpt-6-luna' },
  ];
  const before = image('Order page: before', '#d9d3c4', ['Delivery: 14 Nov', '[ contact support to change ]']);
  const after = image('Order page: after', '#d9d3c4', ['Delivery: 14 Nov  [ change ]', 'Pick a date: 15 – 21 Nov']);
  tickets[0].captures = { before, after };
  const squad = (...rows) => rows.map(([role, harness, model]) => ({ role, harness, model }));
  const details = {
    'EX-31': { where: ['Rent paid on the 3rd now leaves what is left to pay that same day.', 'One rounding fix on “Upcoming” was asked in review, fixed and tested.'],
      squad: squad(['author', 'claude', 'claude-sonnet-5-5'], ['reviewer', 'claude', 'claude-opus-5-5']),
      show: { kind: 'screen', before: [{ url: before, caption: 'Before' }], after: [{ url: after, caption: 'After' }] },
      blackBox: [[140, 'opened', 'Opened by the engine', 'progress'], [106, 'checks', 'Checks green, 1 044 tests', 'checks'], [98, 'review', 'Review by Opus, one fix asked', 'review'], [60, 'fix', 'Reopened, fixed, test added', 'progress'], [20, 'ask', 'Clean review, waiting for you', 'awaiting']] },
    'EX-39': { where: ['The team stopped on a question about social charges.', 'It recommends taking them out first.'],
      squad: squad(['author', 'claude', 'claude-opus-5-5']), show: { kind: 'code', example: { before: '4 500 counted', after: '3 500 counted (1 000 of charges taken out)' }, tests: [], touches: 'It touches the thirty-day estimate.' },
      blackBox: [[50, 'opened', 'Opened by the engine', 'progress'], [33, 'asks', 'The team asks a question', 'awaiting']] },
    'EX-34': { where: ['Your typical month now starts on the day you begin working for yourself.', 'A first review asked for a rounding fix; it is in a second round.'],
      squad: squad(['author', 'codex', 'gpt-6-luna'], ['reviewer', 'claude', 'claude-sonnet-5-5']),
      show: { kind: 'code', example: { before: 'Typical month: 1 January to 31 January', after: 'Typical month: 29 January to 28 February' },
        tests: [{ name: 'typical month starts on the 29th', state: 'pass', change: 'added' }, { name: 'typical month rounding', state: 'fail', change: 'modified' }], touches: 'It touches the calendar of the typical month.' },
      blackBox: [[140, 'opened', 'Opened by the engine', 'progress'], [95, 'run', 'Team started: gpt-6-luna', 'progress'], [40, 'review', 'Review by Sonnet, one fix asked', 'review']] },
    'EX-36': { where: ['Two reads that cross no longer leave a stale figure on screen.'], squad: squad(['author', 'claude', 'claude-sonnet-5-5']),
      show: { kind: 'code', example: null, tests: [{ name: 'crossing reads keep the latest figure', state: 'unknown', change: 'added' }], touches: 'It touches the figure refresh.' },
      blackBox: [[90, 'opened', 'Opened by the engine', 'progress'], [70, 'run', 'Team started: claude-sonnet-5-5', 'progress'], [12, 'checks', 'Checks running', 'checks']] },
    'EX-37': { where: ['The form to create a fixed charge from a bank operation is being written.'], squad: squad(['author', 'codex', 'gpt-6-sol']),
      show: { kind: 'screen', before: [{ url: before, caption: 'Before' }], after: [] }, blackBox: [[50, 'opened', 'Opened by the engine', 'progress'], [42, 'run', 'Team started: gpt-6-sol', 'progress']] },
    'EX-38': { where: ['This team has not started: the machine is full.'], squad: [], show: { kind: 'code', example: null, tests: [], touches: '' },
      blackBox: [[15, 'opened', 'Opened by the engine', 'progress'], [14, 'queued', 'Waiting for a free slot on the machine', 'awaiting']] },
  };
  const state = {
    project: 'sample-app',
    health: { ok: false, problems: [{ code: 'wake_late', message: 'wake has not reported for 4 min' }] },
    mode: { key: 'guarded', short: 'guarded mode', label: 'Guarded: you approve every application change' },
    fuel: [{ adapter: 'claude', measured: true, window: 'week', used: 62, left: 38, resetsAt: iso(-60 * 40) },
      { adapter: 'codex', measured: true, window: 'short', used: 9, left: 91, resetsAt: iso(-90) },
      { adapter: 'gemini', measured: false }],
  };
  return {
    // A test moves a card; the next read shows it, as the real source would.
    move(id, column) { tickets.find((t) => t.id === id).column = column; },
    async snapshot() {
      const today = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return new Date(Math.min(d.getTime(), Date.now() - 5 * 60000)).toISOString(); };
      return structuredClone({ schema: 1, owner: { name: 'Alex' }, stats: { inFlight: 4, firstTimeClean: 78 },
        landed: [{ at: today(7, 34), id: 'EX-12', title: 'Stale figures no longer survive two crossing reads', model: 'claude-opus-5-5', harness: 'claude', fixes: 0, rolledBackAt: null, share: 2.4 },
          { at: today(9, 22), id: 'EX-15', title: 'The envelope sheet shows its previous months', model: 'claude-sonnet-5-5', harness: 'claude', fixes: 1, rolledBackAt: null, share: 1.9 },
          { at: today(11, 41), id: 'EX-21', title: 'Subscription logos', model: 'gpt-6-sol', harness: 'codex', fixes: 0, rolledBackAt: today(11, 49), share: 1.9 }],
        project: state.project, projects: [{ id: 'sample-app', name: 'sample-app' }], language: 'en', generatedAt: new Date().toISOString(),
        health: { ...state.health, recordedAt: iso(40 / 60) }, mode: state.mode, fuel: state.fuel, tickets });
    },
    async ticket(id) {
      const ticket = tickets.find((t) => t.id === id);
      if (!ticket) return null;
      const d = details[id];
      return { id, title: ticket.title, pr: ticket.pr, column: ticket.column, kind: ticket.kind, waiting: ticket.waiting, flightMinutes: ticket.flightMinutes, quotaShare: ticket.quotaShare, tests: ticket.tests,
        where: d.where, squad: d.squad, show: d.show,
        blackBox: d.blackBox.map(([ago, kind, text, stage]) => ({ at: iso(ago), kind, text, stage, raw: { kind, ticket: id, at: iso(ago) } })) };
    },
    async media(id) { return media.get(id) ?? null; },
  };
}
