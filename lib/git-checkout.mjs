// The git environment for one checkout Cleared works on (the project's main
// checkout, or the tool's own). Git refuses a repository owned by another
// user ("detected dubious ownership"): with the three-account layout the
// project checkout belongs to the service account and the human's commands
// read it. So each git command declares that one checkout safe, through the
// command-scope environment: nothing is written to any git configuration
// file, and no other path is declared. Never call this with a path taken
// from untrusted data.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// `env` plus safe.directory for `checkout` only. Entries the caller already
// exported in GIT_CONFIG_COUNT / KEY_n / VALUE_n are kept; ours are appended.
export function checkoutGitEnv(checkout, env = process.env) {
  if (typeof checkout !== 'string' || !checkout) throw new Error('checkoutGitEnv needs the checkout path');
  let path = resolve(checkout);
  try { path = realpathSync(path); } catch { /* not there: the path as given */ }
  const count = Math.max(0, Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0);
  return {
    ...env,
    [`GIT_CONFIG_KEY_${count}`]: 'safe.directory',
    [`GIT_CONFIG_VALUE_${count}`]: path,
    GIT_CONFIG_COUNT: String(count + 1),
  };
}

// The first line of what git (or the spawn) said, for a message to a human.
export function gitFirstLine(error) {
  const text = String(error?.stderr || error?.message || '');
  return text.split('\n').map((line) => line.trim()).find(Boolean) || 'no message';
}

// The sentence that replaces a failed read of a checkout.
export const gitRefusal = (checkout, error) => `git refused or could not read ${checkout}: ${gitFirstLine(error)}`;
