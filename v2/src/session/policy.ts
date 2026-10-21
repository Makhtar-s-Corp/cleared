// The policy that answers a harness's permission requests, per role
// (docs/v2/milestone-1-plan.md, section 5). Order: deny, then the compound
// command check, then allow (learned answers included), then ask. The deny
// rules read the raw text, every part of it, so that a compound command that
// names the base branch, a production host or a secret is denied, not asked.
// The allow rules read the one simple command a strict shell-word parser
// finds, word for word, never a prefix of the raw text.
import { posix } from 'node:path';
import type { Role } from './contract.ts';

export type Verdict =
  | { readonly decision: 'allow'; readonly rule: string }
  | { readonly decision: 'deny'; readonly rule: string; readonly message: string }
  | { readonly decision: 'ask'; readonly rule: string; readonly reason: string };   // goes to the inbox

export type Policy = {
  readonly role: Role;
  readonly base: string;                      // the project's base branch
  readonly workdir: string;                   // the workdir as the harness sees it (its mount point in the container)
  readonly scripts: readonly string[];        // the scripts of package.json on the base branch, read by the service
  readonly credentialFile: string;            // the harness's credential file as mounted in the container
  readonly safeCommands: readonly string[];   // glob patterns, from the project's config, with Cleared's defaults
  readonly allowedHosts: readonly string[];   // the egress allow list, same source
  readonly forbiddenHosts: readonly string[]; // production and anything the project names
  readonly ticketFiles: readonly string[];    // what the ticket branch changed so far, relative to the workdir
  readonly learned: readonly { readonly tool: string; readonly pattern: string }[]; // "always in this project" answers
};

export type ToolRequest = {
  readonly tool: string;                      // the harness's tool name (Claude Code's in milestone 1)
  readonly input: Readonly<Record<string, unknown>>;
};

export type PolicyContext = {
  // The current text of a workdir file, by its path as the harness names it;
  // undefined when it does not exist or cannot be read. Used to see what an
  // edit of package.json changes.
  readonly readFile?: (path: string) => string | undefined;
};

// Safe commands, matched word by word: `*` alone matches any number of
// words, a `*` inside a word any characters of that word. `npm run <script>`
// is matched apart, against Policy.scripts.
export const DEFAULT_SAFE_COMMANDS: readonly string[] = [
  'npm test', 'npm test *',
  'node --test*', 'node --test* *',
  'git status', 'git status *',
  'git diff', 'git diff *',
  'git log', 'git log *',
  'git add *',
  'git commit *',
  'git checkout -b *',
  'git branch', 'git branch --show-current',
  'ls', 'ls *',
  'cat *', 'head *', 'tail *', 'grep *', 'find *',
  'pwd',
];

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const allow = (rule: string): Verdict => ({ decision: 'allow', rule });
const deny = (rule: string, message: string): Verdict => ({ decision: 'deny', rule, message });
const ask = (rule: string, reason: string): Verdict => ({ decision: 'ask', rule, reason });

// ---------------------------------------------------------------- parsing

// The words of one simple command, or undefined when the text is anything
// else: a list, a pipe, a redirection, a substitution, an expansion, a
// newline, an unclosed quote, or nothing at all. Quotes and backslashes are
// understood; every other special character is refused, so that what runs is
// exactly the words returned.
export function parseCommand(text: string): readonly string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let bare = '';                                  // the unquoted characters of the word, for brace expansion
  let i = 0;
  const end = () => {
    if (started) {
      if (/\{[^}]*(?:,|\.\.)[^}]*\}/.test(bare)) return false;
      words.push(word);
    }
    word = '';
    bare = '';
    started = false;
    return true;
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t') {
      if (!end()) return undefined;
      i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      const quoted = text.slice(i + 1, close);
      if (quoted.includes('\n') || quoted.includes('\r')) return undefined;
      word += quoted;
      started = true;
      i = close + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        const d = text[i];
        if (d === undefined || d === '$' || d === '`' || d === '\n' || d === '\r') return undefined;
        if (d === '"') break;
        if (d === '\\') {
          const next = text[i + 1];
          if (next === undefined || next === '\n' || next === '\r') return undefined;
          word += next === '$' || next === '`' || next === '"' || next === '\\' ? next : d + next;
          i += 2;
        } else {
          word += d;
          i++;
        }
      }
      started = true;
      i++;
    } else if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return undefined;
      word += next;
      started = true;
      i += 2;
    } else if (';&|<>()`$\n\r*?['.includes(c)) {
      return undefined;
    } else if ((c === '#' || c === '~') && !started) {
      return undefined;
    } else {
      word += c;
      bare += c;
      started = true;
      i++;
    }
  }
  if (!end() || words.length === 0) return undefined;
  return words;
}

// The raw text split, without failing, into the simple commands it may run:
// at every separator, substitution and grouping, quotes dropped. Used by the
// deny rules only, which must see through anything the parser refuses.
function looseCommands(text: string): string[][] {
  return text
    .replace(/["'\\]/g, '')
    .split(/\$\(|[;&|\n\r()`<>{}]/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

const basename = (word: string) => word.slice(word.lastIndexOf('/') + 1);

// Programs that run the next words as a command.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs', 'timeout', 'stdbuf', 'setsid', 'sh', 'bash', 'zsh', 'dash']);

// The words of a loose command that sit where a program name goes.
function commandWords(words: readonly string[]): string[] {
  const out: string[] = [];
  let atCommand = true;
  for (const [index, word] of words.entries()) {
    if (atCommand) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith('-') || (out.length > 0 && /^[0-9.]+[smhd]?$/.test(word))) continue;
      out.push(basename(word));
      atCommand = WRAPPERS.has(basename(word));
    } else if (['-exec', '-execdir', '-ok', '-okdir'].includes(words[index - 1] ?? '')) {
      out.push(basename(word));
    }
  }
  return out;
}

// git's words with its global options folded away: ['push', 'origin', 'main']
// for `git -C . push origin main`, and whether one of them changes what git
// reads or runs (-c, --git-dir, --work-tree and the like).
function gitCommand(words: readonly string[]): { readonly rest: readonly string[]; readonly risky: boolean } | undefined {
  const at = words.findIndex((word) => basename(word) === 'git');
  if (at < 0) return undefined;
  let i = at + 1;
  let risky = false;
  while (i < words.length && (words[i] as string).startsWith('-')) {
    const option = words[i] as string;
    if (option !== '-C') risky = true;
    i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(option) ? 2 : 1;
  }
  return { rest: words.slice(i), risky };
}

// The arguments of a git subcommand: its options, the values its options
// take (with their index in `args`) and its operands. Only git commit's
// options are known to take a value; for the other safe subcommands every
// word that is not an option is an operand, which is the careful reading.
const GIT_COMMIT_VALUES = new Set(['--message', '--file', '--template', '--reuse-message', '--reedit-message', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer']);
function gitArguments(sub: string, args: readonly string[]): { options: string[]; values: { option: string; value: string; at: number }[]; operands: string[] } {
  const options: string[] = [];
  const values: { option: string; value: string; at: number }[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      operands.push(word);
      continue;
    }
    options.push(word);
    const takesValue = sub === 'commit' && (word.startsWith('--') ? GIT_COMMIT_VALUES.has(word) : /[mFtCc]$/.test(word));
    if (takesValue && i + 1 < args.length) {
      values.push({ option: word, value: args[i + 1] as string, at: i + 1 });
      i++;
    }
  }
  return { options, values, operands };
}

// ---------------------------------------------------------------- matching

function globWord(pattern: string, word: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  return re.test(word);
}

function globWords(pattern: readonly string[], words: readonly string[]): boolean {
  if (pattern.length === 0) return words.length === 0;
  const [head, ...rest] = pattern as [string, ...string[]];
  if (head === '*') {
    for (let skip = 0; skip <= words.length; skip++) if (globWords(rest, words.slice(skip))) return true;
    return false;
  }
  return words.length > 0 && globWord(head, words[0] as string) && globWords(rest, words.slice(1));
}

const splitPattern = (pattern: string) => pattern.trim().split(/\s+/).filter(Boolean);

function hostMatches(host: string, list: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return list.some((entry) => {
    const listed = entry.toLowerCase().replace(/^\*\./, '');
    return name === listed || name.endsWith(`.${listed}`);
  });
}

// A host named anywhere in a text: the host itself or one of its subdomains,
// as a whole name.
function namesHost(text: string, list: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  return list.find((entry) => {
    const listed = entry.toLowerCase().replace(/^\*\./, '');
    return listed !== '' && new RegExp(`(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*${listed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`).test(lower);
  });
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function inside(workdir: string, path: string): boolean {
  const root = posix.resolve('/', workdir);
  const resolved = posix.resolve(root, path);
  return resolved === root || resolved.startsWith(root === '/' ? '/' : `${root}/`);
}

const relative = (workdir: string, path: string) => posix.relative(posix.resolve('/', workdir), posix.resolve(posix.resolve('/', workdir), path));

// Every string an input carries, at any depth.
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

// ---------------------------------------------------------------- deny

// The plan's `id_*`, narrowed to the names ssh-keygen gives keys, so that
// src/id_generator.ts stays readable.
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?$/;

// The fields of a request that name files or places. What a tool writes
// (an edit's text, a description, a prompt) is never read for names: code
// says event.key and a README says .env.example. A tool this list does not
// know is read whole.
//
// In Bash, a simple command is read word by word, without the words that
// are text: the arguments of echo and printf, the message of git commit.
// A command the parser cannot read is read whole, quotes and all.
function namedPaths(request: ToolRequest): string[] {
  const { input } = request;
  if (request.tool === 'Bash' && typeof input.command === 'string') {
    const words = parseCommand(input.command);
    if (!words) return [input.command];
    if (words[0] === 'echo' || words[0] === 'printf') return [];
    const git = gitCommand(words);
    if (words[0] === 'git' && git?.rest[0] === 'commit') {
      const message = new Set(gitArguments('commit', git.rest.slice(1)).values.filter((v) => v.option === '--message' || /^-[A-Za-z]*m$/.test(v.option)).map((v) => v.at));
      return [...words.slice(0, words.length - git.rest.length + 1), ...git.rest.slice(1).filter((word, i) => !message.has(i) && !word.startsWith('--message='))];
    }
    return [...words];
  }
  const fields: Record<string, readonly string[]> = {
    Bash: ['command'], WebFetch: ['url'], WebSearch: [], Read: ['file_path'], Glob: ['path', 'pattern'], Grep: ['path', 'glob'],
    Edit: ['file_path'], Write: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'],
  };
  const names = fields[request.tool];
  if (!names) return strings(input);
  return names.map((name) => input[name]).filter((value): value is string => typeof value === 'string');
}

function secretNamed(text: string, policy: Policy): boolean {
  const credential = policy.credentialFile;
  const credentialName = basename(credential);
  for (const token of text.split(/[\s"'`=,;:|&<>()$]+/).filter(Boolean)) {
    if (token.includes('.ssh/') || token.includes('/run/cleared/') || (credential !== '' && token.includes(credential))) return true;
    for (const part of token.split('/')) {
      if (part === '.ssh' || part.startsWith('.env') || part.endsWith('.pem') || part.endsWith('.key') || SSH_KEY.test(part)) return true;
      if (credentialName !== '' && part === credentialName) return true;
    }
  }
  return false;
}

function pushesBase(words: readonly string[], base: string): string | undefined {
  const git = gitCommand(words);
  if (git?.rest[0] === 'push') {
    for (const word of git.rest.slice(1)) {
      if (word === '--force' || word.startsWith('--force-with-lease') || word.startsWith('--force-if-includes') || /^-[A-Za-z]*f[A-Za-z]*$/.test(word)) return `a forced push (${word})`;
      if (word === '--mirror' || word === '--all') return `a push of every branch (${word})`;
      if (word.startsWith('-')) continue;
      if (word.startsWith('+')) return `a forced push (${word})`;
      for (const ref of word.split(':')) if (ref.replace(/^refs\/heads\//, '') === base) return `a push to the base branch ${base}`;
    }
  }
  const gh = words.findIndex((word) => basename(word) === 'gh');
  if (gh >= 0) {
    const rest: string[] = [];
    for (let i = gh + 1; i < words.length; i++) {
      const word = words[i] as string;
      if (word === '-R' || word === '--repo') i++;
      else if (!word.startsWith('-')) rest.push(word);
    }
    if (rest[0] === 'repo') return 'gh repo';
    if (rest[0] === 'pr' && rest[1] === 'merge') return 'gh pr merge';
  }
  return undefined;
}

function denied(request: ToolRequest, policy: Policy): Verdict | undefined {
  const command = request.tool === 'Bash' && typeof request.input.command === 'string' ? request.input.command : undefined;
  const commands = command === undefined ? [] : looseCommands(command);
  for (const words of commands) {
    const why = pushesBase(words, policy.base);
    if (why) return deny('push.base', `${why} is never allowed: the base branch ${policy.base} changes only through the lock`);
  }
  for (const words of commands) {
    const program = commandWords(words).find((word) => word === 'docker' || word === 'sudo');
    if (program) return deny('host.docker', `${program} is not available in a session`);
  }
  const url = request.tool === 'WebFetch' && typeof request.input.url === 'string' ? request.input.url : undefined;
  const production = command !== undefined ? namesHost(command, policy.forbiddenHosts) : url !== undefined ? namesHost(urlHost(url) ?? url, policy.forbiddenHosts) : undefined;
  if (production) return deny('net.production', `${production} is a production host: a session never reaches it`);
  if (namedPaths(request).some((text) => secretNamed(text, policy))) return deny('secret.read', 'secrets, keys and credential files are never read in a session');
  if (policy.role === 'reviewer') {
    if (EDIT_TOOLS.has(request.tool)) return deny('reviewer.edit', 'a reviewer reads and runs the checks; it does not edit');
    for (const words of commands) {
      const sub = gitCommand(words)?.rest[0];
      if (sub === 'commit' || sub === 'push') return deny('reviewer.edit', `a reviewer does not run git ${sub}`);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- allow

const PACKAGE_DEPENDENCIES = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

// What an edit of package.json changes, from its current text and the edit.
function packageChange(request: ToolRequest, path: string, context: PolicyContext): 'scripts' | 'dependencies' | 'none' | 'unknown' {
  const before = context.readFile?.(path);
  let after: string | undefined;
  const input = request.input;
  if (request.tool === 'Write') after = typeof input.content === 'string' ? input.content : undefined;
  else if (before !== undefined) {
    const edits = request.tool === 'MultiEdit' && Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
    after = before;
    for (const edit of edits) {
      if (after === undefined || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || !after.includes(edit.old_string)) {
        after = undefined;
        break;
      }
      after = edit.replace_all === true ? after.split(edit.old_string).join(edit.new_string) : after.replace(edit.old_string, () => edit.new_string as string);
    }
  }
  if (after === undefined) return 'unknown';
  let old: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    old = before === undefined ? {} : JSON.parse(before);
    next = JSON.parse(after);
  } catch {
    return 'unknown';
  }
  const same = (key: string) => JSON.stringify(old?.[key]) === JSON.stringify(next?.[key]);
  if (!same('scripts')) return 'scripts';
  if (!PACKAGE_DEPENDENCIES.every(same)) return 'dependencies';
  return 'none';
}

function allowedEdit(request: ToolRequest, policy: Policy, context: PolicyContext): Verdict | undefined {
  const path = request.input.file_path ?? request.input.notebook_path;
  if (typeof path !== 'string' || !inside(policy.workdir, path)) return undefined;
  const parts = relative(policy.workdir, path).split('/');
  // Generated (CLAUDE.md), locked (.claude/) or run by git on the host (.git/).
  if (parts.includes('.claude') || parts.includes('.git') || parts.at(-1) === 'CLAUDE.md') return undefined;
  const name = parts.at(-1);
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') return ask('install.package', 'an edit of the lock file changes the installed packages');
  if (name === 'package.json') {
    const change = packageChange(request, path, context);
    if (change === 'scripts') return ask('scripts.change', 'a change to the scripts of package.json would let any command run as a safe one');
    if (change === 'unknown') return ask('scripts.change', 'the service could not tell what this edit of package.json changes');
    if (change === 'dependencies') return ask('install.package', 'an edit of the dependencies of package.json installs packages');
  }
  return allow('edit.workdir');
}

function allowedRead(request: ToolRequest, policy: Policy): Verdict | undefined {
  const { input } = request;
  const paths: unknown[] = request.tool === 'Read' ? [input.file_path] : [input.path ?? '.'];
  if (request.tool === 'Glob' && typeof input.pattern === 'string') paths.push(posix.join(typeof input.path === 'string' ? input.path : '.', input.pattern));
  return paths.every((path) => typeof path === 'string' && inside(policy.workdir, path)) ? allow('read.workdir') : undefined;
}

// Words of a safe command that would make it write, run or reach outside.
function unsafeWords(words: readonly string[], policy: Policy): boolean {
  const [program] = words;
  const args = words.slice(1);
  if (program === 'git') {
    const git = gitCommand(words);
    if (!git || git.risky) return true;
    const [sub = '', ...rest] = git.rest;
    const { options, operands } = gitArguments(sub, rest);
    // A file read through git: a path outside the workdir (git diff reads
    // two paths without --no-index when one is outside), a message file.
    if (operands.some((path) => !inside(policy.workdir, path))) return true;
    if (sub === 'commit' && options.some((word) => /^--(?:file|template|reuse-message|reedit-message)(?:=|$)/.test(word) || /^-[A-Za-z]*[FtCc]/.test(word))) return true;
    return options.some((word) =>
      word === '--no-index' || word.startsWith('--output') || word === '-o' || ((word.startsWith('--format') || word.startsWith('--pretty')) && /%\(|%x/.test(word)));
  }
  if (program === 'find') {
    const firstExpression = args.findIndex((word) => word.startsWith('-') || word === '(' || word === '!');
    const starts = firstExpression < 0 ? args : args.slice(0, firstExpression);
    if (starts.some((path) => !inside(policy.workdir, path))) return true;
    return args.some((word) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls'].includes(word) || word.startsWith('-fprint'));
  }
  if (program === 'grep') {
    if (args.some((word) => word === '-f' || word.startsWith('--file') || /^-[A-Za-z]*f/.test(word))) return true;
    const operands = args.filter((word) => !word.startsWith('-'));
    const named = args.some((word) => word === '-e' || word.startsWith('--regexp'));
    return (named ? operands : operands.slice(1)).some((path) => !inside(policy.workdir, path));
  }
  if (program === 'cat' || program === 'head' || program === 'tail' || program === 'ls')
    return args.filter((word) => !word.startsWith('-')).some((path) => !inside(policy.workdir, path));
  return false;
}

function safeCommand(words: readonly string[], policy: Policy): boolean {
  const folded = words[0] === 'git' ? ['git', ...(gitCommand(words)?.rest ?? [])] : words;
  if (folded[0] === 'npm' && folded[1] === 'run' && folded[2] !== undefined && policy.scripts.includes(folded[2]) && (folded.length === 3 || folded[3] === '--'))
    return true;
  if (!policy.safeCommands.some((pattern) => globWords(splitPattern(pattern), folded))) return false;
  return !unsafeWords(words, policy);
}

function learned(request: ToolRequest, words: readonly string[] | undefined, policy: Policy): boolean {
  const input = request.input;
  const subject = words
    ? undefined
    : [input.file_path, input.notebook_path, input.url, input.path, input.pattern, input.query].find((value) => typeof value === 'string') ?? JSON.stringify(input);
  return policy.learned.some((entry) => entry.tool === request.tool && (words ? globWords(splitPattern(entry.pattern), words) : globWord(entry.pattern, subject as string)));
}

// ---------------------------------------------------------------- ask

function asked(request: ToolRequest, words: readonly string[] | undefined, policy: Policy): Verdict {
  if (words) {
    const [program, sub] = words;
    const install =
      (program === 'npm' && (sub === 'i' || sub === 'add' || sub?.startsWith('install'))) ||
      ((program === 'pnpm' || program === 'yarn') && sub === 'add') ||
      ((program === 'pip' || program === 'pip3') && sub?.startsWith('install')) ||
      program === 'apt-get' || (program === 'apk' && sub === 'add') || program === 'npx';
    if (install) return ask('install.package', `${words.slice(0, 2).join(' ')} installs or downloads packages`);

    const git = program === 'git' ? gitCommand(words)?.rest ?? [] : [];
    const recursive = program === 'rm' && words.slice(1).some((word) => word === '--recursive' || /^-[A-Za-z]*[rR]/.test(word));
    if (recursive || git[0] === 'clean' || (git[0] === 'checkout' && git[1] === '--' && git[2] === '.') || (git[0] === 'reset' && git[1]?.startsWith('--hard')))
      return ask('delete.outside_ticket', `${words.join(' ')} deletes more than the files of the ticket`);
    if (program === 'rm') {
      const outside = words.slice(1).filter((word) => !word.startsWith('-')).filter((path) => !inside(policy.workdir, path) || !policy.ticketFiles.includes(relative(policy.workdir, path)));
      if (outside.length > 0) return ask('delete.outside_ticket', `${outside.join(', ')} is not a file this ticket changed`);
    }

    if (program === 'curl' || program === 'wget' || program === 'ssh' || program === 'nc') {
      const hosts = words.slice(1).filter((word) => !word.startsWith('-')).map((word) => urlHost(word) ?? word.replace(/^[^@]*@/, '').replace(/:.*$/, ''));
      if (hosts.length === 0 || !hosts.every((host) => hostMatches(host, policy.allowedHosts)))
        return ask('net.undeclared', `${program} to a host the project does not declare`);
    }
  }
  if (request.tool === 'WebSearch') return ask('net.undeclared', 'a web search reaches hosts the project does not declare');
  if (request.tool === 'WebFetch') {
    const host = typeof request.input.url === 'string' ? urlHost(request.input.url) : undefined;
    if (!host || !hostMatches(host, policy.allowedHosts)) return ask('net.undeclared', `${host ?? 'this address'} is not a host the project declares`);
  }
  return ask('default', 'no rule allows this request');
}

// ---------------------------------------------------------------- evaluate

export function evaluate(request: ToolRequest, policy: Policy, context: PolicyContext = {}): Verdict {
  const refused = denied(request, policy);
  if (refused) return refused;

  let words: readonly string[] | undefined;
  if (request.tool === 'Bash') {
    words = typeof request.input.command === 'string' ? parseCommand(request.input.command) : undefined;
    if (!words) return ask('shell.compound', 'more than one simple command, or shell syntax the policy does not read word for word');
  }

  if (READ_TOOLS.has(request.tool)) {
    const read = allowedRead(request, policy);
    if (read) return read;
  }
  if (EDIT_TOOLS.has(request.tool)) {
    const edit = allowedEdit(request, policy, context);
    if (edit) return edit;
  }
  if (words && safeCommand(words, policy)) return allow('run.safe');
  if (learned(request, words, policy)) return allow('learned');

  return asked(request, words, policy);
}
