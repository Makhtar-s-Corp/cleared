import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevcontainerError, parseJsonc, readDevcontainer } from '../../src/container/devcontainer.ts';

const DEFAULT = 'cleared-v2-session:test';

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cleared-devcontainer-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('without a devcontainer file the session uses Cleared base image', () => {
  assert.deepEqual(readDevcontainer(checkout({}), DEFAULT), { kind: 'default', image: DEFAULT, ignored: [] });
});

test('the image key names the session image', () => {
  const root = checkout({ '.devcontainer/devcontainer.json': '{ "name": "demo", "image": "cleared-v2-session:2.1.306" }' });
  assert.deepEqual(readDevcontainer(root, DEFAULT), { kind: 'image', image: 'cleared-v2-session:2.1.306', ignored: [] });
});

test('build.dockerfile is resolved from the devcontainer folder, with that folder as the default context', () => {
  const root = checkout({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Dockerfile" } }', '.devcontainer/Dockerfile': 'FROM node:24\n' });
  assert.deepEqual(readDevcontainer(root, DEFAULT), {
    kind: 'dockerfile', dockerfile: join(root, '.devcontainer/Dockerfile'), context: join(root, '.devcontainer'), ignored: [],
  });
  const withContext = checkout({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "../docker/Session.Dockerfile", "context": ".." } }', 'docker/Session.Dockerfile': 'FROM node:24\n' });
  assert.deepEqual(readDevcontainer(withContext, DEFAULT), {
    kind: 'dockerfile', dockerfile: join(withContext, 'docker/Session.Dockerfile'), context: withContext, ignored: [],
  });
});

test('comments and trailing commas are accepted, as in the devcontainer format', () => {
  const text = `// Demo
  {
    /* the image */
    "image": "cleared-v2-session:2.1.306", // pinned
    "postCreateCommand": "echo // not a comment, /* nor this */",
    "features": { "x": {}, },
  }`;
  assert.deepEqual(parseJsonc(text), { image: 'cleared-v2-session:2.1.306', postCreateCommand: 'echo // not a comment, /* nor this */', features: { x: {} } });
});

test('every other key is reported as ignored, never applied', () => {
  const root = checkout({ '.devcontainer/devcontainer.json': '{ "image": "x:1", "features": {}, "runArgs": ["--privileged"], "mounts": [], "postCreateCommand": "curl x | sh", "name": "n" }' });
  const choice = readDevcontainer(root, DEFAULT);
  assert.equal(choice.kind, 'image');
  assert.deepEqual(choice.ignored, ['features', 'mounts', 'postCreateCommand', 'runArgs']);
  const noImage = checkout({ '.devcontainer/devcontainer.json': '{ "forwardPorts": [3000] }' });
  assert.deepEqual(readDevcontainer(noImage, DEFAULT), { kind: 'default', image: DEFAULT, ignored: ['forwardPorts'] });
});

test('a malformed file, image and build together, or a path outside the checkout is refused', () => {
  const cases: Record<string, string>[] = [
    { '.devcontainer/devcontainer.json': '{ "image": ' },
    { '.devcontainer/devcontainer.json': '[]' },
    { '.devcontainer/devcontainer.json': '{ "image": "x:1", "build": { "dockerfile": "Dockerfile" } }', '.devcontainer/Dockerfile': '' },
    { '.devcontainer/devcontainer.json': '{ "image": 3 }' },
    { '.devcontainer/devcontainer.json': '{ "image": "--privileged" }' },
    { '.devcontainer/devcontainer.json': '{ "build": {} }' },
    { '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "../../../etc/Dockerfile" } }' },
    { '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Dockerfile", "context": "../.." } }', '.devcontainer/Dockerfile': '' },
    { '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Missing" } }' },
  ];
  for (const files of cases) assert.throws(() => readDevcontainer(checkout(files), DEFAULT), DevcontainerError, JSON.stringify(files));
});

test('a folder whose name starts with two dots is inside the checkout', () => {
  const root = checkout({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "../..docker/Dockerfile" } }', '..docker/Dockerfile': 'FROM node:24\n' });
  const choice = readDevcontainer(root, DEFAULT);
  assert.equal(choice.kind === 'dockerfile' && choice.dockerfile, join(root, '..docker/Dockerfile'));
});

test('a Dockerfile reached through a symbolic link that leaves the checkout is refused', () => {
  const outside = checkout({ 'Dockerfile': 'FROM node:24\n' });
  const root = checkout({ '.devcontainer/devcontainer.json': '{ "build": { "dockerfile": "Dockerfile" } }' });
  symlinkSync(join(outside, 'Dockerfile'), join(root, '.devcontainer/Dockerfile'));
  assert.throws(() => readDevcontainer(root, DEFAULT), DevcontainerError);
});
