// The versions of the agent profile and of its environment (issue #452), in
// ledger.db beside the sessions that name them (store/db.ts creates them).
// A version is a row the ledger never changes nor removes: triggers refuse
// both. An edit is the current version with the fields given, written as
// the next version; a rollback writes an old version's fields as the next
// one, which names it. The first version of each is the service as it ran
// before profiles: a ledger from before them gets it at its next start, and
// each of its authors' and reviewers' sessions reads as run on it.
//
// No secret: every text of a write is read against the guard's patterns
// (session/clean.ts) and a few of the forges' token shapes; one that matches
// is refused with the field's name, never its value. The harness's login
// stays mounted from the service (B5.4e), and MCP servers, which would carry
// a connection, are refused whatever they hold.
import type { DatabaseSync } from 'node:sqlite';
import { GUARD_PATTERNS } from '../session/clean.ts';
import type { Role, SessionId, UserId } from '../session/contract.ts';
import {
  DEFAULT_ENVIRONMENT, DEFAULT_PROFILE, NETWORKS, PROFILE_HARNESSES,
  type AgentEnvironment, type AgentProfile, type ProfileRefusal, type SessionVersions,
} from './types.ts';

const versionTable = (table: string, what: string) => `
CREATE TABLE IF NOT EXISTS ${table} (
  version INTEGER PRIMARY KEY, body TEXT NOT NULL, created_at TEXT, created_by TEXT NOT NULL, restored_from INTEGER
);
CREATE TRIGGER IF NOT EXISTS ${table}_kept_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'a ${what} version is never changed'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_kept_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'a ${what} version is never changed'); END;
`;

// The store's own schema (store/db.ts runs it at every open): no migration,
// since nothing that exists changes.
export const PROFILE_SCHEMA = `${versionTable('agent_profile_versions', 'profile')}${versionTable('environment_versions', 'environment')}
CREATE TABLE IF NOT EXISTS session_profiles (
  session_id TEXT PRIMARY KEY, profile INTEGER NOT NULL, environment INTEGER NOT NULL, auto INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS session_profiles_kept_update BEFORE UPDATE ON session_profiles BEGIN SELECT RAISE(ABORT, 'a session''s versions are never changed'); END;
`;

// The service's first version of each: read as there while its table is
// empty, written before the second, with no date (it is the service as it
// always ran). A ledger is never written to only because it was opened,
// so a ledger with no row stays one (store/migrations.ts copies none).
export const SEED_AUTHOR = 'cleared';

export class ProfileError extends Error {
  override name = 'ProfileError';
  readonly code: ProfileRefusal;
  constructor(code: ProfileRefusal, message: string) {
    super(message);
    this.code = code;
  }
}

// ---- no secret -------------------------------------------------------------

// The forges' and the clouds' token shapes the guard's list leaves to the
// private-term check, a bearer token, and credentials before a host with no scheme.
const TOKEN_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['cloud key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer token', /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  // The guard's assigned secret reads a line's start; a prompt holds one mid-sentence.
  ['assigned secret', /\b[A-Z0-9_]*(?:PASS(?:WORD)?|SECRET|TOKEN|API_?KEY)[A-Z0-9_]*=[^\s"'$(#]{8,}/],
  ['credentials before a host',/(?:^|[\s/])[^\s:/@'"`]+:[^\s@/'"`]{6,}@[A-Za-z0-9.-]+/],
];

// Every text of a value, each key with its value as a line would write it,
// so an assignment is read as one.
function texts(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((item, index) => texts(item, `${path}[${index}]`, out));
  else if (typeof value === 'object' && value !== null)
    for (const [key, item] of Object.entries(value)) {
      out.push({ path: `${path}.${key}`, text: key });
      if (typeof item === 'string' || typeof item === 'number') out.push({ path: `${path}.${key}`, text: `${key}=${item}` }, { path: `${path}.${key}`, text: `${key}: "${item}"` });
      texts(item, `${path}.${key}`, out);
    }
}

function refuseSecrets(change: unknown, object: string): void {
  const found: { path: string; text: string }[] = [];
  texts(change, object, found);
  for (const { path, text } of found)
    for (const [category, pattern] of [...GUARD_PATTERNS, ...TOKEN_PATTERNS])
      if (pattern.test(text)) throw new ProfileError('sensitive', `${path} holds what looks like a secret (${category}): a profile holds no secret, the service mounts the connections`);
}

// ---- reading a change ------------------------------------------------------

const CLAUDE_MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+){1,6}$/;
const PROMPT_MAX = 4000;
const TOOL_MAX = 200;
const LIST_MAX = 50;
// Cleared's images only: labelled, built by the service from its own files.
const IMAGE = /^cleared-v2-[a-z0-9][a-z0-9-]{0,62}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A host name, or a wildcard on its first label, as the egress allow list reads one.
const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CPUS = /^(?:\d{1,2})(?:\.\d{1,2})?$/;
const MEMORY = /^(\d{1,5})([mg])$/;

function known<T extends object>(change: unknown, base: T): Partial<Record<keyof T, unknown>> {
  if (typeof change !== 'object' || change === null || Array.isArray(change)) throw new ProfileError('body', 'a change is an object of the fields it sets');
  for (const key of Object.keys(change)) if (!(key in base)) throw new ProfileError('body', `"${key}" is not a field of this object`);
  return change as Partial<Record<keyof T, unknown>>;
}

function list(value: unknown, code: ProfileRefusal, what: string, each: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > LIST_MAX || !value.every((item) => typeof item === 'string' && each(item)))
    throw new ProfileError(code, what);
  return [...new Set(value as string[])];
}

const model = (value: unknown, which: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !CLAUDE_MODEL.test(value)) throw new ProfileError('model', `the ${which} model is a Claude model id, such as claude-opus-5-5, or null for the service's`);
  return value;
};

// A command run without asking names its command first: a wildcard there
// would allow any. The policy matches the safe commands after its deny rules
// but before its asks (session/policy.ts simple), so a command an ask guards
// is refused here: a deletion past the ticket's files, a host the project
// does not declare, a package installed, a shell or a push. Those stay
// questions, or a project's own [session] safe_commands, which its review reads.
const ASKED = /^(?:rm|curl|wget|ssh|scp|nc|npx|sudo|su|env|eval|exec|xargs|sh|bash|zsh|dash|apt|apt-get|apk|brew|docker)(?:\s|$)|^git\s+(?:push|clean|reset|checkout|restore|config|remote)\b|^(?:npm|pnpm|yarn)\s+(?:i|add|install|exec|dlx)\b|^pip3?\s+install\b/;
const tool = (item: string): boolean => item.length > 0 && item.length <= TOOL_MAX && !/[\n\r]/.test(item) && /^[A-Za-z0-9_./-]+(?:\s|$)/.test(item) && !ASKED.test(item.trim());

export function readProfile(change: unknown, base: AgentProfile): AgentProfile {
  refuseSecrets(change, 'profile');
  const given = known(change, base);
  const harness = given.harness ?? base.harness;
  if (!(PROFILE_HARNESSES as readonly unknown[]).includes(harness))
    throw new ProfileError('harness', `the harness is ${PROFILE_HARNESSES.join(' or ')}: Codex and Cursor are reached through auto, behind CLEARED_V2_PICK_HARNESSES (P87)`);
  const authorModel = 'authorModel' in given ? model(given.authorModel, 'author') : base.authorModel;
  const reviewerModel = 'reviewerModel' in given ? model(given.reviewerModel, 'reviewer') : base.reviewerModel;
  if (authorModel !== null && authorModel === reviewerModel) throw new ProfileError('same_models', 'the reviewer is another model than the author');
  let rolePrompts = base.rolePrompts;
  if ('rolePrompts' in given) {
    const prompts = given.rolePrompts as Record<string, unknown> | null;
    const ok = typeof prompts === 'object' && prompts !== null && !Array.isArray(prompts) && Object.keys(prompts).sort().join() === 'author,reviewer'
      && [prompts.author, prompts.reviewer].every((p) => typeof p === 'string' && p.length <= PROMPT_MAX);
    if (!ok) throw new ProfileError('prompt', `the role prompts are { author, reviewer }, each a text of at most ${PROMPT_MAX} characters`);
    rolePrompts = { author: (prompts.author as string).trim(), reviewer: (prompts.reviewer as string).trim() };
  }
  const allowedTools = 'allowedTools' in given ? list(given.allowedTools, 'tools', 'the allowed commands are a list of commands, each naming its command first', tool) : base.allowedTools;
  if ('mcpServers' in given && !(Array.isArray(given.mcpServers) && given.mcpServers.length === 0))
    throw new ProfileError('mcp', 'a session has no MCP server beyond Cleared\'s own yet: the list stays empty');
  if ('skills' in given && given.skills !== 'project') throw new ProfileError('skills', 'a session has the project\'s skills, mounted as they are (B5.5b)');
  return { harness: harness as AgentProfile['harness'], authorModel, reviewerModel, rolePrompts, allowedTools, mcpServers: [], skills: 'project' };
}

function cpusOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !CPUS.test(value) || Number(value) < 0.5 || Number(value) > 16) throw new ProfileError('cpus', 'the CPUs are a number from 0.5 to 16, or null for Cleared\'s');
  return value;
}

function memoryOf(value: unknown): string | null {
  if (value === null) return null;
  const match = typeof value === 'string' ? MEMORY.exec(value) : null;
  const mb = match ? Number(match[1]) * (match[2] === 'g' ? 1024 : 1) : 0;
  if (!match || mb < 256 || mb > 64 * 1024) throw new ProfileError('memory', 'the memory is 256m to 64g, or null for Cleared\'s');
  return value as string;
}

export function readEnvironment(change: unknown, base: AgentEnvironment): AgentEnvironment {
  refuseSecrets(change, 'environment');
  const given = known(change, base);
  const image = 'image' in given ? given.image : base.image;
  if (image !== null && (typeof image !== 'string' || !IMAGE.test(image))) throw new ProfileError('image', 'the image is one Cleared builds, cleared-v2-<name>:<tag>, or null for the service\'s');
  const network = given.network ?? base.network;
  if (!(NETWORKS as readonly unknown[]).includes(network)) throw new ProfileError('network', `the network is ${NETWORKS.join(' or ')}`);
  const allowedHosts = 'allowedHosts' in given ? list(given.allowedHosts, 'hosts', 'the allowed hosts are host names, *.example.com at most', (host) => HOST.test(host)) : base.allowedHosts;
  if (network === 'model-only' && allowedHosts.length > 0) throw new ProfileError('hosts', 'a model-only network adds no host');
  const cpus = 'cpus' in given ? cpusOf(given.cpus) : base.cpus;
  const memory = 'memory' in given ? memoryOf(given.memory) : base.memory;
  return { image: image as string | null, network: network as AgentEnvironment['network'], allowedHosts, cpus, memory };
}

// ---- the versions ----------------------------------------------------------

export type Versioned<T> = {
  readonly version: number;
  readonly body: T;
  readonly createdAt: string | null;             // null for the service's first version
  readonly createdBy: UserId;                    // SEED_AUTHOR for the service's first version
  readonly restoredFrom: number | null;
};

export type VersionStore<T> = {
  current(): Versioned<T>;
  get(version: number): Versioned<T> | undefined;
  list(): Versioned<T>[];                        // oldest first
  save(change: unknown, by: UserId): Versioned<T>;
  restore(version: number, by: UserId): Versioned<T>;
};

type Row = { version: number; body: string; created_at: string | null; created_by: string; restored_from: number | null };

// Two bodies are the same when their JSON is: readProfile and readEnvironment
// write the fields in one order, as the defaults do.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function versions<T>(db: DatabaseSync, table: string, first: T, read: (change: unknown, base: T) => T, now: () => Date): VersionStore<T> {
  const seed: Row = { version: 1, body: JSON.stringify(first), created_at: null, created_by: SEED_AUTHOR, restored_from: null };
  const rows = () => {
    const all = db.prepare(`SELECT * FROM ${table} ORDER BY version`).all() as Row[];
    return all.length > 0 ? all : [seed];
  };
  const one = (row: Row): Versioned<T> => ({
    version: Number(row.version), body: JSON.parse(row.body) as T, createdAt: row.created_at, createdBy: row.created_by,
    restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
  });
  const get = (version: number) => {
    const row = rows().find((r) => Number(r.version) === version);
    return row ? one(row) : undefined;
  };
  const current = () => one(rows().at(-1) as Row);
  // The next version, in one statement, so two writers never take the same number.
  const write = (body: T, by: UserId, restoredFrom: number | null): Versioned<T> => {
    if (same(body, current().body)) throw new ProfileError('unchanged', 'this is the current version already');
    db.prepare(`INSERT OR IGNORE INTO ${table} (version, body, created_at, created_by, restored_from) VALUES (1, ?, NULL, ?, NULL)`).run(seed.body, SEED_AUTHOR);
    const row = db.prepare(`INSERT INTO ${table} (version, body, created_at, created_by, restored_from)
      SELECT COALESCE(MAX(version), 0) + 1, ?, ?, ?, ? FROM ${table} RETURNING *`).get(JSON.stringify(body), now().toISOString(), by, restoredFrom) as Row;
    return one(row);
  };
  return {
    current,
    get,
    list: () => rows().map(one),
    save: (change, by) => write(read(change, current().body), by, null),
    restore: (version, by) => {
      const old = Number.isInteger(version) ? get(version) : undefined;
      if (!old) throw new ProfileError('version', 'no such version');
      return write(old.body, by, old.version);
    },
  };
}

export type ProfileVersions = { readonly profile: VersionStore<AgentProfile>; readonly environment: VersionStore<AgentEnvironment> };

export function profileVersions(db: DatabaseSync, now: () => Date = () => new Date()): ProfileVersions {
  return {
    profile: versions(db, 'agent_profile_versions', DEFAULT_PROFILE, readProfile, now),
    environment: versions(db, 'environment_versions', DEFAULT_ENVIRONMENT, readEnvironment, now),
  };
}

// ---- a session's versions --------------------------------------------------

// Written once, when the session starts.
export function recordSessionVersions(db: DatabaseSync, session: SessionId, versions: SessionVersions): void {
  db.prepare('INSERT OR IGNORE INTO session_profiles (session_id, profile, environment, auto) VALUES (?, ?, ?, ?)')
    .run(session, versions.profile, versions.environment, versions.auto ? 1 : 0);
}

// An author's or a reviewer's versions; one from before profiles ran on
// the first version of each, which is the service as it ran then. The lead
// and a reader have none.
export function sessionVersions(db: DatabaseSync, session: SessionId, role: Role): SessionVersions | undefined {
  if (role !== 'author' && role !== 'reviewer') return undefined;
  const row = db.prepare('SELECT profile, environment, auto FROM session_profiles WHERE session_id = ?').get(session) as { profile: number; environment: number; auto: number } | undefined;
  return row ? { profile: Number(row.profile), environment: Number(row.environment), auto: Number(row.auto) === 1 } : { profile: 1, environment: 1, auto: false };
}
