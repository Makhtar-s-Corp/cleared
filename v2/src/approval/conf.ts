// The few settings of the project's agents.conf that the approval needs,
// read the way lib/conf.ts reads the file: sections in brackets, `key =
// value` lines, the first value of a repeated key. The file is the one the
// lock reads: CLEARED_CONF (or ORCH_CONF), else <project>/.cleared/agents.conf.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_STATES, type TicketStates } from '../tickets/contract.ts';

export type LockConf = {
  readonly states: TicketStates;
  readonly ownerId: string | undefined;          // [tracker] owner_id: the app user whose name the signed rows carry
  readonly publicKey: string | undefined;        // [tracker] human_public_key
  readonly privateKeyFile: string | undefined;   // [tracker] human_private_key, v1's name for the service's key file
  readonly verdict: string | undefined;          // [merge] verdict
  readonly socketPath: string | undefined;       // [security] socket_path
};

export function parseSections(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current: Record<string, string> | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { current = sections[header[1] as string] ??= {}; continue; }
    const eq = line.indexOf('=');
    if (!current || eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!Object.hasOwn(current, key)) current[key] = line.slice(eq + 1).trim();
  }
  return sections;
}

export function confFile(env: NodeJS.ProcessEnv): string | undefined {
  const named = env.CLEARED_CONF || env.ORCH_CONF;
  if (named) return named;
  const project = env.CLEARED_REPO || env.ORCH_REPO;
  return project ? join(project, '.cleared', 'agents.conf') : undefined;
}

const value = (text: string | undefined) => (text ? text : undefined);

export function readLockConf(env: NodeJS.ProcessEnv = process.env): LockConf {
  const file = confFile(env);
  let sections: Record<string, Record<string, string>> = {};
  if (file) {
    try { sections = parseSections(readFileSync(file, 'utf8')); } catch { /* no settings file: the defaults */ }
  }
  const tracker = sections.tracker ?? {};
  const state = (key: string, fallback: string) => tracker[`${key}_state`] || fallback;
  return {
    states: {
      todo: state('todo', DEFAULT_STATES.todo), progress: state('progress', DEFAULT_STATES.progress), review: state('review', DEFAULT_STATES.review),
      validate: state('validate', DEFAULT_STATES.validate), go: state('go', DEFAULT_STATES.go), done: state('done', DEFAULT_STATES.done),
    },
    ownerId: value(tracker.owner_id),
    publicKey: value(tracker.human_public_key),
    privateKeyFile: value(tracker.human_private_key),
    verdict: value(sections.merge?.verdict),
    socketPath: value(sections.security?.socket_path),
  };
}
