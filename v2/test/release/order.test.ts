// The landing order and the compatibility check of a release train
// (docs/v2/milestone-2-plan.md, decision 21): providers before consumers
// from the services' `consumes` lines, then their position; a ticket that
// changes a service's contract without changing every service that
// consumes it is blocked, with the proposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibility, landingOrder, type TrainService } from '../../src/release/order.ts';

const api = (name: string, consumes: string[] = [], contract: string | null = null, path: string | null = null): TrainService =>
  ({ name, consumes, contract: contract ? { format: 'openapi', path: contract } : null, kind: path ? 'folder' : 'repository', path });

const EXAMPLE = [api('guestbook', ['filter-api']), api('filter-api', [], 'contract/openapi.yaml')];

test('providers land before their consumers, whatever the order the workspace file names them in', () => {
  assert.deepEqual(landingOrder(EXAMPLE, ['guestbook', 'filter-api']), ['filter-api', 'guestbook']);
  assert.deepEqual(landingOrder(EXAMPLE, ['filter-api', 'guestbook']), ['filter-api', 'guestbook']);
});

test('services with no order between them keep the workspace\'s position; an untouched service is not in the train', () => {
  const services = [api('web', ['users', 'billing']), api('billing', ['users']), api('users'), api('docs')];
  assert.deepEqual(landingOrder(services, ['web', 'docs', 'users', 'billing']), ['users', 'billing', 'web', 'docs']);
  assert.deepEqual(landingOrder(services, ['web', 'users']), ['users', 'web']);
  assert.deepEqual(landingOrder(services, ['docs']), ['docs']);
});

test('the order follows a provider through an untouched service between them', () => {
  // web consumes billing, which consumes users: users lands before web even when billing is not changed.
  const services = [api('web', ['billing']), api('billing', ['users']), api('users')];
  assert.deepEqual(landingOrder(services, ['web', 'users']), ['users', 'web']);
});

test('a name the workspace does not hold is refused', () => {
  assert.throws(() => landingOrder(EXAMPLE, ['guestbook', 'mailer']), /mailer is not a service of this workspace/);
});

test('a contract changed with its consumer changed too: the card says who consumes whom, and nothing is blocked', () => {
  const said = compatibility(EXAMPLE, { 'filter-api': ['contract/openapi.yaml', 'src/check.ts'], guestbook: ['src/page.ts'] });
  assert.equal(said.blocked, null);
  assert.deepEqual(said.contracts, ['filter-api']);
  assert.equal(said.line, 'guestbook consumes filter-api and is changed in this ticket.');
});

test('a contract changed with an untouched consumer is blocked, with the proposal to extend it or keep it compatible', () => {
  const said = compatibility(EXAMPLE, { 'filter-api': ['contract/openapi.yaml'] });
  assert.ok(said.blocked);
  assert.match(said.blocked.reason, /filter-api changes its contract \(contract\/openapi\.yaml\), and guestbook, which consumes it, is not changed in this ticket/);
  assert.match(said.blocked.proposal, /Extend the contract/);
  assert.match(said.blocked.proposal, /backward compatible/);
  assert.match(said.blocked.proposal, /ask the lead to add a step on guestbook/);
  assert.equal(said.line, 'guestbook consumes filter-api and is not changed in this ticket.');
});

test('a change of the provider that leaves its contract alone blocks nothing, even with its consumer untouched', () => {
  const said = compatibility(EXAMPLE, { 'filter-api': ['src/check.ts', 'words.txt'] });
  assert.deepEqual(said, { line: 'guestbook consumes filter-api and is not changed in this ticket.', blocked: null, contracts: [] });
});

test('a ticket with no consumer and no provider among its services has no compatibility line', () => {
  const services = [api('guestbook'), api('docs')];
  assert.deepEqual(compatibility(services, { guestbook: ['src/page.ts'] }), { line: null, blocked: null, contracts: [] });
});

test('the contract of a folder of a monorepo is read inside its folder', () => {
  const services = [api('web', ['api']), api('api', [], 'openapi.yaml', 'services/api')];
  assert.ok(compatibility(services, { api: ['services/api/openapi.yaml'] }).blocked);
  assert.equal(compatibility(services, { api: ['openapi.yaml'] }).blocked, null, 'a file of that name at the root is another file');
});

test('every untouched consumer is named, and each changed contract', () => {
  const services = [api('web', ['users']), api('admin', ['users']), api('users', [], 'openapi.yaml')];
  const said = compatibility(services, { users: ['openapi.yaml'] });
  assert.match(said.blocked?.reason ?? '', /web and admin, which consume it/);
});
