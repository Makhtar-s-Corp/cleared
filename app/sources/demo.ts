// Demonstration data: invented tickets that cover every state the app can show.
// Used by the tests and by the screenshots; `cleared app --demo` serves it too.
import { createHash } from 'node:crypto';
import { message } from '../../lib/i18n.ts';

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

// The invented data speaks the language of the interface: the team's own words (questions, reports) are data, in the project's language.
export function demoSource(language = 'en') {
  const L = (en, fr) => (language === 'fr' ? fr : en);
  const M = (key, values) => message(key, language, values);
  const base = { ref: null, approval: null, options: [], questions: [], since: null, waiting: false, kind: 'normal', harness: '', model: '', flightMinutes: 0, quotaShare: 0, statusLine: '', screen: false, pr: null, change: null, queued: false, live: false, round: 0, tests: null, captures: null, reason: '' };
  const pull = (number, over = {}) => ({ pr: { number, url: `https://github.com/example-org/sample-app/pull/${number}` }, files: null, additions: null, deletions: null, lines: null, checks: null, draft: null, ...over });
  const tickets = [
    { ...base, id: 'EX-31', title: L('Payments already taken no longer count in what is left to pay', 'Les paiements déjà faits ne comptent plus dans ce qu’il reste à payer'), column: 'awaiting', waiting: true, kind: 'ready', since: iso(30),
      reason: M('app_srv_approval'), harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 84, quotaShare: 0.7, round: 1,
      statusLine: M('app_srv_tests_green', { n: '1 044' }), tests: 1044, screen: true, pr: { number: 88, url: 'https://github.com/example-org/sample-app/pull/88' },
      change: pull(88, { files: 3, additions: 42, deletions: 7, lines: 49, checks: 'green', draft: false }) },
    { ...base, id: 'EX-39', title: L('Freelancers: count the 30 days after social charges', 'Indépendants : compter les 30 jours après les charges sociales'), column: 'awaiting', waiting: true, kind: 'question', since: iso(95),
      reason: M('app_srv_question'), harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 33, quotaShare: 0.9, statusLine: L('a question is open', 'une question est ouverte'),
      pr: { number: 94, url: 'https://github.com/example-org/sample-app/pull/94' }, change: pull(94, { files: 2, additions: 18, deletions: 3, lines: 21, checks: 'running', draft: true }) },
    { ...base, id: 'EX-40', title: L('Rename the “Comings and goings” screen to “Upcoming”', 'Renommer l’écran « Départs et arrivées » en « À venir »'), column: 'awaiting', waiting: true, kind: 'question', since: iso(12),
      reason: M('app_srv_question'), harness: 'claude', model: 'claude-opus-5-5', flightMinutes: 2, quotaShare: 0.1, statusLine: L('a question is open', 'une question est ouverte'), screen: true,
      pr: { number: 97, url: 'https://github.com/example-org/sample-app/pull/97' }, change: pull(97, { files: 2, additions: 2, deletions: 2, lines: 4, checks: null, draft: true }) },
    { ...base, id: 'EX-34', title: L('Your typical month: you start working for yourself on the 29th', 'Votre mois type : vous travaillez pour vous à partir du 29'), column: 'review',
      harness: 'codex', model: 'gpt-6-luna', flightMinutes: 95, quotaShare: 0.4, round: 2, statusLine: M('app_srv_second_round'), pr: { number: 91, url: 'https://github.com/example-org/sample-app/pull/91' },
      change: pull(91, { files: 5, additions: 120, deletions: 31, lines: 151, checks: 'red', draft: false }) },
    { ...base, id: 'EX-36', title: L('Two reads crossing no longer leave a stale figure on screen', 'Deux lectures qui se croisent ne laissent plus un chiffre périmé à l’écran'), column: 'checks',
      harness: 'claude', model: 'claude-sonnet-5-5', flightMinutes: 70, quotaShare: 1.9, tests: 812, statusLine: L('checks running', 'contrôles en cours'), pr: { number: 93, url: 'https://github.com/example-org/sample-app/pull/93' },
      change: pull(93, { lines: 64, checks: 'running', draft: false }) },
    { ...base, id: 'EX-37', title: L('Create a fixed charge straight from a bank operation', 'Créer une charge fixe directement depuis une opération bancaire'), column: 'progress', live: true,
      harness: 'codex', model: 'gpt-6-sol', flightMinutes: 42, quotaShare: 0.6, statusLine: L('writing the form and its tests', 'écriture du formulaire et de ses tests'), screen: true },
    { ...base, id: 'EX-38', title: L('Previous months on an envelope: three fixes', 'Mois précédents sur une enveloppe : trois corrections'), column: 'progress', queued: true, kind: 'queued',
      reason: M('app_srv_queued'), harness: 'codex', model: 'gpt-6-luna' },
    // In progress in the tracker, but no team of Cleared was started on it: listed apart, not a team at work.
    { ...base, id: 'EX-30', title: L('Weekly summary by email', 'Résumé hebdomadaire par e-mail'), column: 'progress', kind: 'tracker', reason: M('app_srv_no_team'), statusLine: M('app_srv_no_team'), quotaShare: null },
    // An older ticket that sits in the tracker's approval status without any request from Cleared: shown apart, nothing to clear.
    { ...base, id: 'EX-29', title: L('Export the year as a spreadsheet', 'Exporter l’année dans un tableur'), column: 'awaiting', kind: 'tracker',
      reason: M('app_srv_tracker_only'), harness: 'claude', model: 'claude-sonnet-5-5', flightMinutes: 51, quotaShare: null },
  ];
  const before = image(L('Order page: before', 'Page commande : avant'), '#d9d3c4', [L('Delivery: 14 Nov', 'Livraison : 14 nov.'), L('[ contact support to change ]', '[ contacter le support pour changer ]')]);
  const after = image(L('Order page: after', 'Page commande : après'), '#d9d3c4', [L('Delivery: 14 Nov  [ change ]', 'Livraison : 14 nov.  [ changer ]'), L('Pick a date: 15 – 21 Nov', 'Choisir une date : 15 – 21 nov.')]);
  tickets[0].captures = { before, after };
  tickets[0].ref = 'EX-31'; tickets[0].approval = { at: iso(30), versions: [{ pr: 88, head: DEMO_HEAD }] };
  tickets[1].ref = 'EX-39'; tickets[1].options = [L('Yes, take the charges out first', 'Oui, retirer les charges d’abord'), L('No, count the full amount', 'Non, compter le montant complet')];
  tickets[1].questions = [{ text: L('For a freelancer, should social charges come out before we count the 30 days? With 4 500 earned and 1 000 of charges, we would count on 3 500 instead of 4 500.', 'Pour un indépendant, faut-il retirer les charges sociales avant de compter les 30 jours ? Avec 4 500 gagnés et 1 000 de charges, on compterait sur 3 500 au lieu de 4 500.'),
    recommendation: L('I recommend yes: the 30 days then show what the freelancer can really spend.', 'Je recommande oui : les 30 jours montrent alors ce que l’indépendant peut vraiment dépenser.'), options: tickets[1].options }];
  tickets[2].ref = 'EX-40';
  tickets[2].questions = [{ text: L('Should the Upcoming list also get its own heading, “Comings and goings”, above it? It has none today.', 'La liste « À venir » doit-elle aussi avoir son propre titre, « Départs et arrivées », au-dessus ? Elle n’en a pas aujourd’hui.'),
    recommendation: L('I recommend no: the page name, “Upcoming”, already says it, and a second heading would repeat it on a phone screen.', 'Je recommande non : le nom de la page, « À venir », le dit déjà, et un second titre le répéterait sur un écran de téléphone.'), options: [] }];
  tickets[7].ref = 'EX-29';
  for (const t of tickets) { t.trackerUrl = `https://tracker.example/issue/${t.id}`; }
  const squad = (...rows) => rows.map(([role, harness, model]) => ({ role, harness, model }));
  const report = (minutesAgo, done, remaining = []) => ({ at: iso(minutesAgo), done, remaining, other: [] });
  const details = {
    'EX-31': { where: [L('Rent paid on the 3rd now leaves what is left to pay that same day.', 'Le loyer payé le 3 sort de ce qu’il reste à payer le jour même.'), L('One rounding fix on “Upcoming” was asked in review, fixed and tested.', 'Une correction d’arrondi sur « À venir » a été demandée en relecture, corrigée et testée.')],
      report: report(40, [L('Payments already taken are no longer counted in what is left to pay: rent paid on the 3rd leaves 1 250 to pay that same day, not on the 5th (PR #88).', 'Les paiements déjà faits ne sont plus comptés dans ce qu’il reste à payer : le loyer payé le 3 enlève 1 250 à payer le jour même, pas le 5 (PR #88).'), L('The rounding the review asked for is fixed and tested.', 'L’arrondi demandé par la relecture est corrigé et testé.')]),
      squad: squad(['author', 'claude', 'claude-sonnet-5-5'], ['reviewer', 'claude', 'claude-opus-5-5']),
      show: { kind: 'screen', before: [{ url: before, caption: L('Before', 'Avant') }], after: [{ url: after, caption: L('After', 'Après') }], missing: null, example: null },
      blackBox: [[140, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [106, 'checks', L('Checks green, 1 044 tests', 'Contrôles au vert, 1 044 tests'), 'checks'], [98, 'review', M('app_srv_review_by', { who: 'Opus', outcome: M('app_srv_outcome_fix') }), 'review'], [60, 'fix', L('Reopened, fixed, test added', 'Rouvert, corrigé, test ajouté'), 'progress'], [30, 'ask', L('Clean review, waiting for you', 'Relecture propre, en attente de vous'), 'awaiting']] },
    'EX-39': { where: [],
      report: report(96, [L('The thirty-day estimate is ready for both ways of counting; nothing is switched on until you choose (PR #94).', 'L’estimation à trente jours est prête pour les deux façons de compter ; rien n’est activé avant votre choix (PR #94).')], [L('Switch on the way you choose, then add its test.', 'Activer la façon que vous choisissez, puis ajouter son test.')]),
      squad: squad(['author', 'claude', 'claude-opus-5-5']), show: { kind: 'code', example: { before: L('4 500 counted', '4 500 comptés'), after: L('3 500 counted (1 000 of charges taken out)', '3 500 comptés (1 000 de charges retirées)') }, tests: [], touches: '' },
      blackBox: [[150, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [95, 'asks', M('app_srv_ev_lane_asks'), 'awaiting']] },
    'EX-40': { where: [],
      report: report(13, [L('The screen title now reads “Upcoming” everywhere it appears; one test checks the new name (PR #97).', 'Le titre de l’écran s’écrit « À venir » partout ; un test vérifie le nouveau nom (PR #97).')], [L('Nothing else, unless you want the extra heading.', 'Rien d’autre, sauf si vous voulez le titre en plus.')]),
      squad: squad(['author', 'claude', 'claude-opus-5-5']), show: { kind: 'screen', before: [], after: [], missing: 'none_kept', example: { before: L('Comings and goings', 'Départs et arrivées'), after: L('Upcoming', 'À venir') } },
      blackBox: [[16, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [14, 'run', M('app_srv_team_started', { model: 'claude-opus-5-5' }), 'progress'], [13, 'handover', M('app_srv_handover_kept'), 'progress'], [12, 'asks', M('app_srv_ev_lane_asks'), 'awaiting']] },
    'EX-34': { where: [],
      report: report(45, [L('Your typical month now starts on the day you begin working for yourself (PR #91).', 'Votre mois type commence maintenant le jour où vous travaillez pour vous (PR #91).')], [L('A first review asked for a rounding fix; it is in a second round.', 'Une première relecture a demandé une correction d’arrondi ; elle est au second tour.')]),
      squad: squad(['author', 'codex', 'gpt-6-luna'], ['reviewer', 'claude', 'claude-sonnet-5-5']),
      show: { kind: 'code', example: { before: L('Typical month: 1 January to 31 January', 'Mois type : du 1er au 31 janvier'), after: L('Typical month: 29 January to 28 February', 'Mois type : du 29 janvier au 28 février') },
        tests: [{ name: L('typical month starts on the 29th', 'le mois type commence le 29'), state: 'pass', change: 'added' }, { name: L('typical month rounding', 'arrondi du mois type'), state: 'fail', change: 'modified' }], touches: L('It touches the calendar of the typical month.', 'Cela touche le calendrier du mois type.') },
      blackBox: [[140, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [95, 'run', M('app_srv_team_started', { model: 'gpt-6-luna' }), 'progress'], [40, 'review', M('app_srv_review_by', { who: 'Sonnet', outcome: M('app_srv_outcome_fix') }), 'review']] },
    'EX-36': { where: [], report: report(20, [L('Two reads that cross no longer leave a stale figure on screen (PR #93).', 'Deux lectures qui se croisent ne laissent plus un chiffre périmé à l’écran (PR #93).')], [L('Wait for the checks, then the review.', 'Attendre les contrôles, puis la relecture.')]), squad: squad(['author', 'claude', 'claude-sonnet-5-5']),
      show: { kind: 'code', example: null, tests: [{ name: L('crossing reads keep the latest figure', 'les lectures croisées gardent le dernier chiffre'), state: 'unknown', change: 'added' }], touches: '' },
      blackBox: [[90, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [70, 'run', M('app_srv_team_started', { model: 'claude-sonnet-5-5' }), 'progress'], [12, 'checks', 'Checks running', 'checks']] },
    'EX-37': { where: [], report: null, squad: squad(['author', 'codex', 'gpt-6-sol']),
      show: { kind: 'screen', before: [], after: [], missing: 'working', example: null }, blackBox: [[50, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [42, 'run', M('app_srv_team_started', { model: 'gpt-6-sol' }), 'progress']] },
    'EX-38': { where: [], report: null, squad: [], show: { kind: 'code', example: null, tests: [], touches: '' },
      blackBox: [[15, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress'], [14, 'queued', M('app_srv_ev_lane_limit_reached'), 'awaiting']] },
    'EX-30': { where: [], report: null, squad: [], show: { kind: 'code', example: null, tests: [], touches: '' }, blackBox: [[60 * 5, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress']] },
    'EX-29': { where: [], report: null, squad: squad(['author', 'claude', 'claude-sonnet-5-5']), show: { kind: 'code', example: null, tests: [], touches: '' },
      blackBox: [[60 * 26, 'opened', L('Opened by the engine', 'Ouvert par le moteur'), 'progress']] },
  };
  const state = {
    project: 'sample-app',
    health: { ok: false, problems: [{ code: 'wake_late', message: M('app_srv_problem_wake_late', { minutes: 4 }) }] },
    mode: { key: 'guarded', short: M('app_srv_mode_short'), label: M('app_srv_mode_guarded') },
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
      return structuredClone({ schema: 1, owner: { name: 'Alex' }, stats: { inFlight: 4, firstTimeClean: 78, lanes: { days: 7, fast: { minutes: 14, count: 3 }, full: { minutes: 212, count: 5 } } },
        landed: [{ at: today(7, 34), id: 'EX-12', title: L('Stale figures no longer survive two crossing reads', 'Les chiffres périmés ne survivent plus à deux lectures qui se croisent'), model: 'claude-opus-5-5', harness: 'claude', fixes: 0, rolledBackAt: null, share: 2.4, lane: 'full', totalMin: 188, workingMin: 41, humanWaitMin: 12, machineWaitMin: 135 },
          { at: today(9, 22), id: 'EX-15', title: L('The envelope sheet shows its previous months', 'La fiche d’enveloppe montre ses mois précédents'), model: 'claude-sonnet-5-5', harness: 'claude', fixes: 1, rolledBackAt: null, share: 1.9 },
          { at: today(11, 41), id: 'EX-21', title: L('Subscription logos', 'Logos des abonnements'), model: 'gpt-6-sol', harness: 'codex', fixes: 0, rolledBackAt: today(11, 49), share: 1.9, lane: 'fast', totalMin: 13, workingMin: 6, humanWaitMin: 3, machineWaitMin: 4 }],
        project: state.project, projects: [{ id: 'sample-app', name: 'sample-app' }], language, generatedAt: new Date().toISOString(),
        health: { ...state.health, recordedAt: iso(40 / 60) }, mode: state.mode, fuel: state.fuel, tickets });
    },
    async ticket(id) {
      const ticket = tickets.find((t) => t.id === id);
      if (!ticket) return null;
      const d = details[id];
      return { id, title: ticket.title, pr: ticket.pr, column: ticket.column, kind: ticket.kind, waiting: ticket.waiting, since: ticket.since, flightMinutes: ticket.flightMinutes, quotaShare: ticket.quotaShare, tests: ticket.tests,
        questions: ticket.questions, change: ticket.change, report: d.report, where: d.where, squad: d.squad, show: d.show, trackerUrl: ticket.trackerUrl,
        blackBox: d.blackBox.map(([ago, kind, text, stage]) => ({ at: iso(ago), kind, text, stage, raw: { kind, ticket: id, at: iso(ago) } })) };
    },
    async media(id) { return media.get(id) ?? null; },
  };
}
