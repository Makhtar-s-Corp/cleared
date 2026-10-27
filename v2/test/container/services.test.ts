import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ServiceError, dependencyChange, parseServices, planSiblings, testVariables, ticketLayerDockerfile, variableRefusal, type SiblingSource } from '../../src/container/services.ts';

test('postgres:16 becomes a service named postgres with its data on tmpfs and a DATABASE_URL for the session', () => {
  const [postgres, ...rest] = parseServices('postgres:16');
  assert.deepEqual(rest, []);
  assert.deepEqual(postgres, {
    alias: 'postgres',
    image: 'postgres:16',
    env: { POSTGRES_HOST_AUTH_METHOD: 'trust' },
    tmpfs: ['/var/lib/postgresql/data'],
    ready: ['pg_isready', '--quiet', '--host', '127.0.0.1', '--username', 'postgres'],
    sessionEnv: { DATABASE_URL: 'postgres://postgres@postgres:5432/postgres' },
  });
});

test('an alias can be given, and several services are separated by commas', () => {
  const services = parseServices(' db=postgres:16 , postgres:16.4 ');
  assert.deepEqual(services.map((s) => [s.alias, s.image]), [['db', 'postgres:16'], ['postgres', 'postgres:16.4']]);
  assert.equal(services[0]?.sessionEnv.DATABASE_URL, 'postgres://postgres@db:5432/postgres');
  assert.deepEqual(parseServices(''), []);
  assert.deepEqual(parseServices('  '), []);
});

test('the guestbook\'s form, the image then words that restate its environment, is read as the image alone', () => {
  const [postgres, ...rest] = parseServices('postgres:16 POSTGRES_HOST_AUTH_METHOD=trust');
  assert.deepEqual(rest, []);
  assert.deepEqual(postgres, parseServices('postgres:16')[0]);
  assert.deepEqual(parseServices('db=postgres:16  POSTGRES_HOST_AUTH_METHOD=trust, postgres:16').map((s) => s.alias), ['db', 'postgres']);
});

test('an environment word that changes the image\'s fixed environment, or is not NAME=value, is refused', () => {
  assert.throws(() => parseServices('postgres:16 POSTGRES_HOST_AUTH_METHOD=md5'), (error: unknown) => error instanceof ServiceError && /POSTGRES_HOST_AUTH_METHOD/.test(error.message));
  assert.throws(() => parseServices('postgres:16 POSTGRES_PASSWORD=secret'), ServiceError);
  assert.throws(() => parseServices('postgres:16 trust'), ServiceError);
});

test('an image without a known table of writable paths is refused, so that no unlabelled volume is created', () => {
  assert.throws(() => parseServices('redis:7'), (error: unknown) => error instanceof ServiceError && /postgres/.test(error.message));
  assert.throws(() => parseServices('library/mysql:8'), ServiceError);
  assert.throws(() => parseServices('evil.example/postgres:16'), ServiceError, 'only the official image');
});

test('an image without an explicit tag, a bad alias, a reserved alias or a duplicate is refused', () => {
  for (const value of ['postgres', 'postgres:', 'postgres:latest', 'postgres@sha256:abc', '-x=postgres:16', 'Db=postgres:16', 'egress=postgres:16', 'session=postgres:16', 'postgres:16,postgres:16', 'a b=postgres:16', 'postgres:16 --privileged', 'x=']) {
    assert.throws(() => parseServices(value), ServiceError, value);
  }
});

// ------------------------------------------------ siblings (milestone 2, decision 20)

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-sibling-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const PACKAGE = JSON.stringify({ name: 'app', scripts: { test: 'node --test' }, dependencies: { pg: '8.13.1' }, devDependencies: { typescript: '7.0.2' } });

test('a checkout whose dependencies are the base\'s builds on the base layer; any change to them, or to the lock file, does not', () => {
  const base = folder({ 'package.json': PACKAGE, 'package-lock.json': '{"lockfileVersion":3}' });
  assert.equal(dependencyChange(base, folder({ 'package.json': PACKAGE, 'package-lock.json': '{"lockfileVersion":3}', 'src/main.ts': 'changed' })), undefined);
  const scripts = JSON.stringify({ ...JSON.parse(PACKAGE), scripts: { test: 'other' }, version: '2.0.0' });
  assert.equal(dependencyChange(base, folder({ 'package.json': scripts, 'package-lock.json': '{"lockfileVersion":3}' })), undefined, 'scripts and version are not dependencies');
  const bumped = JSON.stringify({ ...JSON.parse(PACKAGE), dependencies: { pg: '8.14.0' } });
  assert.match(dependencyChange(base, folder({ 'package.json': bumped, 'package-lock.json': '{"lockfileVersion":3}' })) ?? '', /package\.json dependencies/);
  const dev = JSON.stringify({ ...JSON.parse(PACKAGE), devDependencies: { typescript: '7.0.3' } });
  assert.match(dependencyChange(base, folder({ 'package.json': dev, 'package-lock.json': '{"lockfileVersion":3}' })) ?? '', /devDependencies/);
  assert.match(dependencyChange(base, folder({ 'package.json': PACKAGE, 'package-lock.json': '{"lockfileVersion":4}' })) ?? '', /package-lock\.json/);
  assert.match(dependencyChange(base, folder({ 'package.json': PACKAGE })) ?? '', /package-lock\.json/, 'a lock file removed is a change');
  assert.equal(dependencyChange(folder({}), folder({ 'README.md': 'x' })), undefined, 'no package.json on either side');
  assert.match(dependencyChange(base, folder({ 'package.json': '{not json', 'package-lock.json': '{"lockfileVersion":3}' })) ?? '', /package\.json/);
});

test('a package.json or lock file that is a link in the checkout is a change: the host never follows a link the session made', () => {
  const base = folder({ 'package.json': PACKAGE, 'package-lock.json': '{}' });
  const outside = folder({ 'package.json': PACKAGE });
  const checkout = folder({ 'package-lock.json': '{}' });
  symlinkSync(join(outside, 'package.json'), join(checkout, 'package.json'));
  assert.match(dependencyChange(base, checkout) ?? '', /package\.json is not a plain file/);
  const linkedFolder = folder({});
  symlinkSync(base, join(linkedFolder, 'app'));
  assert.match(dependencyChange(base, join(linkedFolder, 'app')) ?? '', /not a plain folder/);
});

test('the ticket layer\'s Dockerfile holds FROM and COPY lines only: no instruction of the branch runs', () => {
  const text = ticketLayerDockerfile('cleared-v2-base-guestbook:cafe0b1ec7ed', '/app');
  const lines = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
  assert.deepEqual(lines, ['FROM cleared-v2-base-guestbook:cafe0b1ec7ed', 'COPY . /app/']);
  assert.throws(() => ticketLayerDockerfile('cleared-v2-base-guestbook:cafe0b1ec7ed', ''), ServiceError, 'a base image with no working folder');
  assert.throws(() => ticketLayerDockerfile('x\nRUN curl evil', '/app'), ServiceError);
  assert.throws(() => ticketLayerDockerfile('cleared-v2-base-guestbook:1', '/app\nRUN x'), ServiceError);
});

const SERVICES: SiblingSource[] = [
  { name: 'guestbook', kind: 'repository', path: null, run: { dockerfile: 'Dockerfile', port: 8793 }, contract: null },
  { name: 'filter-api', kind: 'repository', path: null, run: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
  { name: 'billing', kind: 'folder', path: 'services/billing', run: { dockerfile: 'Dockerfile', port: 9000 }, contract: { format: 'openapi', path: 'openapi.json' } },
  { name: 'docs', kind: 'repository', path: null, run: null, contract: null },
];

test('the siblings of a session: each other service real when it runs, else its fake, and its own service built from its checkout', async () => {
  const exported: string[] = [];
  const siblings = await planSiblings({
    services: SERVICES, own: 'guestbook', ownCheckout: '/work/T-1/guestbook',
    checkoutOf: (name) => (name === 'billing' ? '/work/T-1/billing' : undefined),
    baseOf: async (name) => { exported.push(name); return { dir: `/state/siblings/${name}/c0ffee`, commit: 'c0ffeecafe0bdeadbeefcafe' }; },
    contractPort: () => undefined,
  });
  assert.deepEqual(siblings, [
    { name: 'guestbook', port: 8793, real: { base: '/state/siblings/guestbook/c0ffee', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-guestbook:c0ffeecafe0b', checkout: '/work/T-1/guestbook' } },
    { name: 'filter-api', port: 8080, contract: '/state/siblings/filter-api/c0ffee/contract/openapi.yaml' },
    {
      name: 'billing', port: 9000, contract: '/state/siblings/billing/c0ffee/services/billing/openapi.json',
      real: { base: '/state/siblings/billing/c0ffee/services/billing', dockerfile: 'Dockerfile', tag: 'cleared-v2-base-billing:c0ffeecafe0b', checkout: '/work/T-1/billing/services/billing' },
    },
  ]);
  assert.deepEqual(exported, ['guestbook', 'filter-api', 'billing'], 'a service with neither run nor contract is not exported');
});

test('a fake listens on its run port, else on its contract\'s server port, else on 8080; a service whose base cannot be read is left out', async () => {
  const siblings = await planSiblings({
    services: SERVICES.slice(0, 2), own: 'guestbook', ownCheckout: '/work/T-1',
    checkoutOf: () => undefined,
    baseOf: async (name) => (name === 'guestbook' ? undefined : { dir: `/state/${name}`, commit: 'abcdefbeefcafe00' }),
    contractPort: (file) => (file.endsWith('openapi.yaml') ? 8795 : undefined),
  });
  assert.deepEqual(siblings, [{ name: 'filter-api', port: 8795, contract: '/state/filter-api/contract/openapi.yaml' }]);
});

test('a fake of a contract in another format carries the format, and its port is asked of the contract with it (M11)', async () => {
  const asked: string[] = [];
  const siblings = await planSiblings({
    services: [
      { name: 'royalties', kind: 'repository', path: null, run: null, contract: { format: 'protobuf', path: 'api/royalties.proto' } },
      { name: 'catalogue', kind: 'repository', path: null, run: null, contract: { format: 'jsonschema', path: 'schema/isrc.json' } },
      { name: 'filter-api', kind: 'repository', path: null, run: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
    ],
    own: 'guestbook', ownCheckout: '/work/T-1', checkoutOf: () => undefined,
    baseOf: async (name) => ({ dir: `/state/${name}`, commit: 'abcdefbeefcafe00' }),
    contractPort: (file, format) => { asked.push(`${format}:${file}`); return undefined; },
  });
  assert.deepEqual(siblings, [
    { name: 'royalties', port: 8080, contract: '/state/royalties/api/royalties.proto', contractFormat: 'protobuf' },
    { name: 'catalogue', port: 8080, contract: '/state/catalogue/schema/isrc.json', contractFormat: 'jsonschema' },
    { name: 'filter-api', port: 8080, contract: '/state/filter-api/contract/openapi.yaml' },
  ], 'OpenAPI, the default, carries no format');
  assert.deepEqual(asked, ['protobuf:/state/royalties/api/royalties.proto', 'jsonschema:/state/catalogue/schema/isrc.json', 'openapi:/state/filter-api/contract/openapi.yaml']);
});

// ------------------------------------------------------- the test secrets (C16)

test('a test secret is named as an environment variable, never one Cleared, a harness or a test service sets', () => {
  for (const name of ['PAYMENT_SANDBOX_KEY', 'MAIL_TEST_PASSWORD', 'S3_TEST_BUCKET', 'A']) assert.equal(variableRefusal(name), undefined, name);
  for (const name of ['', 'lower', '9LIVES', 'WITH-DASH', 'WITH SPACE', `A${'B'.repeat(64)}`]) assert.equal(variableRefusal(name), 'name', name);
  const reserved = [
    'HOME', 'PATH', 'USER', 'SHELL', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GIT_DIR', 'GIT_SSH_COMMAND', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY',
    'CLEARED_V2_STATE_DIR', 'CODEX_HOME', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'EGRESS_PORT', 'FAKE_PORT',
    // What a known test service gives the session: postgres's DATABASE_URL.
    ...Object.keys(parseServices('postgres:16')[0]?.sessionEnv ?? {}),
  ];
  for (const name of reserved) assert.equal(variableRefusal(name), 'reserved', name);
});

test('the variables given: the test secrets that pass, under what the container already sets', () => {
  const value = (n: number) => ['sandbox', 'fake', 'value', String(n)].join('-');
  assert.deepEqual(testVariables({ PAYMENT_SANDBOX_KEY: value(1), HOME: value(2), lower: value(3), DATABASE_URL: value(4) }, { HOME: '/tmp', DATABASE_URL: 'postgres://postgres@postgres:5432/postgres' }), { PAYMENT_SANDBOX_KEY: value(1) });
  assert.deepEqual(testVariables({ MAIL_TEST_PASSWORD: value(5) }, { MAIL_TEST_PASSWORD: 'the container\'s own' }), {}, 'a name the container sets is the container\'s');
  assert.deepEqual(testVariables({}, { HOME: '/tmp' }), {});
});
