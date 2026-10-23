// The intent of a shell command, as a sentence (docs/v2/ui-overhaul-plan.md,
// 2.5.1 and U9, lane 36): the table of shapes below is the function's
// table, in both languages. The session screen says its checks and its
// commands with it; the inbox's permission titles (lane 37) will too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { INTENT_KINDS, commandParts, intentSentence, intentsOf, looksLikeCommand } from '../../web/lib/intent.ts';

// The intent's words are the shell's, which every screen's catalog holds.
const en = translator(loadCatalog('shell', 'en'));
const fr = translator(loadCatalog('shell', 'fr'));

// [command, English, French]
const SHAPES: readonly (readonly [string, string, string])[] = [
  // the repository read with git
  ['git log --oneline -5', 'Read the repository\'s history and diff', 'Lire l\'historique et le diff du dépôt'],
  ['git show 0cae6b1', 'Read the repository\'s history and diff', 'Lire l\'historique et le diff du dépôt'],
  ['git log; git merge-base main HEAD; git diff main...HEAD -- src/page.ts', 'Read the repository\'s history and diff', 'Lire l\'historique et le diff du dépôt'],
  ['git status --short', 'Read the repository\'s history and diff', 'Lire l\'historique et le diff du dépôt'],
  // files read, searched, listed
  ['cat src/page.ts', 'Read files', 'Lire des fichiers'],
  ['sed -n 1,80p src/page.ts', 'Read files', 'Lire des fichiers'],
  ['grep -rn "upcoming" src', 'Search the code', 'Chercher dans le code'],
  ['rg --files src | head -20', 'Search the code', 'Chercher dans le code'],
  ['ls -la node_modules', 'List files', 'Lister des fichiers'],
  ['cat src/page.ts; grep -rn week src', 'Read the repository', 'Lire le dépôt'],
  // the project's tests and checks
  ['npm test', 'Run the project\'s tests', 'Lancer les tests du projet'],
  ['npm run test:upcoming', 'Run the project\'s tests', 'Lancer les tests du projet'],
  ['npm test 2>&1 | tail -8', 'Run the project\'s tests', 'Lancer les tests du projet'],
  ['CI=1 npx vitest run test/upcoming.test.mjs', 'Run the project\'s tests', 'Lancer les tests du projet'],
  ['node --test test/', 'Run the project\'s tests', 'Lancer les tests du projet'],
  ['pytest -q', 'Run the project\'s tests', 'Lancer les tests du projet'],
  ['npm run typecheck', 'Check the types', 'Vérifier les types'],
  ['npx tsc --noEmit', 'Check the types', 'Vérifier les types'],
  ['npm run lint', 'Check the code\'s style', 'Vérifier le style du code'],
  ['npm run build', 'Build the project', 'Construire le projet'],
  ['npm test && npm run typecheck', 'Run the tests', 'Lancer les tests'],
  // a dependency
  ['npm install date-fns', 'Install date-fns', 'Installer date-fns'],
  ['npm i -D vitest@3', 'Install vitest@3', 'Installer vitest@3'],
  ['pnpm add date-fns luxon', 'Install date-fns, luxon', 'Installer date-fns, luxon'],
  ['pip install requests', 'Install requests', 'Installer requests'],
  ['npm ci', 'Install the project\'s dependencies', 'Installer les dépendances du projet'],
  ['npm install', 'Install the project\'s dependencies', 'Installer les dépendances du projet'],
  // the network
  ['curl -s https://api.example.com/v1/rates', 'Call api.example.com', 'Appeler api.example.com'],
  ['wget -q -O - http://127.0.0.1:3000/health', 'Call 127.0.0.1', 'Appeler 127.0.0.1'],
  ['curl -s $URL', 'Call the network', 'Appeler le réseau'],
  // git's writes
  ['git add -A && git commit -q -m "Envelope: previous months"', 'Commit the changes', 'Enregistrer les changements dans git'],
  ['git push origin HEAD', 'Push the branch', 'Pousser la branche'],
  // files changed by the shell, the app started, a script
  ['rm -rf dist', 'Delete files', 'Supprimer des fichiers'],
  ['mkdir -p src/engine && cp a.mjs src/engine/', 'Move or create files', 'Déplacer ou créer des fichiers'],
  ['npm run dev', 'Start the app', 'Démarrer l\'application'],
  ['npm run seed', 'Run the seed script', 'Lancer le script seed'],
  // a compound of two classes, and of three
  ['git show 0cae6b1; cat src/page.ts; grep -rn "week" src | head -20; ls node_modules >/dev/null 2>&1 && (npm test 2>&1 | tail -8; npm run typecheck 2>&1 | tail -5)',
    'Read the repository and run the tests', 'Lire le dépôt et lancer les tests'],
  ['git log --oneline -3 && npm install date-fns && npm test', 'Read the repository\'s history and diff, install date-fns and run the project\'s tests',
    'Lire l\'historique et le diff du dépôt, installer date-fns et lancer les tests du projet'],
  ['cd app && npm test', 'Run the project\'s tests', 'Lancer les tests du projet'],
  // an unknown command: its first word and an ellipsis; in a compound, run it
  ['docker ps -a', 'docker …', 'docker …'],
  ['./scripts/seed.sh --fresh', 'seed.sh …', 'seed.sh …'],
  ['docker ps && npm test', 'Run docker and run the project\'s tests', 'Lancer docker et lancer les tests du projet'],
];

test('the table of shapes: each command\'s intent, in English and in French', () => {
  for (const [command, english, french] of SHAPES) {
    assert.equal(intentSentence(command, en), english, command);
    assert.equal(intentSentence(command, fr), french, command);
  }
});

test('every intent has its words in the shell\'s catalog, in both languages', () => {
  for (const kind of INTENT_KINDS) for (const t of [en, fr]) assert.doesNotMatch(t(`intent_${kind}`, { name: 'x' }), /⟦/, kind);
  for (const key of ['intent_and', 'intent_alone', 'intent_read_any', 'intent_checks_any']) for (const t of [en, fr]) assert.doesNotMatch(t(key, { name: 'x' }), /⟦/, key);
});

test('a compound is cut into its commands for display only, quotes and redirections kept whole', () => {
  assert.deepEqual(commandParts('git show 0cae6b1; cat "a;b.ts" && npm test 2>&1 | tail -8 || echo failed'), [
    { op: '', text: 'git show 0cae6b1' },
    { op: ';', text: 'cat "a;b.ts"' },
    { op: '&&', text: 'npm test 2>&1' },
    { op: '|', text: 'tail -8' },
    { op: '||', text: 'echo failed' },
  ]);
  assert.deepEqual(commandParts('ls node_modules >/dev/null 2>&1 && (npm test; npm run typecheck)').map((p) => p.text), ['ls node_modules >/dev/null 2>&1', 'npm test', 'npm run typecheck']);
  assert.deepEqual(commandParts('npm run dev &\nsleep 2'), [{ op: '', text: 'npm run dev' }, { op: '&', text: 'sleep 2' }]);
  assert.deepEqual(commandParts('  '), []);
});

test('the intents of a compound: in order, once each, the pipes\' readers and the moves left out', () => {
  assert.deepEqual(intentsOf('cd app && npm test 2>&1 | tail -5; npm test'), [{ kind: 'tests' }]);
  assert.deepEqual(intentsOf('echo start; true'), []);
  assert.equal(intentSentence('echo start; true', en), 'echo …', 'nothing to say: the first word');
  assert.equal(intentSentence('', en), '');
});

test('a check named by a command is said by its intent; a check named in words is kept', () => {
  for (const command of ['npm test 2>&1 | tail -8', 'git add -A && git commit -q -m "x"', 'npx tsc --noEmit', 'ls', './run.sh']) assert.ok(looksLikeCommand(command), command);
  for (const words of ['Targeted tests', 'Full suite', 'Tests pass', 'Types', '']) assert.ok(!looksLikeCommand(words), words);
});
