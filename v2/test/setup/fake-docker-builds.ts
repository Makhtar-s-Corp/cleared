// A fake `docker` program on PATH that builds, for the environment step's
// browser test: `build` records the tag and its labels in a file (after a
// pause, so that the page sees the build run), and the labelled image
// lists, inspections and removals read that file. The declared check's
// container (flow/env-setup.ts checkImage) is kept in another: `create`,
// `start`, `exec` (which prints `checkOutput` and exits with `checkCode`),
// the labelled `ps`, `stop` and `rm`. Any other command, or a list without
// the label filter, is refused. No test that uses it reaches Docker.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = (imagesFile: string, pauseMs: number, check: { readonly code: number; readonly output: string }) => `#!${process.execPath}
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const verb = ['image', 'network', 'volume'].includes(args[0]) ? args[0] + ' ' + args[1] : args[0];
const filters = args.flatMap((arg, i) => (args[i - 1] === '--filter' ? [arg] : []));
const read = () => JSON.parse(readFileSync(${JSON.stringify(imagesFile)}, 'utf8'));
const containersFile = ${JSON.stringify(imagesFile)}.replace(/images\\.json$/, 'containers.json');
const containers = () => { try { return JSON.parse(readFileSync(containersFile, 'utf8')); } catch { return []; } };
const labelled = (labels) => filters.every((filter) => { const [key, value] = filter.slice('label='.length).split('='); return labels[key] === value; });
const idOf = (tag) => 'sha256:' + createHash('sha256').update(tag).digest('hex');
const refuse = (text, code = 125) => { process.stderr.write(text + '\\n'); process.exit(code); };
const matches = (image) => filters.every((filter) => {
  if (filter.startsWith('reference=')) return image.tag === filter.slice('reference='.length);
  const [key, value] = filter.slice('label='.length).split('=');
  return image.labels[key] === value;
});
if (['image ls', 'ps', 'network ls'].includes(verb) && !filters.includes('label=cleared.dev=v2')) refuse('fake docker: a list without the label filter');
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
  case 'create': {
    const name = args[args.indexOf('--name') + 1];
    const labels = Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === '--label' ? [arg.split('=')] : [])));
    const id = createHash('sha256').update(name).digest('hex');
    writeFileSync(containersFile, JSON.stringify([...containers(), { id, name, labels }]));
    process.stdout.write(id + '\\n');
    break;
  }
  case 'ps':
    for (const row of containers().filter((c) => labelled(c.labels))) process.stdout.write(JSON.stringify({ ID: row.id, Names: row.name, State: 'running', Labels: Object.entries(row.labels).map(([k, v]) => k + '=' + v).join(',') }) + '\\n');
    break;
  case 'network ls': break;
  case 'start': case 'stop': break;
  case 'exec': process.stdout.write(${JSON.stringify(check.output)}); process.exitCode = ${check.code}; break;
  case 'rm': {
    const ids = args.slice(args.indexOf('--') + 1);
    writeFileSync(containersFile, JSON.stringify(containers().filter((c) => !ids.includes(c.id))));
    break;
  }
  default: refuse('fake docker: not a command of the environment step: ' + args.join(' '));
}
`;

export type FakeDockerBuilds = { restore(): void };

export function fakeDockerBuildsOnPath(pauseMs = 1_500, check: { readonly code: number; readonly output: string } = { code: 0, output: '# pass 4\n' }): FakeDockerBuilds {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-fake-docker-builds-'));
  const imagesFile = join(dir, 'images.json');
  writeFileSync(imagesFile, '[]');
  writeFileSync(join(dir, 'docker'), SCRIPT(imagesFile, pauseMs, check));
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
