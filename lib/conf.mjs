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
const examplePath = () => preferPath(join(ORCH_HOME, 'agents.example.conf'), join(ORCH_HOME, 'agents.conf'));
export const legacyPathsUsed = new Set();
function preferPath(current, legacy) {
  if (existsSync(current)) return current;
  if (existsSync(legacy)) { legacyPathsUsed.add(legacy); return legacy; }
  return current;
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
// ~/.config/ferme/project), else the repository the tool sits in (a project
// that carries its own copy of it). The same order as lib/common.sh.
export function projectDir() {
  if (process.env.CLEARED_REPO || process.env.ORCH_REPO) return process.env.CLEARED_REPO || process.env.ORCH_REPO;
  try {
    const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const named = readFileSync(preferPath(join(root, 'cleared', 'project'), join(root, 'ferme', 'project')), 'utf8').split('\n')[0].trim();
    if (named) return named;
  } catch { /* no project named for the machine */ }
  const out = execFileSync('git', ['-C', ORCH_HOME, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  return out.split('\n')[0].replace(/^worktree /, '');
}

// Its settings: its own (.ferme/agents.conf), else the example of the tool.
export function confPath() {
  if (process.env.CLEARED_CONF || process.env.ORCH_CONF) return process.env.CLEARED_CONF || process.env.ORCH_CONF;
  const project = projectDir();
  const own = preferPath(join(project, '.cleared', 'agents.conf'), join(project, '.ferme', 'agents.conf'));
  return existsSync(own) ? own : examplePath();
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
  return preferPath(join(root, 'cleared', name), join(root, 'ferme', name));
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
    conf.sections[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
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
  if (!existsSync(examplePath())) return parseConf(readFileSync(path, 'utf8'));
  const defaults = parseConf(readFileSync(examplePath(), 'utf8'));
  if (path === examplePath()) return defaults;
  const project = parseConf(readFileSync(path, 'utf8'));
  const sections = { ...defaults.sections };
  for (const [name, values] of Object.entries(project.sections)) sections[name] = { ...sections[name], ...values };
  return {
    sections,
    models: { ...defaults.models, ...project.models },
    fallbacks: { ...defaults.fallbacks, ...project.fallbacks },
    roles: { ...defaults.roles, ...project.roles },
    rules: project.sections.rules ? project.rules : defaults.rules,
  };
}

export function section(conf, name) {
  return conf.sections[name] || {};
}
