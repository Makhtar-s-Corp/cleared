// Reads agents.conf and resolves where the shared state lives.
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

export const ORCH_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// True when the module at `url` is the script node was started with, whatever
// the path looks like (a space, an accent, a symbolic link).
export function runAsCommand(url) {
  try {
    return Boolean(process.argv[1]) && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

export function confPath() {
  return process.env.ORCH_CONF || join(ORCH_HOME, 'agents.conf');
}

export function expandHome(p) {
  return p && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

// One ledger for every lane: the state sits in the main checkout, whatever
// worktree the script runs from.
export function stateDir() {
  if (process.env.ORCH_STATE_DIR) return process.env.ORCH_STATE_DIR;
  const out = execFileSync('git', ['-C', ORCH_HOME, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const main = out.split('\n')[0].replace(/^worktree /, '');
  return join(main, 'ops', 'orchestration', 'state');
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
  return parseConf(readFileSync(path, 'utf8'));
}

export function section(conf, name) {
  return conf.sections[name] || {};
}
