// A plan's step is written for a person (issue #501): no command name, no file
// name, no path. The check is one function, read by the tool that refuses such a
// plan and by the screens that fold what still comes through. A false alarm costs
// a refused plan, so the sentences a person writes are cases here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTechnical, technicalSteps } from '../../src/flow/plan-words.ts';

const TECHNICAL = [
  'Lancer npm test',
  'Lancer `npm test` et corriger ce qui échoue',
  'Run pnpm install',
  'Exécuter `make`',
  'Lancer make test',
  'Vérifier avec git status',
  'Lancer go test sur le module',
  'Lancer cargo test',
  'Lancer python3 -m unittest',
  'Installer avec sudo apt-get install jq',
  'Tout supprimer avec rm -rf',
  'Relancer les tests avec --watch',
  'Compiler && relancer',
  'Lancer CI=true la suite',
  'Modifier web/Message.tsx',
  'Ajouter une entrée dans package.json',
  'Mettre à jour le Dockerfile',
  'Renseigner .env',
  'Modifier ./lib/date',
  'Lire ../autre/depot',
  'Lire /etc/hosts',
  'Lire ~/.config/outil',
  'Changer src/flow',
  'Ranger a/b/c',
  'Consulter https://example.org/doc',
];

const HUMAN = [
  'Lancer les tests du projet',
  'Run the project\'s tests',
  'Ajouter la date au composant du message',
  'Formater la date selon la langue de la page',
  'Lire le composant `Message`',
  'Vérifier le format JJ/MM/AAAA',
  'Accepter dd/mm/yyyy et 31/10/2026',
  'Traduire fr/en et/ou corriger',
  'Prévoir la version web/mobile',
  'Comparer client/serveur, avant/après',
  'Passer en TCP/IP',
  'Monter en version 1.2.3, puis v2.0',
  'Mettre à jour Node.js',
  'Mettre à jour le SDK .NET',
  'Compter 10 €/jour',
  'Make sure the page still works',
  'Go to the next page',
  'Lire l\'historique du dépôt git',
  'Ajouter des mots-clés, etc.',
  '- Lire le composant',
  'Écrire à M. Dupont',
  'Écrire le test de l\'affichage',
  'Sort the entries newest first',
  'Write or update its test, run the tests, commit',
];

for (const step of TECHNICAL) test(`technical: ${step}`, () => assert.equal(isTechnical(step), true));
for (const step of HUMAN) test(`for a person: ${step}`, () => assert.equal(isTechnical(step), false));

test('the technical steps of a plan are given by their number, from one', () => {
  assert.deepEqual(technicalSteps(['Lire le composant', 'Lancer npm test', 'Corriger', 'Modifier a/b/c']), [2, 4]);
  assert.deepEqual(technicalSteps(['Lire le composant']), []);
});

test('the language rule leaves the plan\'s steps out of what stays technical', async () => {
  const { authorPrompt } = await import('../../src/flow/prompts.ts');
  const prompt = authorPrompt({ id: 'T-1', title: 'Titre', body: 'Corps' }, { plan: true, report: true }, 'fr');
  assert.match(prompt, /in French everything a person reads/);
  assert.match(prompt, /session plan's steps, which name none of them/);
  assert.match(prompt, /report_plan_step/);
  const without = authorPrompt({ id: 'T-1', title: 'Titre', body: 'Corps' }, { plan: false, report: true }, 'fr');
  assert.doesNotMatch(without, /report_plan_step/, 'an author with no plan of its own is not asked');
});
