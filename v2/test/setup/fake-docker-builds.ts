// A fake `docker` program on PATH that builds, for the environment step's
// browser test: `build` records the tag and its labels in a file (after a
// pause, so that the page sees the build run), and the labelled image
// lists, inspections and removals read that file. Any other command, or a
// list without the label filter, is refused. No test that uses it reaches
// Docker.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = (imagesFile: string, pauseMs: number) => `#!${process.execPath}
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const verb = ['image', 'network', 'volume'].includes(args[0]) ? args[0] + ' ' + args[1] : args[0];
const filters = args.flatMap((arg, i) => (args[i - 1] === '--filter' ? [arg] : []));
const read = () => JSON.parse(readFileSync(${JSON.stringify(imagesFile)}, 'utf8'));
const idOf = (tag) => 'sha256:' + createHash('sha256').update(tag).digest('hex');
const refuse = (text, code = 125) => { process.stderr.write(text + '\\n'); process.exit(code); };
const matches = (image) => filters.every((filter) => {
  if (filter.startsWith('reference=')) return image.tag === filter.slice('reference='.length);
  const [key, value] = filter.slice('label='.length).split('=');
  return image.labels[key] === value;
});
if (verb === 'image ls' && !filters.includes('label=cleared.dev=v2')) refuse('fake docker: a list without the label filter');
switch (verb) {
  case 'version': process.stdout.write(JSON.stringify({ Client: { Version: '29.8.1' }, Server: { Version: '29.8.1' } }) + '\\n'); break;
  case 'build': {
    const tag = args[args.indexOf('--tag') + 1];
    const labels = Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === '--label' ? [arg.split('=')] : [])));
    setTimeout(() => {
      const images = read().filter((image) => image.tag !== tag);
      images.push({ tag, labels, created: new Date().toISOString() });
      writeFileSync(${JSON.stringify(imagesFile)}, JSON.stringify(images));
    }, ${pauseMs});
    break;
  }
  case 'image ls':
    for (const image of read().filter(matches)) process.stdout.write(JSON.stringify({ ID: idOf(image.tag) }) + '\\n');
    break;
  case 'image inspect': {
    const ids = args.slice(args.indexOf('--') + 1);
    process.stdout.write(JSON.stringify(read().filter((image) => ids.includes(idOf(image.tag))).map((image) => ({ Id: idOf(image.tag), RepoTags: [image.tag], Created: image.created, Config: { Labels: image.labels } }))));
    break;
  }
  case 'image rm': {
    const ids = args.slice(args.indexOf('--') + 1);
    writeFileSync(${JSON.stringify(imagesFile)}, JSON.stringify(read().filter((image) => !ids.includes(idOf(image.tag)))));
    break;
  }
  default: refuse('fake docker: not a command of the environment step: ' + args.join(' '));
}
`;

export type FakeDockerBuilds = { restore(): void };

export function fakeDockerBuildsOnPath(pauseMs = 1_500): FakeDockerBuilds {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-fake-docker-builds-'));
  const imagesFile = join(dir, 'images.json');
  writeFileSync(imagesFile, '[]');
  writeFileSync(join(dir, 'docker'), SCRIPT(imagesFile, pauseMs));
  chmodSync(join(dir, 'docker'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before ?? ''}`;
  return {
    restore() {
      process.env.PATH = before;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
