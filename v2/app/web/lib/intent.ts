// What a shell command means to do, in one sentence of the person's
// language (docs/v2/ui-overhaul-plan.md, 2.5.1 and U9, lane 36): "Run the
// project's tests" for `npm test 2>&1 | tail -8`, "Read the repository and
// run the tests" for a compound of reads and tests, "docker …" for a command
// the table does not know. The session screen says its checks and its
// commands with it, the raw command folded under; the inbox's permission
// titles (lane 37) use the same function.
//
// The command is cut into its parts for display only (commandParts): the
// decision on a command is the service's policy's, never this reading.
// Each part's first word, after the variables set before it, a `cd` and
// the redirections, names its kind (KINDS); a part that reads what a pipe
// gives it (`| tail -8`) says nothing of its own. One kind says its own
// phrase; several say each class once (the reads, the checks), in the
// order they come, joined as a sentence. Pure, so the tests run it under
// Node; the words are the `intent_*` keys of the shell's catalog, which
// every screen's translator holds.
import type { Translate } from './i18n.ts';

export const INTENT_KINDS = [
  'git_read', 'read_files', 'search', 'list', 'tests', 'typecheck', 'lint', 'build', 'install', 'install_all',
  'network', 'network_any', 'commit', 'push', 'branch', 'discard', 'delete', 'files', 'start', 'script', 'unknown',
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

// A kind, and what it names: the packages, the host, the script, or the unknown command's first word.
export type Intent = { readonly kind: IntentKind; readonly name?: string };
export type CommandPart = { readonly op: '' | ';' | '&&' | '||' | '|' | '&'; readonly text: string };

// The classes a compound says once each, whatever kinds of them it holds.
const CLASS: Partial<Record<IntentKind, 'read' | 'checks'>> = {
  git_read: 'read', read_files: 'read', search: 'read', list: 'read', tests: 'checks', typecheck: 'checks', lint: 'checks', build: 'checks',
};
const CLASS_KEY = { read: 'intent_read_any', checks: 'intent_checks_any' } as const;

// The parts of a command and the operator before each, for display: cut at
// `;`, `&&`, `||`, `|`, `&` and new lines outside quotes; a subshell's
// parentheses dropped; `2>&1` and `>&2` are redirections, not operators.
export function commandParts(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let text = '';
  let op: CommandPart['op'] = '';
  let quote: string | null = null;
  // An operator after nothing (a new line after `&`) leaves the one before it.
  const cut = (next: CommandPart['op']) => {
    const trimmed = text.trim();
    text = '';
    if (!trimmed) return;
    parts.push({ op: parts.length === 0 ? '' : op, text: trimmed });
    op = next;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < command.length) { text += c + command[++i]; continue; }
      if (c === quote) quote = null;
      text += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) { text += c + command[++i]; continue; }
    if (c === '"' || c === '\'') { quote = c; text += c; continue; }
    const next = command[i + 1];
    if (c === ';' || c === '\n') { cut(';'); continue; }
    if (c === '|') { if (next === '|') { i++; cut('||'); } else cut('|'); continue; }
    if (c === '&') {
      if (next === '&') { i++; cut('&&'); continue; }
      if (command[i - 1] === '>' || next === '>') { text += c; continue; }
      cut('&');
      continue;
    }
    if (c === '(' || c === ')') { text += ' '; continue; }
    text += c;
  }
  cut(';');
  return parts;
}

// A part's words, outside quotes, the quotes taken off.
function words(part: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote: string | null = null;
  let any = false;
  for (const c of part) {
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === '\'') { quote = c; any = true; continue; }
    if (/\s/.test(c)) { if (word || any) out.push(word); word = ''; any = false; continue; }
    word += c;
  }
  if (word || any) out.push(word);
  return out;
}

const REDIRECT = /^(?:\d?>>?|&>|<)(?:&\d)?\S*$|^\d?>&\d$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const QUIET = new Set(['cd', 'echo', 'printf', 'true', 'false', 'set', 'export', 'sleep', 'clear', 'exit', 'wait', 'source', '.', ':']);
const PREFIX = new Set(['sudo', 'env', 'time', 'nice', 'command', 'exec']);

const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'blame', 'merge-base', 'rev-parse', 'ls-files', 'grep', 'describe', 'shortlog', 'reflog', 'cat-file', 'rev-list', 'whatchanged']);
const READ_FILES = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'awk', 'sort', 'uniq', 'stat', 'file', 'jq', 'diff', 'cmp', 'nl', 'bat']);
const SEARCH = new Set(['grep', 'egrep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate']);
const LIST = new Set(['ls', 'tree', 'du', 'pwd', 'realpath']);
const NETWORK = new Set(['curl', 'wget', 'http', 'https', 'nc', 'ssh', 'scp', 'ping', 'dig', 'nslookup', 'telnet']);
const DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred']);
const FILES = new Set(['mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'tee', 'install']);
const TESTS = new Set(['vitest', 'jest', 'mocha', 'pytest', 'ava', 'tap', 'karma', 'cypress', 'phpunit', 'rspec']);
const TYPECHECK = new Set(['tsc', 'mypy', 'pyright', 'flow']);
const LINT = new Set(['eslint', 'prettier', 'biome', 'stylelint', 'ruff', 'flake8', 'pylint', 'rubocop', 'golangci-lint', 'shellcheck']);
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const INSTALL_VERBS = new Set(['install', 'i', 'add', 'ci']);

// A script of package.json, by its name.
function script(name: string): Intent {
  if (/test|spec|e2e/i.test(name)) return { kind: 'tests' };
  if (/typecheck|types|tsc/i.test(name)) return { kind: 'typecheck' };
  if (/lint|format|prettier/i.test(name)) return { kind: 'lint' };
  if (/build|compile|bundle/i.test(name)) return { kind: 'build' };
  if (/^(?:start|dev|serve|preview|watch)(?::|$)/i.test(name)) return { kind: 'start' };
  return { kind: 'script', name };
}

const packages = (args: readonly string[]) => args.filter((a) => a.startsWith('@') || (!a.startsWith('-') && !a.includes('/')));

function hostOf(args: readonly string[]): string | undefined {
  for (const arg of args) {
    const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::\d+)?(?:[/?#]|$)/i.exec(arg);
    if (match && !arg.startsWith('-')) return match[1];
  }
  return undefined;
}

// One part's intent; undefined for a part that says nothing (a `cd`, an echo).
function intentOfPart(part: string): Intent | undefined {
  let all = words(part).filter((w) => !REDIRECT.test(w));
  while (all.length > 0 && (ASSIGN.test(all[0] as string) || PREFIX.has(all[0] as string))) all = all.slice(1);
  const [first, ...args] = all;
  if (!first) return undefined;
  const name = first.split('/').at(-1) ?? first;
  const sub = args.find((a) => !a.startsWith('-'));
  if (QUIET.has(name)) return undefined;
  if (name === 'git') {
    if (sub === undefined || GIT_READ.has(sub)) return { kind: 'git_read' };
    if (sub === 'branch') return args.some((a) => /^-[dDmM]$|^--(?:delete|move)$/.test(a)) ? { kind: 'branch' } : { kind: 'git_read' };
    if (sub === 'add' || sub === 'commit') return { kind: 'commit' };
    if (sub === 'push') return { kind: 'push' };
    // What throws the checkout's changes away says so (review of 251, F2).
    if (sub === 'restore' || sub === 'clean' || (sub === 'reset' && args.includes('--hard')) || (sub === 'checkout' && (args.includes('--') || args.includes('.')))) return { kind: 'discard' };
    if (sub === 'checkout' || sub === 'switch') return { kind: 'branch' };
    return { kind: 'unknown', name: `git ${sub}` };
  }
  if (MANAGERS.has(name)) {
    const verb = sub;
    if (verb === undefined) return name === 'yarn' ? { kind: 'install_all' } : { kind: 'unknown', name };
    if (verb === 'test' || verb === 't') return { kind: 'tests' };
    if (verb === 'start') return { kind: 'start' };
    if (INSTALL_VERBS.has(verb)) {
      const named = packages(args.slice(args.indexOf(verb) + 1));
      return named.length > 0 ? { kind: 'install', name: named.join(', ') } : { kind: 'install_all' };
    }
    if (verb === 'run' || verb === 'run-script') {
      const target = args.slice(args.indexOf(verb) + 1).find((a) => !a.startsWith('-'));
      return target ? script(target) : { kind: 'unknown', name };
    }
    if (verb === 'exec' || verb === 'dlx' || verb === 'x') return intentOfPart(args.slice(args.indexOf(verb) + 1).join(' '));
    return script(verb);
  }
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') return intentOfPart(args.filter((a) => a !== '-y' && a !== '--yes').join(' ')) ?? { kind: 'unknown', name };
  if (name === 'node' || name === 'deno' || name === 'python' || name === 'python3') {
    if (args.includes('--test') || (args[0] === '-m' && (args[1] === 'pytest' || args[1] === 'unittest')) || sub === 'test') return { kind: 'tests' };
    if (name === 'deno' && (sub === 'check' || sub === 'lint')) return { kind: sub === 'check' ? 'typecheck' : 'lint' };
    return { kind: 'unknown', name };
  }
  if (name === 'pip' || name === 'pip3') {
    if (sub !== 'install') return { kind: 'unknown', name };
    const named = args.slice(args.indexOf('install') + 1);
    if (named.includes('-r') || named.length === 0) return { kind: 'install_all' };
    return { kind: 'install', name: named.filter((a) => !a.startsWith('-')).join(', ') };
  }
  if (name === 'go' || name === 'cargo') {
    if (sub === 'test') return { kind: 'tests' };
    if (sub === 'build') return { kind: 'build' };
    if (sub === 'vet' || sub === 'clippy') return { kind: 'lint' };
    if (sub === 'check') return { kind: 'typecheck' };
    if (sub === 'get' || sub === 'add') return { kind: 'install', name: packages(args.slice(1)).join(', ') };
    return { kind: 'unknown', name };
  }
  if (name === 'make') return sub && /test|check/.test(sub) ? { kind: 'tests' } : { kind: 'build' };
  if (name === 'find' && (args.includes('-delete') || args.some((a, i) => (a === '-exec' || a === '-execdir' || a === '-ok') && /(^|\/)(rm|rmdir|unlink|shred)$/.test(args[i + 1] ?? '')))) return { kind: 'delete' };
  if (name === 'find' && args.some((a) => a === '-exec' || a === '-execdir' || a === '-ok')) return { kind: 'unknown', name };
  if (name === 'sort' && args.some((a) => a === '-o' || a.startsWith('--output'))) return { kind: 'files' };
  if (name === 'sed') return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')) ? { kind: 'files' } : { kind: 'read_files' };
  if (name === 'playwright' && sub === 'test') return { kind: 'tests' };
  if (TESTS.has(name)) return { kind: 'tests' };
  if (TYPECHECK.has(name)) return { kind: 'typecheck' };
  if (LINT.has(name)) return { kind: 'lint' };
  if (SEARCH.has(name)) return { kind: 'search' };
  if (READ_FILES.has(name)) return { kind: 'read_files' };
  if (LIST.has(name)) return { kind: 'list' };
  if (NETWORK.has(name)) {
    const host = hostOf(args);
    return host ? { kind: 'network', name: host } : { kind: 'network_any' };
  }
  if (DELETE.has(name)) return { kind: 'delete' };
  if (FILES.has(name)) return { kind: 'files' };
  return { kind: 'unknown', name };
}

// What reads a pipe and runs or writes it: a shell, an interpreter, xargs, tee.
const RUNS_INPUT = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'xargs', 'tee', 'sudo', 'env']);

// What a pipe's reader does: nothing of its own (`| tail -8`), unless it
// runs what it reads (`| sh`), runs a command on it (`| xargs rm`) or writes it (`| tee`).
function piped(part: string): Intent | undefined {
  const all = words(part).filter((w) => !REDIRECT.test(w) && !ASSIGN.test(w));
  const first = all[0]?.split('/').at(-1) ?? '';
  if (!RUNS_INPUT.has(first)) return undefined;
  if (first === 'tee') return { kind: 'files' };
  if (first === 'xargs') return intentOfPart(all.slice(1).filter((a, i, rest) => !a.startsWith('-') || rest.slice(0, i).some((b) => !b.startsWith('-'))).join(' ')) ?? { kind: 'unknown', name: first };
  if (first === 'sudo' || first === 'env') return intentOfPart(all.slice(1).join(' '));
  return { kind: 'unknown', name: first };
}

// The intents of a command, in order, each once; what a pipe reads says
// nothing, unless it runs or writes what it reads.
export function intentsOf(command: string): Intent[] {
  const out: Intent[] = [];
  for (const part of commandParts(command)) {
    const intent = part.op === '|' ? piped(part.text) : intentOfPart(part.text);
    if (intent && !out.some((seen) => seen.kind === intent.kind && seen.name === intent.name)) out.push(intent);
  }
  return out;
}

const capital = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const phrase = (intent: Intent, t: Translate) => t(`intent_${intent.kind}`, intent.name === undefined ? {} : { name: intent.name });

function list(items: readonly string[], t: Translate): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${t('intent_and')} ${items.at(-1)}`;
}

// The sentence: one intent says its phrase; several say each class once.
export function intentSentence(command: string, t: Translate): string {
  const intents = intentsOf(command);
  if (intents.length === 0 || (intents.length === 1 && intents[0]?.kind === 'unknown')) {
    const first = intents[0]?.name ?? words(commandParts(command)[0]?.text ?? '').find((w) => !ASSIGN.test(w))?.split('/').at(-1);
    return first ? t('intent_alone', { name: first }) : '';
  }
  if (intents.length === 1) return capital(phrase(intents[0] as Intent, t));
  const groups: { readonly key: string; readonly members: Intent[] }[] = [];
  for (const intent of intents) {
    const group = CLASS[intent.kind] ?? `${intent.kind} ${intent.name ?? ''}`;
    const found = groups.find((g) => g.key === group);
    if (found) found.members.push(intent);
    else groups.push({ key: group, members: [intent] });
  }
  const said = groups.map(({ key, members }) => {
    const kinds = new Set(members.map((m) => m.kind));
    return kinds.size > 1 && (key === 'read' || key === 'checks') ? t(CLASS_KEY[key]) : phrase(members[0] as Intent, t);
  });
  return capital(list(said, t));
}

const KNOWN = new Set([
  'git', 'node', 'deno', 'python', 'python3', 'pip', 'pip3', 'go', 'cargo', 'make', 'sed', 'npx', 'pnpx', 'bunx', 'docker', 'bash', 'sh', 'zsh',
  ...MANAGERS, ...READ_FILES, ...SEARCH, ...LIST, ...NETWORK, ...DELETE, ...FILES, ...TESTS, ...TYPECHECK, ...LINT,
]);

// A name that reads as a command rather than words: an operator, a path to
// run, or a first word the table knows, in lower case.
export function looksLikeCommand(text: string): boolean {
  const parts = commandParts(text);
  if (parts.length > 1) return true;
  const first = words(parts[0]?.text ?? '')[0];
  if (!first) return false;
  return first.startsWith('./') || first.startsWith('/') || (KNOWN.has(first) && first === first.toLowerCase() && !/^[A-Z]/.test(text));
}
