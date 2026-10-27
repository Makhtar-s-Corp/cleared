#!/usr/bin/env node
// Which GitHub credential the forge calls go through: pull requests, pushes,
// fetches, merges, the rollback revert and the commits the dispatcher makes.
// With a GitHub App ([forge], or with [forge] use_tracker_app = yes the app
// of [tracker] adapter = github),
// an installation token of one hour, minted from the app's key, kept in the
// service's state and renewed five minutes before it ends (the rule of
// tracker/adapters/github-auth.ts, whose code mints it). Without, the
// ambient gh and git credentials, exactly as before. Configured and failing,
// a forge call stops with the reason: it never falls back to the ambient
// credential.
//
// The token never sits in an environment a script hands down: gh gets it in
// its own environment for one call (forgeGhEnv here, the gh function of
// lib/common.sh), git asks for it through a credential helper named in
// GIT_CONFIG_* (this file, `credential get`), and both read it from the
// cache, mode 0600, under the state directory the agents' account cannot
// read.
//
//   forge.ts shell             lines for lib/common.sh to eval
//   forge.ts token             the token on stdout (minted or reused)
//   forge.ts credential get    git credential helper protocol
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { GithubAppTokens } from './tracker/adapters/github-auth.ts';
import type { InstallationToken, TokenRequest } from './tracker/adapters/github-auth.ts';
import { loadConf, ORCH_HOME, projectDir, runAsCommand, section, stateDir } from './conf.ts';
import type { ConfSections, Section } from './conf.ts';
import { addEvent, openLedger } from './ledger.ts';
import { checkoutReadEnv } from './git-checkout.ts';

export type ForgeIdentity = { name: string; email: string };
export type ForgeSettings = {
  source: 'forge' | 'tracker';
  app_id: string;
  installation_id: string;
  app_private_key_file: string;
  login: string;
  identity: ForgeIdentity | null;
};
export type ForgeMode = { mode: 'error' | 'ambient' | 'app'; error?: string; login?: string; identity?: boolean };
export type ForgeTokenOptions = { state?: string; now?: () => number; request?: TokenRequest; record?: boolean };
type ForgeGit = { env: NodeJS.ProcessEnv; problem: string | null; ambient?: boolean };
type FailedCall = { message?: unknown; code?: unknown; stderr?: unknown } | null | undefined;

const APP_KEYS = ['app_id', 'installation_id', 'app_private_key_file'];
// Debug switches of gh and git that print request headers, Authorization
// included, into the output of a run: never set where the token is.
export const DEBUG_VARIABLES = ['GH_DEBUG', 'DEBUG', 'GIT_TRACE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_TRACE_REDACT'];
const HOST = 'github.com';
export const AMBIENT = 'ambient credential';

// The app the forge uses, or null for the ambient credential. Its keys come
// from [forge]; with none there, from the GitHub tracker's own app when
// [forge] use_tracker_app = yes says so (one app for both). Never without it:
// an installation of the GitHub tracker keeps its ambient forge credential
// until its owner opts in. Throws, naming the key, when what is configured
// cannot work.
export function forgeSettings(conf: ConfSections): ForgeSettings | null {
  const forge = section(conf, 'forge');
  const tracker = section(conf, 'tracker');
  if (forge.adapter && !['github', 'gitlab'].includes(forge.adapter)) throw new Error(`unknown [forge] adapter "${forge.adapter}" (known: github, gitlab)`);
  // A GitLab service's lock reads GitLab itself (lib/gitlab.ts): no GitHub
  // App, and git keeps its ambient credential.
  if (forge.adapter === 'gitlab') {
    const app = [...APP_KEYS, 'app_login', 'app_user_id', 'use_tracker_app'].filter((key) => forge[key]);
    if (app.length) throw new Error(`[forge] adapter = gitlab takes no GitHub App key (${app.join(', ')})`);
    return null;
  }
  if (forge.use_tracker_app && !['yes', 'no'].includes(forge.use_tracker_app)) throw new Error('[forge] use_tracker_app must be yes or no');
  let source: 'forge' | 'tracker' | null = null;
  if (APP_KEYS.some((key) => forge[key])) source = 'forge';
  else if (forge.use_tracker_app === 'yes') {
    if (tracker.adapter !== 'github') throw new Error('[forge] use_tracker_app = yes needs [tracker] adapter = github and its app keys');
    source = 'tracker';
  }
  if (!source) return null;
  // The loop below throws unless the three keys are set.
  const keys = (source === 'forge' ? forge : tracker) as Section & { app_id: string; installation_id: string; app_private_key_file: string };
  for (const key of APP_KEYS) if (!keys[key]) throw new Error(`[forge] is configured but [${source}] ${key} is missing`);
  if (!/^[0-9]+$/.test(keys.app_id)) throw new Error(`[${source}] app_id must be the numeric GitHub App ID`);
  if (!/^[0-9]+$/.test(keys.installation_id)) throw new Error(`[${source}] installation_id must be the numeric installation ID`);
  if (!isAbsolute(keys.app_private_key_file)) throw new Error(`[${source}] app_private_key_file must be an absolute path`);
  let project: string | null = null;
  try { project = realpathSync(projectDir()); } catch { /* no checkout to compare with */ }
  let key = keys.app_private_key_file;
  try { key = realpathSync(key); } catch { /* checked again when it is read */ }
  if (project && (key === project || key.startsWith(`${project}/`)))
    throw new Error(`[${source}] app_private_key_file must be outside the project checkout`);
  // The commit identity of the app: its bot login and the numeric user ID
  // GitHub gave that bot. [forge] says both when it names the app itself.
  let login = forge.app_login || (source === 'tracker' ? tracker.app_login : '') || '';
  if (login && !login.endsWith('[bot]')) login = `${login}[bot]`;
  const userId = forge.app_user_id || '';
  if (source === 'forge' && !login) throw new Error('[forge] app_login is missing (the bot login, <app slug>[bot])');
  if (source === 'forge' && !userId) throw new Error('[forge] app_user_id is missing (the numeric user ID of the bot)');
  if (login && !/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(login)) throw new Error('[forge] app_login must be <app slug>[bot]');
  if (userId && !/^[0-9]+$/.test(userId)) throw new Error('[forge] app_user_id must be numeric');
  return { source, app_id: keys.app_id, installation_id: keys.installation_id,
    app_private_key_file: keys.app_private_key_file, login,
    identity: login && userId ? { name: login, email: `${userId}+${login}@users.noreply.github.com` } : null };
}

// What forge calls run as, for `cleared status`: the app (its login, and
// whether its commit identity is complete), the ambient credential, or the
// configuration error that stops them.
export function forgeMode(conf: ConfSections): ForgeMode {
  let settings: ForgeSettings | null;
  try { settings = forgeSettings(conf); }
  catch (error) { return { mode: 'error', error: (error as Error).message }; }
  if (!settings) return { mode: 'ambient' };
  const { problem } = forgeGit(conf);
  if (problem) return { mode: 'error', error: problem };
  return { mode: 'app', login: settings.login || `app ${settings.app_id}`, identity: Boolean(settings.identity) };
}

const cachePath = (state: string): string => join(state, 'forge', 'installation-token.json');
function readCache(file: string, settings: ForgeSettings): InstallationToken | null {
  try {
    const info = lstatSync(file);
    // Only a file this account wrote for itself is believed.
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) return null;
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { app_id?: unknown; installation_id?: unknown; token?: unknown; expires_at: string };
    if (kept.app_id !== settings.app_id || kept.installation_id !== settings.installation_id) return null;
    return typeof kept.token === 'string' && kept.token ? { token: kept.token, expiresAt: kept.expires_at } : null;
  } catch { return null; }
}
function writeCache(file: string, settings: ForgeSettings, current: InstallationToken): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  // Written aside, then renamed: a reader never takes half a token. Two
  // processes renewing at once each keep a valid one.
  const part = `${file}.${process.pid}.part`;
  rmSync(part, { force: true });
  writeFileSync(part, JSON.stringify({ app_id: settings.app_id, installation_id: settings.installation_id,
    token: current.token, expires_at: current.expiresAt }), { mode: 0o600, flag: 'wx' });
  renameSync(part, file);
}

// The reason a token could not be had, naming the setting to look at, never
// the token, the key or the JSON web token.
function reasonOf(error: FailedCall, settings: ForgeSettings): string {
  const said = String(error?.message || error);
  if (said.includes(`[${settings.source}]`)) return said;
  if (error?.code === 'ENOENT' || error?.code === 'EACCES') return `[${settings.source}] app_private_key_file cannot be read`;
  if (/nearly expired/.test(said)) return `GitHub gave no usable installation token for [${settings.source}] installation_id`;
  const curl = String(error?.stderr || '').trim().split('\n').filter(Boolean).at(-1) || said.split('\n').at(-1)!;
  return `GitHub refused or did not answer the installation token request for [${settings.source}] app_id and installation_id (app suspended or uninstalled, wrong IDs, or network): ${curl.slice(0, 160)}`;
}

// A failure is written to the ledger once an hour per reason: forge calls
// whose errors a script discards still leave a trace.
function recordFailure(reason: string, state: string): void {
  try {
    const db = openLedger(join(state, 'ledger.db'));
    try {
      const since = new Date(Date.now() - 3_600_000).toISOString();
      if (!db.prepare('SELECT 1 FROM events WHERE kind = ? AND detail = ? AND at >= ? LIMIT 1').get('forge_token_failed', reason, since))
        addEvent(db, { kind: 'forge_token_failed', detail: reason });
    } finally { db.close(); }
  } catch { /* the ledger is not the forge: the error is still said */ }
}

export class ForgeError extends Error {}

// The installation token, reused from the cache while more than five minutes
// remain, minted otherwise. null for the ambient credential.
export function forgeToken(conf: ConfSections = loadConf(), { state = stateDir(), now, request, record = true }: ForgeTokenOptions = {}): InstallationToken | null {
  let settings: ForgeSettings | null;
  try { settings = forgeSettings(conf); }
  catch (error) { throw new ForgeError(`forge credential: ${(error as Error).message}; forge calls stop, the ambient credential is not used`); }
  if (!settings) return null;
  const file = cachePath(state);
  const tokens = new GithubAppTokens(settings, { now, request, section: settings.source });
  tokens.current = readCache(file, settings);
  const before = tokens.current?.token;
  try { tokens.get(); }
  catch (error) {
    const reason = reasonOf(error as FailedCall, settings);
    if (record) recordFailure(reason, state);
    throw new ForgeError(`forge credential: ${reason}; forge calls stop, the ambient credential is not used`);
  }
  if (tokens.current!.token !== before) writeCache(file, settings, tokens.current!);
  return { token: tokens.current!.token, expiresAt: tokens.current!.expiresAt };
}

// Single-quoted for a POSIX shell (git runs a `!` helper through sh).
const quoted = (value: unknown): string => `'${String(value).replace(/'/g, `'\\''`)}'`;
export const credentialHelper = (): string => `!${quoted(process.execPath)} --no-warnings ${quoted(join(ORCH_HOME, 'lib', 'forge.ts'))} credential`;

// The git settings that make every https://github.com/ remote ask this file
// for its credential, and only this file (the empty value drops the helpers
// of the user's own git config for that host). A remote written for SSH is
// sent through https, so a push cannot leave with a key of the account.
export function gitEntries(): [string, string][] {
  return [[`credential.https://${HOST}.helper`, ''], [`credential.https://${HOST}.helper`, credentialHelper()],
    [`url.https://${HOST}/.insteadOf`, `git@${HOST}:`], [`url.https://${HOST}/.insteadOf`, `ssh://git@${HOST}/`],
    // An Authorization header configured for github.com (the repository's own included) is dropped.
    [`http.https://${HOST}/.extraHeader`, '']];
}

// The account's and the system's git configuration, as git reads it for the
// project (includeIf applied), minus what touches GitHub's credentials: url
// rewrites to or from github.com (they could send a push to SSH, or around
// the app) and credential or extra-header settings scoped to it; an
// http.extraHeader for every host would reach github.com too. The rest
// (commit signing, excludes, proxies, other hosts' rewrites and credentials)
// is carried over as it is, in its order, before the forge's own entries:
// the files themselves are no longer read (GIT_CONFIG_GLOBAL, NOSYSTEM).
// An unscoped credential.helper is kept for other hosts; the forge's empty
// helper for github.com drops it there.
const touchesGithub = (text: string): boolean => /github\.com/i.test(text);
export function keptEntry(key: string, value: string): boolean {
  const lower = key.toLowerCase();
  if (/^(include|includeif)\./.test(lower)) return false; // what they include is listed already
  if (lower.startsWith('url.')) return !touchesGithub(key) && !touchesGithub(value);
  if (lower.startsWith('credential.')) return !touchesGithub(key);
  if (lower.startsWith('http.') && lower.endsWith('.extraheader')) return lower !== 'http.extraheader' && !touchesGithub(key);
  return true;
}
function carriedEntries(env: NodeJS.ProcessEnv, repo: string): [string, string][] {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_(DIR|WORK_TREE|CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+|PARAMETERS))$/.test(name)));
  let listed = '';
  let cwd = '/';
  try { if (statSync(repo).isDirectory()) cwd = repo; } catch { /* no checkout: no includeIf of it */ }
  try {
    // In the checkout (for includeIf gitdir: of the account's own files), with the read environment: its
    // entries are of the command scope, left out below with the repository's own.
    listed = execFileSync('git', ['config', '--list', '--show-scope', '--null', '--includes'],
      { cwd, env: cwd === repo ? checkoutReadEnv(repo, clean) : clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4_000_000 });
  } catch { /* nothing set, or no git */ }
  const parts = listed.split('\0');
  const kept: [string, string][] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!['system', 'global'].includes(parts[i]!)) continue;
    const entry = parts[i + 1]!;
    const end = entry.indexOf('\n');
    // A key written without a value means true.
    const [key, value]: [string, string] = end < 0 ? [entry, 'true'] : [entry.slice(0, end), entry.slice(end + 1)];
    if (keptEntry(key, value)) kept.push([key, value]);
  }
  return kept;
}

// Where the project's origin really leads once every rewrite is applied
// (url.<base>.insteadOf and pushInsteadOf, the repository's own included):
// null when it is https://github.com/ (or a local path, which needs no
// credential), the reason otherwise. A rewrite to SSH would push with the
// account's key around the app.
function originProblem(env: NodeJS.ProcessEnv, repo: string): string | null {
  const urls: string[] = [];
  for (const args of [['remote', 'get-url', 'origin'], ['remote', 'get-url', '--push', 'origin']]) {
    try { urls.push(execFileSync('git', ['-C', repo, ...args], { env: checkoutReadEnv(repo, env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
    catch { return null; } // no checkout or no origin: nothing leaves through it
  }
  const wrong = urls.find((url) => !url.startsWith(`https://${HOST}/`) && !/^(\/|file:\/\/)/.test(url));
  if (!wrong) return null;
  return `the origin of the project leads to ${wrong.replace(/\/\/[^/@]*@/, '//…@')}, not https://${HOST}/: a url rewrite (insteadOf or pushInsteadOf, in the repository's git configuration or elsewhere) would send forge calls around the app; remove it`;
}

// The environment of git under the app, and what stops it: a configuration
// that cannot work, or an origin that does not lead to github.com over https.
// Either way the forge's helper is installed and SSH refuses, so nothing
// falls back to an ambient credential.
function forgeGit(conf: ConfSections, env: NodeJS.ProcessEnv = process.env, repo: string = projectDir()): ForgeGit {
  let settings: Pick<ForgeSettings, 'identity'> | null;
  let problem: string | null = null;
  try { settings = forgeSettings(conf); }
  catch (error) { settings = { identity: null }; problem = (error as Error).message; }
  if (!settings) return { env: { ...env }, problem: null, ambient: true };
  const out = forgeEnvOf(settings, env, repo);
  problem ||= originProblem(out, repo);
  if (problem) out.GIT_SSH_COMMAND = `f() { echo ${quoted(`cleared forge credential: ${problem}; forge calls stop, the ambient credential is not used`)} >&2; exit 1; }; f`;
  return { env: out, problem };
}

// What a git process needs in its environment, added to `env`. Nothing for
// the ambient credential. Never the token. With a configuration that cannot
// work, the helper is still installed: it fails with the reason instead of
// letting an ambient credential through. The account's and the system's git
// configuration files are not read (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM):
// a url.<ssh>.insteadOf or pushInsteadOf there would send a push to SSH, with
// the account's key, around the app.
export function forgeEnv(conf: ConfSections = loadConf(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return forgeGit(conf, env).env;
}
function forgeEnvOf(settings: Pick<ForgeSettings, 'identity'>, env: NodeJS.ProcessEnv, repo: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of DEBUG_VARIABLES) delete out[name];
  let count = Number(env.GIT_CONFIG_COUNT) || 0;
  const present = Array.from({ length: count }, (_, i) => env[`GIT_CONFIG_VALUE_${i}`]);
  if (!present.includes(credentialHelper())) {
    for (const [key, value] of [...carriedEntries(env, repo), ...gitEntries()]) {
      out[`GIT_CONFIG_KEY_${count}`] = key;
      out[`GIT_CONFIG_VALUE_${count}`] = value;
      count += 1;
    }
    out.GIT_CONFIG_COUNT = String(count);
  }
  out.GIT_CONFIG_GLOBAL = '/dev/null';
  out.GIT_CONFIG_NOSYSTEM = '1';
  if (settings.identity) {
    out.GIT_AUTHOR_NAME = out.GIT_COMMITTER_NAME = settings.identity.name;
    out.GIT_AUTHOR_EMAIL = out.GIT_COMMITTER_EMAIL = settings.identity.email;
  }
  // Where the helper finds the cache, whatever the caller's directory.
  out.CLEARED_STATE_DIR = stateDir();
  return out;
}

// The environment of one gh call: forgeEnv plus the token. The ambient
// environment as it is when no app is configured. Throws when one is and
// no token can be had.
export function forgeGhEnv(conf: ConfSections = loadConf(), options: ForgeTokenOptions = {}): NodeJS.ProcessEnv {
  const git = forgeGit(conf);
  if (git.ambient) return { ...process.env };
  if (git.problem) throw new ForgeError(`forge credential: ${git.problem}; forge calls stop, the ambient credential is not used`);
  const minted = forgeToken(conf, options);
  return { ...git.env, GH_TOKEN: minted!.token, GITHUB_TOKEN: minted!.token };
}

function shellLines(conf: ConfSections): string[] {
  const git = forgeGit(conf, process.env);
  if (git.ambient) return ['CLEARED_FORGE_MODE=ambient'];
  const lines = [`CLEARED_FORGE_MODE=${git.problem ? 'error' : 'app'}`];
  if (git.problem) lines.push(`CLEARED_FORGE_ERROR=${quoted(`forge credential: ${git.problem}; forge calls stop, the ambient credential is not used`)}`);
  else lines.push(`CLEARED_FORGE_LOGIN=${quoted(forgeMode(conf).login)}`);
  const env = git.env;
  for (const name of DEBUG_VARIABLES) if (name in process.env && !(name in env)) lines.push(`unset ${name}`);
  for (const [name, value] of Object.entries(env)) {
    if (process.env[name] === value) continue;
    if (!/^(GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+|GLOBAL|NOSYSTEM)|GIT_TERMINAL_PROMPT|GIT_SSH_COMMAND|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL))$/.test(name)) continue;
    lines.push(`export ${name}=${quoted(value)}`);
  }
  return lines;
}

async function credential(action: string | undefined): Promise<number> {
  if (action !== 'get') return 0;
  const asked = Object.fromEntries(readFileSync(0, 'utf8').split('\n').filter((line) => line.includes('='))
    .map((line): [string, string] => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (asked.protocol !== 'https' || asked.host !== HOST) return 0;
  const minted = forgeToken();
  if (!minted) return 0;
  process.stdout.write(`username=x-access-token\npassword=${minted.token}\n`);
  return 0;
}

if (runAsCommand(import.meta.url)) {
  const [command, action] = process.argv.slice(2);
  try {
    if (command === 'shell') process.stdout.write(`${shellLines(loadConf()).join('\n')}\n`);
    else if (command === 'token') {
      const minted = forgeToken();
      if (!minted) throw new ForgeError('forge credential: no GitHub App is configured ([forge]); forge calls use the ambient credential');
      process.stdout.write(`${minted.token}\n`);
    } else if (command === 'credential') {
      try { process.exitCode = await credential(action); }
      catch (error) {
        // quit: git asks no other helper and prompts nobody (no askpass either).
        process.stdout.write('quit=1\n');
        throw error;
      }
    }
    else { console.error('usage: forge.ts shell | token | credential <get|store|erase>'); process.exitCode = 64; }
  } catch (error) {
    console.error(`cleared ${error instanceof ForgeError ? error.message : `forge credential: ${(error as Error).message}`}`);
    process.exitCode = 1;
  }
}
