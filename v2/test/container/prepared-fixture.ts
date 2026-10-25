// A service's project for the prepared images' tests: a repository on a
// "forge" (a bare repository) and the service's checkout of it, as the flow
// fetches it, so its base is refs/remotes/origin/main; and a merge on the
// forge, which the checkout sees once it fetches. No network.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { PreparedSource } from '../../src/container/prepared.ts';
import { commit, gitIn, remote, tempDir } from '../workspace/git.ts';

export const PACKAGE = `${JSON.stringify({ name: 'api', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { pg: '8.13.1' } }, null, 2)}\n`;
export const LOCK = (version: string) => `${JSON.stringify({ name: 'api', lockfileVersion: 3, packages: { 'node_modules/pg': { version } } })}\n`;
export const CONF = (install = 'npm ci') => `[merge]\nverdict = no blocking issues\n\n[session]\ninstall_command = ${install}\n`;

export function project(files: Record<string, string> = {}, path: string | null = null, service = 'api') {
  const bare = remote({ 'package.json': PACKAGE, 'package-lock.json': LOCK('8.13.1'), '.cleared/agents.conf': CONF(), 'src/index.ts': 'export {};\n', ...files });
  const dir = join(tempDir('prepared'), 'checkout');
  execFileSync('git', ['clone', '-q', bare, dir]);
  const source: PreparedSource = { service, dir, base: 'main', path };
  return { bare, dir, source };
}

export function land(bare: string, files: Record<string, string>): void {
  const work = join(tempDir('land'), 'work');
  execFileSync('git', ['clone', '-q', bare, work]);
  commit(work, files, 'a merged change');
  gitIn(work, ['push', '-q', 'origin', 'main']);
}

export const fetched = (source: Pick<PreparedSource, 'dir'>): void => { gitIn(source.dir, ['fetch', '-q', 'origin']); };
