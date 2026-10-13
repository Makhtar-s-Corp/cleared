// Reads agents.conf and resolves where the shared state lives.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('CLEARED_')) process.env[`ORCH_${name.slice(8)}`] = value;
}

export const ORCH_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = () => join(ORCH_HOME, 'agents.example.conf');
const SAFE_DEFAULTS = {
  policy: { guard_refusal: 'stop' },
  lead: { live: 'no', terminals_kept: '3', max_minutes: '20', report_hours: '6', messages_per_lane_per_hour: '6' },
  review: { differs_from_author: 'yes', per_hour: '8' },
  merge: { separate_identity: 'required', queue_hours: '24', queue_max_attempts: '30' },
  limits: { max_lanes: '1', subscription_stop: '90', subscription_switch: '80', cli_max_days_behind: '14' },
  lanes: { runs_per_day: '12', session_hours: '6', base_without_model: 'yes', heavy_wait_minutes: '30', tidy_hour: '6', idle_hours: '24' },
  tracker: { comments_per_hour: '6' },
  dashboard: { timezone: 'UTC', timezone_label: 'UTC', warn_days: '14' },
  update: { self: 'no', project: 'no' },
  'adapter.codex': { runner: 'host' },
  memory: { enabled: 'false', budget: '12000', decisions: 'docs/decisions/', glossary: 'docs/glossary.md',
    project: 'docs/project.md', lessons: '.cleared/prompts/<role>/lessons.md' },
  release: { watch_minutes: '15', deploy_grace_minutes: '5', failures_to_rollback: '3', auto_rollback: 'false' },
  heartbeat: { timeout_secs: '10', wake_interval_minutes: '1', pending_minutes: '30', service_minutes: '10',
    lane_idle_minutes: '120', orphan_hours: '6' },
};
const REQUIRED = {
  merge: ['tooling_paths', 'guarded_paths', 'code_paths', 'verdict'],
  tracker: ['adapter', 'team', 'validate_state', 'go_state', 'done_state', 'progress_state', 'review_state', 'todo_state'],
  lanes: ['root', 'base', 'push_roles', 'busy_states', 'closed_states', 'archives'],
  lead: ['report_on'],
};
export function defaultValue(name, key) { return SAFE_DEFAULTS[name]?.[key]; }
export function requiredValue(name, key) { return REQUIRED[name]?.includes(key) ?? false; }
export function requireSetting(conf, name, key) {
  const value = conf.sections[name]?.[key];
  if (value === undefined || value === '') throw new Error(`Missing required [${name}] ${key} in project agents.conf`);
  return value;
}
export const ignoredConfigs = new Set();
export const duplicateConfigKeys = new Set();
function trackedProjectConfig(project, relative) {
  try { execFileSync('git', ['-C', project, 'ls-files', '--error-unmatch', '--', relative], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// True when the module at `url` is the script node was started with, whatever
// the path looks like (a space, an accent, a symbolic link).
export function runAsCommand(url) {
  try {
    return Boolean(process.argv[1]) && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// The project the tool works on, by its main checkout: said by whoever runs
// it (ORCH_REPO), else once for the machine (first line of
// ~/.config/cleared/project), else the repository the tool sits in (a project
// that carries its own copy of it). The same order as lib/common.sh.
export function projectDir() {
  if (process.env.CLEARED_REPO || process.env.ORCH_REPO) return process.env.CLEARED_REPO || process.env.ORCH_REPO;
  try {
    const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const named = readFileSync(join(root, 'cleared', 'project'), 'utf8').split('\n')[0].trim();
    if (named) return named;
  } catch { /* no project named for the machine */ }
  const out = execFileSync('git', ['-C', ORCH_HOME, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  return out.split('\n')[0].replace(/^worktree /, '');
}

// Project settings must be tracked in .cleared/agents.conf.
export function confPath() {
  if (process.env.CLEARED_CONF || process.env.ORCH_CONF) return process.env.CLEARED_CONF || process.env.ORCH_CONF;
  const project = projectDir();
  const current = join(project, '.cleared', 'agents.conf');
  if (existsSync(current) && trackedProjectConfig(project, '.cleared/agents.conf')) return current;
  if (existsSync(current)) {
    ignoredConfigs.add(current);
    return join(project, '.cleared', 'tracked-agents.conf-missing');
  }
  return current;
}

export function expandHome(p) {
  return p && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

// One ledger for every lane, kept on the machine outside the repositories:
// one folder per project, named after its checkout.
export function stateDir() {
  if (process.env.CLEARED_STATE_DIR || process.env.ORCH_STATE_DIR) return process.env.CLEARED_STATE_DIR || process.env.ORCH_STATE_DIR;
  const root = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const name = basename(projectDir());
  return join(root, 'cleared', name);
}

function tokens(line) {
  const out = [];
  const re = /(?:[^\s"]+|"[^"]*")+/g;
  let m;
  while ((m = re.exec(line))) out.push(m[0].replace(/"/g, ''));
  return out;
}

function parseRule(line, lineNumber) {
  const [left, alias] = line.split('->').map((part) => part.trim());
  if (!alias || !left) throw new Error(`agents.conf line ${lineNumber}: a rule reads "<role> <conditions> -> <alias>"`);
  const [role, ...rest] = tokens(left);
  const conditions = rest.map((token) => {
    const m = token.match(/^([a-z_]+)(=|>|<)(.+)$/);
    if (!m) throw new Error(`agents.conf line ${lineNumber}: unreadable condition "${token}"`);
    return { key: m[1], op: m[2], value: m[3] };
  });
  return { role, conditions, alias, line: line.replace(/\s+/g, ' ') };
}

export function parseConf(text) {
  const conf = { models: {}, fallbacks: {}, roles: {}, rules: [], sections: {} };
  let section = null;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      conf.sections[section] ??= {};
      return;
    }
    if (!section) throw new Error(`agents.conf line ${index + 1}: text before the first section`);
    if (section === 'rules') {
      conf.rules.push(parseRule(line, index + 1));
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`agents.conf line ${index + 1}: expected "key = value"`);
    const key = line.slice(0, eq).trim();
    if (Object.hasOwn(conf.sections[section], key)) {
      duplicateConfigKeys.add(`[${section}] ${key}`);
      return;
    }
    conf.sections[section][key] = line.slice(eq + 1).trim();
  });
  for (const [alias, target] of Object.entries(conf.sections.models || {})) {
    const colon = target.indexOf(':');
    if (colon < 1) throw new Error(`agents.conf [models] ${alias}: expected "adapter:model id"`);
    conf.models[alias] = { alias, adapter: target.slice(0, colon), model: target.slice(colon + 1) };
  }
  conf.fallbacks = conf.sections.fallbacks || {};
  conf.roles = conf.sections.roles || {};
  return conf;
}

export function loadConf(path = confPath()) {
  if (path === examplePath()) return parseConf(readFileSync(path, 'utf8'));
  const project = parseConf(existsSync(path) ? readFileSync(path, 'utf8') : '');
  const sections = {};
  for (const [name, values] of Object.entries(SAFE_DEFAULTS)) sections[name] = { ...values };
  for (const [name, values] of Object.entries(project.sections)) sections[name] = { ...sections[name], ...values };
  const loaded = {
    sections,
    models: project.models,
    fallbacks: project.fallbacks,
    roles: project.roles,
    rules: project.rules,
  };
  Object.defineProperty(loaded, 'missingRules', { value: !project.sections.rules });
  return loaded;
}

export function section(conf, name) {
  return conf.sections[name] || {};
}

if (runAsCommand(import.meta.url)) {
  const [command, name, key] = process.argv.slice(2);
  if (command === 'default') {
    const value = defaultValue(name, key);
    if (value !== undefined) process.stdout.write(`${value}\n`);
    else if (requiredValue(name, key)) { console.error(`Missing required [${name}] ${key} in project agents.conf`); process.exitCode = 2; }
    else process.exitCode = 1;
  } else if (command === 'default-keys') process.stdout.write(`${Object.keys(SAFE_DEFAULTS[name] || {}).join('\n')}\n`);
  else if (command === 'required') process.exitCode = requiredValue(name, key) ? 0 : 1;
}
