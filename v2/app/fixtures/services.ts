// The service map of the fixtures (milestone 4, M6): the example workspace
// (examples/workspace.conf), its two repositories read from examples/ by the
// service's own code (map/source.ts readFolder, map/build.ts buildMap), so
// the screen shows what the service would. Built at `now`, with invented
// base commits: the examples are folders here, not clones.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ServiceMap } from '../../src/api/types.ts';
import { buildMap } from '../../src/map/build.ts';
import { readFolder } from '../../src/map/source.ts';
import { parseWorkspace } from '../../src/workspace/config.ts';

const EXAMPLES = fileURLToPath(new URL('../../../examples/', import.meta.url));
const COMMITS: Readonly<Record<string, string>> = { guestbook: '3f9c2a14d8e0b7c6a5f4e3d2c1b0a9f8e7d6c5b4', 'filter-api': '8a1b2c3d4e5f60718293a4b5c6d7e8f901234567' };

export function serviceMapFixture(now: Date): ServiceMap {
  const file = `${EXAMPLES}workspace.conf`;
  const workspace = parseWorkspace(readFileSync(file, 'utf8'), { file, authorModel: 'claude-opus-5-5', stateDir: '/nonexistent' });
  const reads = workspace.services.map((service) => ({ ...readFolder(`${EXAMPLES}${service.name}`, service), commit: COMMITS[service.name] ?? null }));
  return buildMap({ workspace: workspace.id, services: workspace.services, reads, at: now.toISOString() });
}
