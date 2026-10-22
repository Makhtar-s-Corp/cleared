// The session image copies the runner's files one by one
// (images/session/Dockerfile), and nothing else of the service. So every
// file main.ts loads must be copied, and a runner file may import from the
// rest of the service only with `import type`, which type stripping erases:
// a value import would fail in the image, where that path does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const folder = new URL('../../images/session/runner/', import.meta.url);
const dockerfile = readFileSync(new URL('../../images/session/Dockerfile', import.meta.url), 'utf8');
const files = readdirSync(folder).filter((name) => name.endsWith('.ts'));

const imports = (name: string) => [...readFileSync(new URL(name, folder), 'utf8').matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)';/gm)].map((match) => ({ typeOnly: Boolean(match[1]), from: match[2] as string }));

test('every runner file is copied into the image', () => {
  for (const name of files) assert.match(dockerfile, new RegExp(`^COPY runner/${name.replace('.', '\\.')} \\./${name.replace('.', '\\.')}$`, 'm'), name);
});

test('a runner file imports Node built-ins, the runner\'s own files, and the rest of the service by type only', () => {
  for (const name of files) {
    for (const { typeOnly, from } of imports(name)) {
      if (from.startsWith('node:')) continue;
      if (/^\.\/[a-z-]+\.ts$/.test(from)) {
        assert.ok(files.includes(from.slice(2)), `${name} imports ${from}`);
        continue;
      }
      assert.ok(typeOnly, `${name} imports ${from} as a value`);
    }
  }
  // The SDK and zod are loaded at run time, from the image's node_modules.
  assert.match(dockerfile, /@anthropic-ai\/claude-agent-sdk@0\.3\.306 zod@4\.6\.7/);
});

// The fake image (milestone 2, decision 20) copies fake.ts and yaml.ts one
// by one, and runs with no dependency: each file imports Node built-ins and
// the other one only.
test('the fake image copies every file it loads, and the fake imports nothing outside them', () => {
  const fakeFolder = new URL('../../images/fake/', import.meta.url);
  const fakeDockerfile = readFileSync(new URL('Dockerfile', fakeFolder), 'utf8');
  const fakeFiles = readdirSync(fakeFolder).filter((name) => name.endsWith('.ts'));
  assert.deepEqual(fakeFiles.sort(), ['fake.ts', 'yaml.ts']);
  for (const name of fakeFiles) {
    assert.match(fakeDockerfile, new RegExp(`^COPY ${name.replace('.', '\\.')} \\./${name.replace('.', '\\.')}$`, 'm'), name);
    const text = readFileSync(new URL(name, fakeFolder), 'utf8');
    for (const [, from] of text.matchAll(/^import\s+(?:type\s+)?[^'"]*from\s+'([^']+)';/gm))
      assert.ok(from?.startsWith('node:') || fakeFiles.includes((from ?? '').slice(2)), `${name} imports ${from}`);
  }
  assert.doesNotMatch(fakeDockerfile, /^RUN /m, 'nothing is installed: the fake has no dependency');
  assert.match(fakeDockerfile, /^CMD \["node", "fake\.ts"\]$/m);
});
