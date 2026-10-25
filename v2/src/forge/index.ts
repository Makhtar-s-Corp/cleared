// The forge of a service: the adapter its workspace file names (`forge`,
// GitHub by default), running in a checkout with the forge's environment.
import { FORGE_KINDS, ForgeError, type Forge, type ForgeKind } from './contract.ts';
import { GitHubForge } from './github.ts';

export type { Forge, ForgeKind } from './contract.ts';

export function forgeKindOf(service: { readonly forge?: ForgeKind } | undefined): ForgeKind {
  return service?.forge ?? 'github';
}

export function forgeFor(kind: ForgeKind, at: { readonly dir: string; readonly env: NodeJS.ProcessEnv }): Forge {
  if (kind === 'github') return new GitHubForge(at);
  throw new ForgeError(`no adapter for the forge "${String(kind).slice(0, 40)}": Cleared has ${FORGE_KINDS.join(', ')}`);
}
