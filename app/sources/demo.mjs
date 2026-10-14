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

// The commit the demo asks agreement for, and the one that arrives after it.
export const DEMO_HEAD = 'a1b2c3d4e5'.repeat(4);
export const DEMO_HEAD_NEXT = 'f9e8d7c6b5'.repeat(4);
const NOW = () => Date.now();
const iso = (minutesAgo) => new Date(NOW() - minutesAgo * 60000).toISOString();

export function demoSource() {
  const base = { ref: null, approval: null, options: [], questions: [], since: null, waiting: false, kind: 'normal', harness: '', model: '', flightMinutes: 0, quotaShare: 0, statusLine: '', screen: false, pr: null, change: null, queued: false, live: false, round: 0, tests: null, captures: null, reason: '' };
  const pull = (number, over = {}) => ({ pr: { number, url: `https://github.com/example-org/sample-app/pull/${number}` }, files: null, additions: null, deletions: null, lines: null, checks: null, draft: null, ...over });
  const tickets = [
    { ...base, id: 'EX-31', title: 'Payments already taken no longer count in what is left to pay', column: 'awaiting', waiting: true, kind: 'ready', since: iso(30),
      reason: 'Your approval is needed before this ships', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 84, quotaShare: 0.7, round: 1,
      statusLine: '1 044 tests green', tests: 1044, screen: true, pr: { number: 88, url: 'https://github.com/example-org/sample-app/pull/88' },
      change: pull(88, { files: 3, additions: 42, deletions: 7, lines: 49, checks: 'green', draft: false }) },
    { ...base, id: 'EX-39', title: 'Freelancers: count the 30 days after social charges', column: 'awaiting', waiting: true, kind: 'question', since: iso(95),
      reason: 'A question for you', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 33, quotaShare: 0.9, statusLine: 'a question is open',
      pr: { number: 94, url: 'https://github.com/example-org/sample-app/pull/94' }, change: pull(94, { files: 2, additions: 18, deletions: 3, lines: 21, checks: 'running', draft: true }) },
    { ...base, id: 'EX-40', title: 'Rename the “Comings and goings” screen to “Upcoming”', column: 'awaiting', waiting: true, kind: 'question', since: iso(12),
      reason: 'A question for you', harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 2, quotaShare: 0.1, statusLine: 'a question is open', screen: true,
      pr: { number: 97, url: 'https://github.com/example-org/sample-app/pull/97' }, change: pull(97, { files: 2, additions: 2, deletions: 2, lines: 4, checks: null, draft: true }) },
    { ...base, id: 'EX-34', title: 'Your typical month: you start working for yourself on the 29th', column: 'review',
      harness: 'codex', model: 'gpt-6-luna', flightMinutes: 95, quotaShare: 0.4, round: 2, statusLine: 'second review round', pr: { number: 91, url: 'https://github.com/example-org/sample-app/pull/91' },
      change: pull(91, { files: 5, additions: 120, deletions: 31, lines: 151, checks: 'red', draft: false }) },
    { ...base, id: 'EX-36', title: 'Two reads crossing no longer leave a stale figure on screen', column: 'checks',
      harness: 'claude', model: 'claude-sonnet-5-5', flightMinutes: 70, quotaShare: 1.9, tests: 812, statusLine: 'checks running', pr: { number: 93, url: 'https://github.com/example-org/sample-app/pull/93' },
      change: pull(93, { lines: 64, checks: 'running', draft: false }) },
    { ...base, id: 'EX-37', title: 'Create a fixed charge straight from a bank operation', column: 'progress', live: true,
      harness: 'codex', model: 'gpt-6-sol', flightMinutes: 42, quotaShare: 0.6, statusLine: 'writing the form and its tests', screen: true },
    { ...base, id: 'EX-38', title: 'Previous months on an envelope: three fixes', column: 'progress', queued: true, kind: 'queued',
      reason: 'Waiting for a free slot on the machine', harness: 'codex', model: 'gpt-6-luna' },
    // An older ticket that sits in the tracker's approval status without any request from Cleared: shown apart, nothing to clear.
    { ...base, id: 'EX-29', title: 'Export the year as a spreadsheet', column: 'awaiting', kind: 'tracker',
      reason: 'In the tracker’s approval status; Cleared has not asked you for a version', harness: 'claude', model: 'claude-sonnet-5-5', flightMinutes: 51, quotaShare: null },
  ];
  const before = image('Order page: before', '#d9d3c4', ['Delivery: 14 Nov', '[ contact support to change ]']);
  const after = image('Order page: after', '#d9d3c4', ['Delivery: 14 Nov  [ change ]', 'Pick a date: 15 – 21 Nov']);
  tickets[0].captures = { before, after };
  tickets[0].ref = 'EX-31'; tickets[0].approval = { at: iso(30), versions: [{ pr: 88, head: DEMO_HEAD }] };
  tickets[1].ref = 'EX-39'; tickets[1].options = ['Yes, take the charges out first', 'No, count the full amount'];
  tickets[1].questions = [{ text: 'For a freelancer, should social charges come out before we count the 30 days? With 4 500 earned and 1 000 of charges, we would count on 3 500 instead of 4 500.',
    recommendation: 'I recommend yes: the 30 days then show what the freelancer can really spend.', options: tickets[1].options }];
  tickets[2].ref = 'EX-40';
  tickets[2].questions = [{ text: 'Should the Upcoming list also get its own heading, “Comings and goings”, above it? It has none today.',
    recommendation: 'I recommend no: the page name, “Upcoming”, already says it, and a second heading would repeat it on a phone screen.', options: [] }];
  tickets[7].ref = 'EX-29';
  const squad = (...rows) => rows.map(([role, harness, model]) => ({ role, harness, model }));
  const report = (minutesAgo, done, remaining = []) => ({ at: iso(minutesAgo), done, remaining, other: [] });
  const details = {
    'EX-31': { where: ['Rent paid on the 3rd now leaves what is left to pay that same day.', 'One rounding fix on “Upcoming” was asked in review, fixed and tested.'],
      report: report(40, ['Payments already taken are no longer counted in what is left to pay: rent paid on the 3rd leaves 1 250 to pay that same day, not on the 5th (PR #88).', 'The rounding the review asked for is fixed and tested.']),
      squad: squad(['author', 'claude', 'claude-sonnet-5-5'], ['reviewer', 'claude', 'claude-opus-5-5']),
      show: { kind: 'screen', before: [{ url: before, caption: 'Before' }], after: [{ url: after, caption: 'After' }], missing: null, example: null },
      blackBox: [[140, 'opened', 'Opened by the engine', 'progress'], [106, 'checks', 'Checks green, 1 044 tests', 'checks'], [98, 'review', 'Review by Opus, one fix asked', 'review'], [60, 'fix', 'Reopened, fixed, test added', 'progress'], [30, 'ask', 'Clean review, waiting for you', 'awaiting']] },
    'EX-39': { where: [],
      report: report(96, ['The thirty-day estimate is ready for both ways of counting; nothing is switched on until you choose (PR #94).'], ['Switch on the way you choose, then add its test.']),
      squad: squad(['author', 'claude', 'claude-opus-5-5']), show: { kind: 'code', example: { before: '4 500 counted', after: '3 500 counted (1 000 of charges taken out)' }, tests: [], touches: '' },
      blackBox: [[150, 'opened', 'Opened by the engine', 'progress'], [95, 'asks', 'The team asks a question', 'awaiting']] },
    'EX-40': { where: [],
      report: report(13, ['The screen title now reads “Upcoming” everywhere it appears; one test checks the new name (PR #97).'], ['Nothing else, unless you want the extra heading.']),
      squad: squad(['author', 'claude', 'claude-opus-5-5']), show: { kind: 'screen', before: [], after: [], missing: 'none_kept', example: { before: 'Comings and goings', after: 'Upcoming' } },
      blackBox: [[16, 'opened', 'Opened by the engine', 'progress'], [14, 'run', 'Team started: claude-opus-5-5', 'progress'], [13, 'handover', 'The team kept a handover for its next session (internal)', 'progress'], [12, 'asks', 'The team asks a question', 'awaiting']] },
    'EX-34': { where: [],
      report: report(45, ['Your typical month now starts on the day you begin working for yourself (PR #91).'], ['A first review asked for a rounding fix; it is in a second round.']),
      squad: squad(['author', 'codex', 'gpt-6-luna'], ['reviewer', 'claude', 'claude-sonnet-5-5']),
      show: { kind: 'code', example: { before: 'Typical month: 1 January to 31 January', after: 'Typical month: 29 January to 28 February' },
        tests: [{ name: 'typical month starts on the 29th', state: 'pass', change: 'added' }, { name: 'typical month rounding', state: 'fail', change: 'modified' }], touches: 'It touches the calendar of the typical month.' },
      blackBox: [[140, 'opened', 'Opened by the engine', 'progress'], [95, 'run', 'Team started: gpt-6-luna', 'progress'], [40, 'review', 'Review by Sonnet, one fix asked', 'review']] },
    'EX-36': { where: [], report: report(20, ['Two reads that cross no longer leave a stale figure on screen (PR #93).'], ['Wait for the checks, then the review.']), squad: squad(['author', 'claude', 'claude-sonnet-5-5']),
      show: { kind: 'code', example: null, tests: [{ name: 'crossing reads keep the latest figure', state: 'unknown', change: 'added' }], touches: '' },
      blackBox: [[90, 'opened', 'Opened by the engine', 'progress'], [70, 'run', 'Team started: claude-sonnet-5-5', 'progress'], [12, 'checks', 'Checks running', 'checks']] },
    'EX-37': { where: [], report: null, squad: squad(['author', 'codex', 'gpt-6-sol']),
      show: { kind: 'screen', before: [], after: [], missing: 'working', example: null }, blackBox: [[50, 'opened', 'Opened by the engine', 'progress'], [42, 'run', 'Team started: gpt-6-sol', 'progress']] },
    'EX-38': { where: [], report: null, squad: [], show: { kind: 'code', example: null, tests: [], touches: '' },
      blackBox: [[15, 'opened', 'Opened by the engine', 'progress'], [14, 'queued', 'Waiting for a free slot on the machine', 'awaiting']] },
    'EX-29': { where: [], report: null, squad: squad(['author', 'claude', 'claude-sonnet-5-5']), show: { kind: 'code', example: null, tests: [], touches: '' },
      blackBox: [[60 * 26, 'opened', 'Opened by the engine', 'progress']] },
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
    // A newer commit arrives: the request for agreement is made again for it.
    newVersion(id, next = DEMO_HEAD_NEXT) { const t = tickets.find((x) => x.id === id); t.approval = { at: iso(0), versions: t.approval.versions.map((v) => ({ ...v, head: next })) }; },
    // The agent asks again for the same commit: a new request, the old agreement no longer answers it.
    askAgain(id) { const t = tickets.find((x) => x.id === id); t.approval = { ...t.approval, at: new Date(Date.now() + 1000).toISOString() }; },
    // The user's agreement, as the real tracker would show it on the next wake.
    cleared(id) { tickets.find((t) => t.id === id).column = 'review'; },
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
      return { id, title: ticket.title, pr: ticket.pr, column: ticket.column, kind: ticket.kind, waiting: ticket.waiting, since: ticket.since, flightMinutes: ticket.flightMinutes, quotaShare: ticket.quotaShare, tests: ticket.tests,
        questions: ticket.questions, change: ticket.change, report: d.report, where: d.where, squad: d.squad, show: d.show,
        blackBox: d.blackBox.map(([ago, kind, text, stage]) => ({ at: iso(ago), kind, text, stage, raw: { kind, ticket: id, at: iso(ago) } })) };
    },
    async media(id) { return media.get(id) ?? null; },
  };
}
