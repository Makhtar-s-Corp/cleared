// A permission request as the inbox says it (docs/v2/ui-overhaul-plan.md,
// 2.5.1 to 2.5.5, lane 37): its intent as the title, in the person's
// language, whatever the harness wrote; the request as a question; the
// command folded one part per line; the reason by its code, the policy's
// own sentence when there is no code; the handled and the expired items in
// one folded group under what waits; the three answers on the row from
// 1280 px; and A, T and R on the item shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionItem, ReasonCode } from '../../../src/api/types.ts';
import { REVIEW_COMMAND, inboxFixture, requestItems } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../../web/lib/i18n.ts';
import {
  ROW_ANSWERS_MIN, closesOnEscape, foldOf, foldOpen, inboxKey, itemTitle, ordered, permissionAsk, permissionTitle, reasonOf, rowAnswers,
  type InboxView, type Item,
} from '../../web/screens/inbox/model.ts';
import { SCREEN_KEYS, keyLabel, sheetRows } from '../../web/shell/keys.ts';

// The screen's translator holds the shell's catalog under its own, as the shell gives it.
const translate = (language: 'en' | 'fr'): Translate => translator({ ...loadCatalog('shell', language), ...loadCatalog('inbox', language) });
const fr = translate('fr');
const en = translate('en');

const fixture = inboxFixture(FIXTURE_NOW);
const requests = requestItems(FIXTURE_NOW, { reviewer: { id: 'fixture-158-review', ticket: 'LOCAL-158' }, author: { id: 'fixture-160', ticket: 'LOCAL-160' } });
const compound = requests.find((item) => item.kind === 'permission' && item.state === 'waiting') as PermissionItem;
const expired = requests.find((item) => item.id.endsWith(':request-expired')) as PermissionItem;

const command = (text: string, extra: Partial<PermissionItem> = {}): PermissionItem => ({
  ...compound, id: `permission:s:${text}`, input: { kind: 'execute', command: text }, ...extra,
});

function viewOf(items: readonly Item[], overrides: Partial<InboxView> = {}): InboxView {
  return {
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', wide: true, ...overrides,
  };
}

// The table of shapes: each known kind of command, a compound, and an unknown one, in both languages.
const SHAPES: readonly (readonly [string, string, string])[] = [
  ['git log -5 --oneline; git merge-base main HEAD; git show 0cae6b1 --stat', 'Lire l\'historique et le diff du dépôt', 'Read the repository\'s history and diff'],
  ['npm test 2>&1 | tail -8', 'Lancer les tests du projet', 'Run the project\'s tests'],
  ['npm install date-fns', 'Installer date-fns', 'Install date-fns'],
  ['curl -s https://registry.example.invalid/v1/x', 'Appeler registry.example.invalid', 'Call registry.example.invalid'],
  // The live app's LOCAL-14 item (plan, 1.5): reads of several kinds, then the tests and the types.
  ['git show 0cae6b1; cat src/page.ts; grep -rn \'heading\' src | head -20; ls node_modules >/dev/null 2>&1 && (npm test 2>&1 | tail -8; npm run typecheck 2>&1 | tail -5)',
    'Lire le dépôt puis lancer les tests', 'Read the repository and run the tests'],
  [REVIEW_COMMAND, 'Lire l\'historique et le diff du dépôt puis lancer les tests du projet', 'Read the repository\'s history and diff and run the project\'s tests'],
  ['git status; npm install date-fns; npm test', 'Lire l\'historique et le diff du dépôt, installer date-fns puis lancer les tests du projet', 'Read the repository\'s history and diff, install date-fns and run the project\'s tests'],
  // A command the table does not know is said by its first word, never cut short.
  ['docker compose up -d', 'Lancer docker', 'Run docker'],
];

// What the intent table cannot read whole (the audit of lane 37): a write to
// a file, a substitution, a heredoc, a shell given a script. The title does
// not summarise it, and the fold is open.
const OPAQUE = [
  'cat secrets.env > /tmp/x', 'ls `rm -rf build`', 'echo $(rm -rf ~)', 'cat <<EOF > notes.md\nhello\nEOF', 'sh -c "rm -rf build"', 'bash -lc \'npm test\'',
  'npm test >> log.txt', 'git log; eval "$CMD"', 'python3 -c "import os"', 'node -e "1"',
];

test('a request\'s title is its intent, from the command, in the person\'s language, whatever the harness wrote', () => {
  for (const [text, french, english] of SHAPES) {
    const item = command(text, { input: { kind: 'execute', command: text, description: 'Install deps, rerun tests and typecheck' } });
    assert.equal(permissionTitle(item, fr), french, text);
    assert.equal(permissionTitle(item, en), english, text);
    assert.equal(itemTitle(item, undefined, en), permissionTitle(item, en), 'the row and the detail say the same');
  }
});

test('a command the table cannot read whole is not summarised: its title says so and its fold is open', () => {
  for (const text of OPAQUE) {
    const item = command(text);
    assert.equal(permissionTitle(item, fr), 'Lancer une commande composée', text);
    assert.equal(permissionTitle(item, en), 'Run a compound command', text);
    assert.equal(foldOpen(item), true, text);
  }
  for (const text of ['npm test 2>&1 | tail -8', 'git log 2>/dev/null', REVIEW_COMMAND, 'grep -n \'a > b\' src']) assert.equal(foldOpen(command(text)), false, text);
  assert.equal(foldOpen({ ...command('npm test'), reasonCode: 'compound' }), true, 'the policy says it is compound');
  assert.equal(permissionAsk(command('echo $(id)'), viewOf([]), fr), 'Autoriser le relecteur à lancer une commande composée\u202f?');
});

test('a request that is not a command says what it does to what, and the tool when it is none of them', () => {
  const tool = (input: PermissionItem['input'], name = 'Bash') => permissionTitle({ ...compound, tool: name, input }, fr);
  assert.equal(tool({ kind: 'read', path: 'src/page.ts' }), 'Lire un fichier');
  assert.equal(tool({ kind: 'edit', path: 'src/page.ts', added: 1, removed: 0 }), 'Modifier un fichier');
  assert.equal(tool({ kind: 'delete', path: 'src/old.ts' }), 'Supprimer un fichier');
  assert.equal(tool({ kind: 'fetch', target: 'https://example.invalid/doc' }), 'Lire une page du web');
  assert.equal(tool({ kind: 'other' }, 'Calculator'), 'Utiliser Calculator');
});

test('the request is asked as a question, naming who asks: the reviewer, the author, or the session', () => {
  const view = viewOf([compound]);
  assert.equal(permissionAsk(compound, view, fr), 'Autoriser le relecteur à lire l\'historique et le diff du dépôt puis à lancer les tests du projet\u202f?');
  assert.equal(permissionAsk(compound, view, en), 'Allow the reviewer to read the repository\'s history and diff and run the project\'s tests?');
  const author = { ...command('npm install date-fns'), sessionId: 'fixture-160' };
  assert.equal(permissionAsk(author, view, fr), 'Autoriser l\'auteur à installer date-fns\u202f?');
  const unknown = { ...command('docker compose up -d'), sessionId: 'nobody' };
  assert.equal(permissionAsk(unknown, view, fr), 'Autoriser la session à lancer docker\u202f?');
  assert.equal(permissionAsk({ ...unknown, input: { kind: 'read', path: 'a' } }, view, fr), 'Autoriser la session à lire un fichier\u202f?');
});

test('the fold holds the command one part per line, cut for display only, a quoted separator kept', () => {
  assert.deepEqual(foldOf(command('git log; git merge-base main HEAD && npm test 2>&1 | tail -8 || echo \'a|b\'')), [
    { op: '', text: 'git log' },
    { op: ';', text: 'git merge-base main HEAD' },
    { op: '&&', text: 'npm test 2>&1' },
    { op: '|', text: 'tail -8' },
    { op: '||', text: 'echo \'a|b\'' },
  ]);
  assert.deepEqual(foldOf(command('npm install date-fns')), [{ op: '', text: 'npm install date-fns' }]);
  assert.deepEqual(foldOf({ ...compound, input: { kind: 'edit', path: 'src/page.ts', added: 1, removed: 0 } }), [{ op: '', text: 'src/page.ts' }]);
  assert.deepEqual(foldOf({ ...compound, input: { kind: 'other' } }), []);
});

test('the reason is said by its code, the command it names included; with no code, or an unknown one, the service\'s sentence goes to the fold', () => {
  assert.deepEqual(reasonOf(compound, fr), { said: '«\u00a0git merge-base\u00a0» n\'est pas une commande que la politique autorise seule.' });
  assert.deepEqual(reasonOf(compound, en), { said: '“git merge-base” is not a command the policy allows on its own.' });
  const sentences: Record<Exclude<ReasonCode, 'not_allowed' | 'unknown'>, string> = {
    compound: 'La commande utilise une syntaxe du shell que la politique ne lit pas mot à mot.',
    network: 'La commande appelle le réseau.',
    dependency: 'La commande ajoute une dépendance au projet.',
    outside_checkout: 'La commande touche un chemin hors du dépôt de la session.',
  };
  for (const [code, said] of Object.entries(sentences)) assert.deepEqual(reasonOf({ ...compound, reasonCode: code as ReasonCode }, fr), { said }, code);
  const policy = 'Shell syntax the policy does not read word for word';
  const plain = { ...compound, suggestion: { decision: 'ask' as const, rule: 'shell.compound', reason: policy } };
  assert.deepEqual(reasonOf({ ...plain, reasonCode: undefined }, fr), { raw: policy });
  assert.deepEqual(reasonOf({ ...plain, reasonCode: 'unknown' }, fr), { raw: policy });
  // A code the app does not know yet (a later policy) reads as no code.
  assert.deepEqual(reasonOf({ ...plain, reasonCode: 'sandbox' as ReasonCode }, fr), { raw: policy });
  // not_allowed names the part the reason names, else the command's first word.
  assert.deepEqual(reasonOf({ ...command('ls; make build'), suggestion: { decision: 'ask', rule: 'default', reason: 'Not on the list.' }, reasonCode: 'not_allowed' }, fr),
    { said: '«\u00a0ls\u00a0» n\'est pas une commande que la politique autorise seule.' });
  assert.deepEqual(reasonOf({ ...command('ls; make build'), suggestion: { decision: 'ask', rule: 'default', reason: 'make build is not allowed' }, reasonCode: 'not_allowed' }, fr),
    { said: '«\u00a0make build\u00a0» n\'est pas une commande que la politique autorise seule.' });
  // Not a shell command: no name to quote.
  assert.deepEqual(reasonOf({ ...compound, input: { kind: 'read', path: '/etc/hosts' }, reasonCode: 'not_allowed' }, fr), { said: 'La politique n\'autorise pas cette action seule.' });
  // With no code, the policy's own rules the app knows give one (the policy lane will send it).
  const rule = (name: string, reason = 'Network access and a new dependency.') => ({ ...compound, reasonCode: undefined, suggestion: { decision: 'ask' as const, rule: name, reason } });
  assert.deepEqual(reasonOf(rule('install.package'), fr), { said: 'La commande ajoute une dépendance au projet.' });
  assert.deepEqual(reasonOf(rule('network'), fr), { said: 'La commande appelle le réseau.' });
  assert.deepEqual(reasonOf(rule('default'), fr), { raw: 'Network access and a new dependency.' });
  assert.deepEqual(reasonOf({ ...compound, suggestion: { decision: 'allow', rule: 'run.safe' } }, fr), {});
});

test('what waits comes first; what was handled and what expired make one group under it, latest first, with its count', () => {
  const items = [fixture.items[3] as Item, expired, compound, ...fixture.items.slice(0, 3)];
  const { waiting, handled } = ordered(items);
  assert.ok(waiting.every((item) => item.state === 'waiting'));
  assert.ok(waiting.some((item) => item.id === compound.id));
  assert.deepEqual(handled.map((item) => item.id), [(fixture.items[3] as Item).id, expired.id], 'the service\'s order, latest first');
  assert.equal(fr('handled_group', { n: handled.length }), 'Traité · 2');
  assert.equal(fr('allow_always'), 'Toujours pour ce projet');
  assert.equal(en('handled_group', { n: handled.length }), 'Handled · 2');
});

test('the row carries the three answers from 1280 px, for a request that waits and nothing else', () => {
  assert.equal(ROW_ANSWERS_MIN, 1280);
  const answers = ['allow_once', 'allow_always', 'reject_once'];
  const shown = fixture.items[0] as Item;
  assert.deepEqual(rowAnswers(compound, viewOf([shown, compound])), answers);
  assert.deepEqual(rowAnswers(compound, viewOf([compound])), [], 'the request shown has its answers in the detail beside it, once');
  assert.deepEqual(rowAnswers(compound, viewOf([shown, compound], { wide: false })), [], 'under 1280 px the detail holds them');
  assert.deepEqual(rowAnswers(expired, viewOf([expired])), []);
  assert.deepEqual(rowAnswers(fixture.items[0] as Item, viewOf(fixture.items)), [], 'a release is answered in its detail');
  assert.deepEqual(rowAnswers(compound, viewOf([shown, compound], { local: new Map([[compound.id, { kind: 'busy' }]]) })), [], 'once answered, the row says so instead');
  assert.equal(fr('allow_always'), 'Toujours pour ce projet', 'the owner\'s words');
});

test('A, T and R answer the request shown, Space peeks at the row walked to; each is in the inbox\'s sheet and nowhere else', () => {
  const shown = { item: compound as Item, visible: true, busy: false };
  const key = (k: string, extra: Partial<Parameters<typeof inboxKey>[0]> = {}) => inboxKey({ key: k, meta: false, ctrl: false, alt: false, focus: 'none', onRow: false, overlay: false, beside: true, ...extra }, shown);
  assert.deepEqual(key('a'), { kind: 'answer', act: 'allow_once' });
  assert.deepEqual(key('T'), { kind: 'answer', act: 'allow_always' });
  assert.deepEqual(key('r'), { kind: 'answer', act: 'reject_once' });
  assert.deepEqual(key(' ', { onRow: true, focus: 'control' }), { kind: 'peek' });
  assert.equal(key(' '), null, 'Space off a row scrolls, as the browser does');
  assert.deepEqual(key('a', { focus: 'control', onRow: true, rowShown: true }), { kind: 'answer', act: 'allow_once' }, 'from the row of the request shown too');
  assert.equal(key('a', { focus: 'control', onRow: true, rowShown: false }), null, 'from another row, A would answer a request the person is not reading');
  assert.equal(key(' ', { onRow: true, focus: 'control', beside: false }), null, 'under 1024 px a peek would hide the row: Space is the browser\'s');
  for (const blocked of [{ focus: 'field' as const }, { focus: 'terminal' as const }, { overlay: true }, { ctrl: true }, { meta: true }, { alt: true }]) assert.equal(key('a', blocked), null, JSON.stringify(blocked));
  const plain = { key: 'a', meta: false, ctrl: false, alt: false, focus: 'none' as const, onRow: false, overlay: false, beside: true };
  assert.equal(inboxKey(plain, { ...shown, item: expired }), null, 'a handled item has no answer');
  assert.equal(inboxKey(plain, { ...shown, visible: false }), null, 'on a phone, the list alone answers nothing');
  assert.equal(inboxKey(plain, { ...shown, busy: true }), null, 'once is enough');
  assert.equal(inboxKey(plain, { ...shown, item: fixture.items[0] as Item }), null);

  // The sheet lists exactly the keys the inbox binds, on the inbox only.
  const own = SCREEN_KEYS.inbox ?? [];
  assert.deepEqual(own.map((s) => s.keys.join(' ')), ['A', 'T', 'R', 'Space']);
  for (const shortcut of own) {
    const token = shortcut.keys[0] as string;
    const typed = token === 'Space' ? ' ' : token.toLowerCase();
    assert.deepEqual(key(typed, { onRow: token === 'Space', rowShown: token !== 'Space', focus: token === 'Space' ? 'control' : 'none' }), shortcut.action, shortcut.id);
    assert.ok(sheetRows('inbox').includes(shortcut));
    assert.ok(!sheetRows('tower').includes(shortcut));
    for (const language of ['en', 'fr'] as const) assert.ok(loadCatalog('shell', language)[shortcut.label], `${shortcut.label} in shell.${language}`);
  }
  for (const typed of [...'abcdefghijklmnopqrstuvwxyz', ' ']) {
    const action = key(typed, { onRow: true, rowShown: true, focus: 'control' });
    if (action) assert.ok(own.some((s) => JSON.stringify(s.action) === JSON.stringify(action)), `${typed} does something the sheet does not list`);
  }
  assert.equal(keyLabel('Space', false, fr), 'Espace');
  assert.equal(keyLabel('Space', false, en), 'Space');
});

test('a key that ends a G chord is the chord\'s: G then T goes to the tower, it never answers', () => {
  const shown = { item: compound as Item, visible: true, busy: false };
  const input = { key: 't', meta: false, ctrl: false, alt: false, focus: 'none' as const, onRow: false, overlay: false, beside: true };
  assert.equal(inboxKey({ ...input, afterG: true }, shown), null);
  assert.deepEqual(inboxKey({ ...input, afterG: false }, shown), { kind: 'answer', act: 'allow_always' });
  assert.equal(inboxKey({ ...input, key: 'a', afterG: true }, shown), null, 'any key after a G is left to the shell');
});

test('Esc closes the item shown, but never from a field: the text typed there stays (lane 34\'s audit, P1)', () => {
  assert.equal(closesOnEscape('none'), true);
  assert.equal(closesOnEscape('control'), true);
  assert.equal(closesOnEscape('field'), false);
  assert.equal(closesOnEscape('terminal'), false);
});

test('the handled item keeps its intent title, and the expired one is in the fixture\'s group', () => {
  assert.equal(permissionTitle(expired, fr), 'Lancer le script db:migrate');
  assert.equal(expired.state, 'handled');
  assert.equal(compound.reasonCode, 'not_allowed');
});
