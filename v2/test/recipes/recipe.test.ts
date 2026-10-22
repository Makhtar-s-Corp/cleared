// A recipe's file (docs/v2/milestone-2-plan.md, decision 29): its front
// matter, its body with {{parameter}} marks, and the substitution of the
// values a person or a schedule gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RecipeError, parseRecipe, publicRecipe, substitute } from '../../src/recipes/recipe.ts';

const SERVICES = ['guestbook', 'filter-api'];
const at = (name: string) => ({ file: `.cleared/recipes/${name}.md`, service: 'guestbook', services: SERVICES });

const BUMP = `---
name: bump-dependency
kind: ticket
title: Bump {{package}} to {{version}}
lane: fast
size: xs
services: [guestbook]
parameters:
  - name: package
    description: The package to bump
  - name: version
    description: "The version, as npm writes it"
---
Bump {{package}} to {{ version }} in package.json and the lock file.

- [ ] npm test passes
- [ ] {{package}} is at {{version}} in the lock file
`;

test('a ticket recipe is read with its parameters, its lane, its size and its services', () => {
  const recipe = parseRecipe(BUMP, at('bump-dependency'));
  assert.deepEqual(publicRecipe(recipe), {
    name: 'bump-dependency', service: 'guestbook', kind: 'ticket',
    parameters: [{ name: 'package', description: 'The package to bump', required: true }, { name: 'version', description: 'The version, as npm writes it', required: true }],
    lane: 'fast', size: 'xs', services: ['guestbook'],
    body: 'Bump {{package}} to {{ version }} in package.json and the lock file.\n\n- [ ] npm test passes\n- [ ] {{package}} is at {{version}} in the lock file\n',
  });
  assert.equal(recipe.title, 'Bump {{package}} to {{version}}');
});

test('the values replace every mark, in the body and the title, once', () => {
  const recipe = parseRecipe(BUMP, at('bump-dependency'));
  const run = substitute(recipe, { package: 'pg', version: '8.13.1' });
  assert.equal(run.title, 'Bump pg to 8.13.1');
  assert.equal(run.body, 'Bump pg to 8.13.1 in package.json and the lock file.\n\n- [ ] npm test passes\n- [ ] pg is at 8.13.1 in the lock file\n');
  // A value that looks like a mark is refused, so nothing is substituted twice.
  assert.throws(() => substitute(recipe, { package: '{{version}}', version: '1' }), (error: unknown) => error instanceof RecipeError && /package/.test(error.message));
});

test('a missing parameter, an unknown one and a value on several lines are refused', () => {
  const recipe = parseRecipe(BUMP, at('bump-dependency'));
  assert.throws(() => substitute(recipe, { package: 'pg' }), (error: unknown) => error instanceof RecipeError && error.kind === 'invalid' && /version/.test(error.message));
  assert.throws(() => substitute(recipe, { package: 'pg', version: '1', extra: 'x' }), /extra/);
  assert.throws(() => substitute(recipe, { package: 'pg\nrm -rf', version: '1' }), /one line/);
  assert.throws(() => substitute(recipe, { package: 'x'.repeat(501), version: '1' }), /500/);
});

test('an optional parameter left out is empty', () => {
  const recipe = parseRecipe(BUMP.replace('    description: "The version, as npm writes it"', '    required: false'), at('bump-dependency'));
  assert.equal(recipe.parameters[1]?.required, false);
  assert.equal(substitute(recipe, { package: 'pg' }).title, 'Bump pg to');
});

test('a recipe whose name holds {{ is refused, as is a name that is not its file\'s', () => {
  assert.throws(() => parseRecipe(BUMP.replace('name: bump-dependency', 'name: bump-{{package}}'), at('bump-dependency')),
    (error: unknown) => error instanceof RecipeError && /\{\{/.test(error.message));
  assert.throws(() => parseRecipe(BUMP, at('bump')), /bump\.md/);
  assert.throws(() => parseRecipe(BUMP.replace('name: bump-dependency', 'name: Bump Dependency'), at('Bump Dependency')), /name/);
});

test('a mark no parameter declares, an unknown key, a service outside the workspace and a body with no criterion are refused', () => {
  assert.throws(() => parseRecipe(BUMP.replace('in package.json', 'in {{file}}'), at('bump-dependency')), /\{\{file\}\}/);
  assert.throws(() => parseRecipe(BUMP.replace('lane: fast', 'lane: fast\nowner: me'), at('bump-dependency')), /owner/);
  assert.throws(() => parseRecipe(BUMP.replace('services: [guestbook]', 'services: [guestbook, billing]'), at('bump-dependency')), /billing/);
  assert.throws(() => parseRecipe(BUMP.replace(/- \[ \]/g, '-'), at('bump-dependency')), /- \[ \]/);
  assert.throws(() => parseRecipe('no front matter\n', at('bump-dependency')), /front matter/);
  assert.throws(() => parseRecipe(BUMP.replace('kind: ticket', 'kind: chore'), at('bump-dependency')), /ticket or goal/);
  assert.throws(() => parseRecipe(BUMP.replace('size: xs', 'size: xl'), at('bump-dependency')), /size/);
});

test('a ticket recipe defaults to the full lane, the size s and its own service', () => {
  const recipe = parseRecipe(`---
name: tidy
kind: ticket
---
Tidy the README.

- [ ] the README reads well
`, at('tidy'));
  assert.equal(recipe.lane, 'full');
  assert.equal(recipe.size, 's');
  assert.deepEqual(recipe.services, ['guestbook']);
  assert.deepEqual(recipe.parameters, []);
  assert.equal(recipe.title, null);
  assert.equal(substitute(recipe, {}).title, 'tidy');
});

test('a goal recipe is the goal\'s text; it takes no lane or size, the lead chooses them', () => {
  const goal = `---
name: weekly-deps
kind: goal
services:
  - guestbook
  - filter-api
parameters: [scope]
---
Bring the {{scope}} dependencies of both services up to date.
`;
  const recipe = parseRecipe(goal, at('weekly-deps'));
  assert.equal(recipe.kind, 'goal');
  assert.equal(recipe.lane, undefined);
  assert.deepEqual(recipe.services, ['guestbook', 'filter-api']);
  assert.deepEqual(recipe.parameters, [{ name: 'scope', required: true }]);
  assert.equal(substitute(recipe, { scope: 'dev' }).body, 'Bring the dev dependencies of both services up to date.\n');
  assert.throws(() => parseRecipe(goal.replace('kind: goal', 'kind: goal\nlane: fast'), at('weekly-deps')), /lead chooses/);
});
