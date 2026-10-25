// The Compose file of the one command (docs/v2/milestone-5-plan.md, section
// 4, decisions 2 and 3; issue #406), read with the fake's YAML subset parser:
// every service and every image it builds carries cleared.dev=v2, nothing is
// published, every listener is on this machine's loopback, the Docker socket
// reaches the service (and the one-shot install that starts the project)
// and nothing else, and the state folder is mounted at its own path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, type Yaml } from '../../images/fake/yaml.ts';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../../src/container/session-runtime.ts';

const v2 = new URL('../../', import.meta.url).pathname;
const source = readFileSync(`${v2}compose.yaml`, 'utf8');
type Map = { [key: string]: Yaml };
const compose = parseYaml(source) as Map;
const services = compose.services as { [name: string]: Map };
const RUNNING = ['service', 'app', 'broker'];
const SOCKET = '/var/run/docker.sock:/var/run/docker.sock';
const STATE = '${CLEARED_V2_STATE_DIR:-/var/lib/cleared-v2}';

const list = (value: Yaml | undefined): string[] => (Array.isArray(value) ? value.map(String) : []);
const env = (service: string): Map => (services[service]?.environment ?? {}) as Map;

test('one project named cleared-v2, with the three running containers, the two build-only images and the install', () => {
  assert.equal(compose.name, 'cleared-v2');
  assert.deepEqual(Object.keys(services).sort(), ['app', 'broker', 'egress', 'install', 'service', 'session']);
  for (const name of RUNNING) {
    assert.deepEqual(services[name]!.profiles, undefined, `${name} starts with the project`);
    assert.equal(services[name]!.restart, 'unless-stopped', name);
    assert.equal(services[name]!.init, true, `${name} has an init that reaps the lock's children`);
    assert.deepEqual(list(services[name]!.command), [name], `${name} is a role of the image's entrypoint`);
  }
  assert.deepEqual(list(services.install!.profiles), ['install']);
  assert.deepEqual(list(services.install!.command), ['install']);
  assert.deepEqual(list(services.session!.profiles), ['images']);
  assert.deepEqual(list(services.egress!.profiles), ['images']);
});

test('every service, and every image the file builds, carries cleared.dev=v2; nothing else is made', () => {
  for (const [name, service] of Object.entries(services)) {
    assert.equal((service.labels as Map | undefined)?.['cleared.dev'], 'v2', `${name}'s container`);
    if (service.build !== undefined) assert.equal(((service.build as Map).labels as Map | undefined)?.['cleared.dev'], 'v2', `${name}'s image`);
  }
  // No network and no named volume of the project's own: Compose makes no
  // object the label could miss.
  assert.equal(compose.networks, undefined);
  assert.equal(compose.volumes, undefined);
  for (const [name, service] of Object.entries(services)) {
    assert.ok(service.network_mode === 'host' || service.network_mode === 'none', `${name} joins no network of the project`);
    for (const volume of list(service.volumes)) assert.ok(volume.split(':')[0]!.includes('/') || volume.startsWith('..') || volume.startsWith('$'), `${name}: ${volume} is a bind mount, not a named volume`);
  }
});

test('nothing is published, and each listener is on 127.0.0.1 of the host', () => {
  assert.doesNotMatch(source, /^\s*ports:/m);
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.ports, undefined, name);
    assert.equal(service.expose, undefined, name);
    assert.equal(service.privileged, undefined, name);
    assert.equal(service.cap_add, undefined, name);
  }
  for (const name of [...RUNNING, 'install']) assert.equal(services[name]!.network_mode, 'host', `${name} binds the host's loopback`);
  assert.equal(env('service').CLEARED_V2_HOST, '127.0.0.1');
  assert.equal(env('app').CLEARED_V2_APP_HOST, '127.0.0.1');
  // The three ports, the same on every container that names them, with the
  // service's and the app's defaults.
  for (const name of ['service', 'app', 'install']) assert.equal(env(name).CLEARED_V2_PORT, '${CLEARED_V2_PORT:-8791}', name);
  for (const name of ['app', 'install']) {
    assert.equal(env(name).CLEARED_V2_APP_PORT, '${CLEARED_V2_APP_PORT:-8792}', name);
    assert.equal(env(name).CLEARED_V2_PREVIEW_PORT, '${CLEARED_V2_PREVIEW_PORT:-8794}', name);
  }
});

test('the Docker socket reaches the service and the install, and no other container', () => {
  const holders = Object.entries(services).filter(([, service]) => list(service.volumes).some((volume) => volume.includes('docker.sock'))).map(([name]) => name).sort();
  assert.deepEqual(holders, ['install', 'service']);
  for (const name of holders) assert.ok(list(services[name]!.volumes).includes(SOCKET), name);
});

test('the state folder is mounted at its own path, and named the same way to the service, the app, the broker and the install', () => {
  for (const name of [...RUNNING, 'install']) {
    assert.ok(list(services[name]!.volumes).includes(`${STATE}:${STATE}`), `${name} mounts the state folder at its own path`);
    assert.equal(env(name).CLEARED_V2_STATE_DIR, STATE, name);
  }
  for (const name of RUNNING) assert.equal(env(name).CLEARED_STATE_DIR, STATE, `${name} finds ledger.db in the state folder`);
  // The install reads the clone, never writes it; no container mounts a home.
  assert.ok(list(services.install!.volumes).includes('..:/opt/cleared/clone:ro'));
  assert.doesNotMatch(source, /\$\{?HOME\b|~\//);
  assert.doesNotMatch(source, /\.claude/);
});

test('the images: Cleared\'s own built from this clone and never pulled, the session images under the tags the service runs', () => {
  const cleared = 'cleared-v2:local';
  for (const name of [...RUNNING, 'install']) assert.equal(services[name]!.image, cleared, name);
  for (const name of RUNNING) {
    assert.equal(services[name]!.pull_policy, 'never', `${name} runs the image the install built`);
    assert.equal(services[name]!.build, undefined, name);
  }
  const build = services.install!.build as Map;
  assert.equal(build.context, '..');
  assert.equal(build.dockerfile, 'v2/images/cleared/Dockerfile');
  assert.equal(services.session!.image, SESSION_IMAGE);
  assert.equal((services.session!.build as Map).context, 'images/session');
  assert.equal(services.egress!.image, EGRESS_IMAGE);
  assert.equal((services.egress!.build as Map).context, 'images/egress');
});

test('the broker runs as the service\'s account, on the state folder, with no socket of Docker', () => {
  const broker = services.broker!;
  assert.equal(broker.user, undefined, 'the entrypoint gives every role the state folder\'s owner');
  assert.deepEqual(list(broker.volumes), [`${STATE}:${STATE}`]);
  assert.equal(env('broker').CLEARED_V2_PROJECT_DIR, '${CLEARED_V2_PROJECT_DIR:-}');
});

test('the image: node:24 with git, gh, the Docker CLI and Compose at pinned versions, v2 and the kept v1 lock, the front end built', () => {
  const dockerfile = readFileSync(`${v2}images/cleared/Dockerfile`, 'utf8');
  assert.match(dockerfile, /^FROM node:24$/m);
  for (const tool of ['git', 'gh', 'docker-ce-cli', 'docker-compose-plugin', 'docker-buildx-plugin', 'python3', 'util-linux', 'iproute2']) assert.match(dockerfile, new RegExp(`\\b${tool}\\b`), tool);
  // Docker's signing key, checked by its fingerprint before apt trusts it,
  // and gh's .deb by the SHA-256 its release publishes.
  assert.match(dockerfile, /9DC858229FC7DD38854AE2D88D81803C0EBFCD88/);
  assert.match(dockerfile, /sha256sum -c/);
  assert.match(dockerfile, /^ARG GH_SHA256_AMD64=[0-9a-f]{64}$/m);
  for (const version of ['DOCKER_VERSION=29.8.1', 'COMPOSE_VERSION=5.5.1', 'BUILDX_VERSION=0.37.1', 'GH_VERSION=2.101.0']) assert.match(dockerfile, new RegExp(`^ARG ${version}$`, 'm'), version);
  assert.match(dockerfile, /npm ci\b/);
  assert.match(dockerfile, /npm run build\b/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/opt\/cleared\/v2\/images\/cleared\/entrypoint\.ts"\]/);
  assert.doesNotMatch(dockerfile, /curl[^\n]*\|\s*(ba)?sh/);
  // The build reads neither the history, the dependencies of the clone, any
  // .env, nor a state folder kept inside it.
  const ignore = readFileSync(`${v2}images/cleared/Dockerfile.dockerignore`, 'utf8').split('\n').map((line) => line.trim());
  for (const pattern of ['.git', '**/node_modules', '**/.env*', 'v2/app/dist', '**/*.db', '**/*.key', '**/*.token']) assert.ok(ignore.includes(pattern), pattern);
});
