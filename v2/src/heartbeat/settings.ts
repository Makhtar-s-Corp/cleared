// The heartbeat's settings (docs/v2/milestone-4-plan.md, section 8.4), read
// from the environment as the rest of the service's:
//   CLEARED_V2_HEARTBEAT_SECONDS          a beat every 60 s (15 to 3600)
//   CLEARED_V2_HEARTBEAT_SESSION_MINUTES  a live session unmoved past 120 min is stalled
//   CLEARED_V2_HEARTBEAT_TRACKER_MINUTES  a mirror without a full pass past 10 min is stale
//   CLEARED_V2_HEARTBEAT_PING_URL_FILE    the monitor's success address, in a file
//   CLEARED_V2_HEARTBEAT_FAIL_URL_FILE    its failure address, in a file
// The two addresses are credentials, as v1's (docs/heartbeat.md): each is
// read from a file the service's account alone can read, outside the
// project's checkout, never from a variable, and never written anywhere.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';

export class HeartbeatConfigError extends Error {
  override name = 'HeartbeatConfigError';
}

export type HeartbeatSettings = {
  readonly everyMs: number;
  readonly sessionMinutes: number;
  readonly trackerMinutes: number;
  readonly trackers: readonly ('github' | 'linear')[];   // the mirrors the settings turn on (tickets/mirror.ts)
};

export type MonitorAddresses = {
  readonly ping: string | null;
  readonly fail: string | null;
  readonly refused: readonly string[];                    // the variables whose file or address was refused
};

export type MonitorState = 'on' | 'off' | 'invalid';

export const PING_FILE = 'CLEARED_V2_HEARTBEAT_PING_URL_FILE';
export const FAIL_FILE = 'CLEARED_V2_HEARTBEAT_FAIL_URL_FILE';

function whole(env: NodeJS.ProcessEnv, variable: string, fallback: number, min: number, max: number): number {
  const raw = env[variable]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new HeartbeatConfigError(`${variable} must be a whole number from ${min} to ${max}, got "${raw}"`);
  return Number(raw);
}

export function readHeartbeatSettings(env: NodeJS.ProcessEnv = process.env): HeartbeatSettings {
  const trackers: ('github' | 'linear')[] = [];
  if (env.CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE?.trim()) trackers.push('github');
  if (env.CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE?.trim()) trackers.push('linear');
  return {
    everyMs: whole(env, 'CLEARED_V2_HEARTBEAT_SECONDS', 60, 15, 3600) * 1000,
    sessionMinutes: whole(env, 'CLEARED_V2_HEARTBEAT_SESSION_MINUTES', 120, 1, 10_080),
    trackerMinutes: whole(env, 'CLEARED_V2_HEARTBEAT_TRACKER_MINUTES', 10, 1, 10_080),
    trackers,
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// The address a file holds, or undefined when the file or the address is
// unsafe. Nothing of the file is said: a refusal names the variable only.
function addressIn(path: string, options: { readonly checkout?: string; readonly uid?: number }): string | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== (options.uid ?? process.getuid?.()) || (info.mode & 0o077) !== 0) return undefined;
    if (options.checkout) {
      const target = realpathSync(path);
      const checkout = realpathSync(options.checkout);
      if (target === checkout || target.startsWith(`${checkout}${sep}`)) return undefined;
    }
    const url = new URL(readFileSync(path, 'utf8').trim());
    if (url.username || url.password) return undefined;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

// The monitor's two addresses. A variable unset is an address not set; a
// file refused leaves its address unset and names its variable, so that the
// beat goes on with the other one and says the refusal (monitor_invalid).
export function readMonitor(env: NodeJS.ProcessEnv = process.env, options: { readonly checkout?: string; readonly uid?: number } = {}): MonitorAddresses {
  const refused: string[] = [];
  const read = (variable: string): string | null => {
    const path = env[variable]?.trim();
    if (!path) return null;
    const address = addressIn(path, options);
    if (address === undefined) refused.push(variable);
    return address ?? null;
  };
  const ping = read(PING_FILE);
  const fail = read(FAIL_FILE);
  return { ping, fail, refused };
}

// Off without a success address: the monitor would hear nothing either way.
export function monitorState(monitor: MonitorAddresses): MonitorState {
  if (monitor.refused.length > 0) return 'invalid';
  return monitor.ping ? 'on' : 'off';
}
