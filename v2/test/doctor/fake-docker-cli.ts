// A fake `docker` program on PATH, for the browser tests, whose service runs
// the checks step with the machine's probes: it answers the ready section's
// reads only (version, and the lists filtered on cleared.dev=v2, with the
// images inspected), from a file of image tags the test rewrites; any other
// command, or a list without the label filter, is refused. No test that
// uses it reaches Docker.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EGRESS_IMAGE, SESSION_IMAGE } from '../../src/container/session-runtime.ts';

const SCRIPT = (imagesFile: string) => `#!${process.execPath}
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const verb = ['image', 'network', 'volume'].includes(args[0]) ? args[0] + ' ' + args[1] : args[0];
const filters = args.flatMap((arg, i) => (args[i - 1] === '--filter' ? [arg] : []));
const images = JSON.parse(readFileSync(${JSON.stringify(imagesFile)}, 'utf8'));
const idOf = (tag) => 'sha256:' + createHash('sha256').update(tag).digest('hex');
const refuse = (text, code = 125) => { process.stderr.write(text + '\\n'); process.exit(code); };
if (['ps', 'image ls', 'network ls', 'volume ls'].includes(verb) && !filters.includes('label=cleared.dev=v2')) refuse('fake docker: a list without the label filter');
switch (verb) {
  case 'version': process.stdout.write(JSON.stringify({ Client: { Version: '29.8.1' }, Server: { Version: '29.8.1' } }) + '\\n'); break;
  case 'ps': case 'network ls': case 'volume ls': break;
  case 'image ls': {
    const reference = filters.find((f) => f.startsWith('reference='))?.slice('reference='.length);
    for (const tag of images.filter((t) => !reference || t === reference)) process.stdout.write(JSON.stringify({ ID: idOf(tag) }) + '\\n');
    break;
  }
  case 'image inspect': {
    const ids = args.slice(args.indexOf('--') + 1);
    process.stdout.write(JSON.stringify(ids.map((id) => ({ Id: id, RepoTags: images.filter((t) => idOf(t) === id), Config: { Labels: { 'cleared.dev': 'v2' } } }))));
    break;
  }
  default: refuse('fake docker: not a read of the ready section: ' + args.join(' '));
}
`;

export type FakeDockerCli = { images(tags: readonly string[]): void; restore(): void };

export function fakeDockerOnPath(tags: readonly string[] = [SESSION_IMAGE, EGRESS_IMAGE]): FakeDockerCli {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-fake-docker-'));
  const imagesFile = join(dir, 'images.json');
  const images = (list: readonly string[]) => writeFileSync(imagesFile, JSON.stringify(list));
  images(tags);
  writeFileSync(join(dir, 'docker'), SCRIPT(imagesFile));
  chmodSync(join(dir, 'docker'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before ?? ''}`;
  return {
    images,
    restore() {
      process.env.PATH = before;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
