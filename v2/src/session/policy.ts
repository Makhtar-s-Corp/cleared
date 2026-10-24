// The policy that answers a harness's permission requests, per role
// (docs/v2/milestone-1-plan.md, section 5). Order: deny, then the lead's
// rows for the lead (docs/v2/milestone-2-plan.md, section 3.3), then the
// compound command check, then allow (learned answers included), then ask.
// The deny rules read the raw text, every part of it, so that a compound
// command that names the base branch, a production host or a secret is
// denied, not asked. The allow rules read each simple command a strict
// shell-word parser finds, word for word, never a prefix of the raw text: a
// list of simple commands each allowed on its own is allowed as a whole
// (milestone 2, decision 10). A reader's verdicts (decision 28) are the
// reviewer's with the lead's cap on a Read, with no learned answer, and
// what would ask is refused: nobody answers a reader's requests.
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
  // An author whose session plan waits for its Go (milestone 2, decision 22):
  // it reads and runs the checks, and writes nothing but its HANDOVER.md.
  readonly planning?: boolean;
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

// The reviewer's own reads, on top of the safe commands (owner decision of
// 2026-10-22 22:03): what a review runs to find the ticket's change and read
// it. The reviewer's only, so that neither the author nor the reader, whose
// policy is built from DEFAULT_SAFE_COMMANDS, gains them.
export const REVIEWER_READS: readonly string[] = [
  'git show', 'git show *',
  'git merge-base *',
  'git rev-parse *',
  'rg *',
  'wc', 'wc *',
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
// exactly the words returned. `globs` (the proofs' driver only,
// scripts/proof-inbox.ts) also reads an unquoted *, ? or [ in a word with no
// slash that does not start with a dot: it names files of the current folder
// only, never `..` nor another folder; the policy never passes it.
export type ParseOptions = { readonly globs?: boolean };
export function parseCommand(text: string, options: ParseOptions = {}): readonly string[] | undefined {
  const words: string[] = [];
  let word = '';
  let started = false;
  let bare = '';                                  // the unquoted characters of the word, for brace expansion
  let globbed = false;                            // an unquoted *, ? or [ in the word (options.globs)
  let i = 0;
  const end = () => {
    if (started) {
      if (/\{[^}]*(?:,|\.\.)[^}]*\}/.test(bare)) return false;
      if (globbed && (word.includes('/') || word.startsWith('.'))) return false;
      words.push(word);
    }
    word = '';
    bare = '';
    globbed = false;
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
    } else if (options.globs && '*?['.includes(c)) {
      word += c;
      bare += c;
      globbed = true;
      started = true;
      i++;
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

// One simple command of a list: its words, the operator that joins it to
// the one before, and what its redirections do.
export type SimpleCommand = {
  readonly words: readonly string[];
  readonly after: ';' | '&&' | '||' | '|' | null;
  readonly writes: readonly string[];         // the files its > and >> write, whatever the stream
  readonly redirected: boolean;               // any redirection, a duplication such as 2>&1 included
};

// A list of simple commands joined by &&, ||, ; or |, each read by
// parseCommand, with its output redirections taken out: `>`, `>>`, `N>`,
// `&>` with one word as the target, and the duplications `N>&M`. Anything
// else is undefined: a lone & (background), |&, >|, an empty command, an
// input redirection or a here-document (parseCommand refuses <), and
// whatever parseCommand refuses in a part or a target. Quotes and
// backslashes are skipped whole, so a separator inside them is a character.
export function parseList(text: string, options: ParseOptions = {}): readonly SimpleCommand[] | undefined {
  const list: SimpleCommand[] = [];
  let part = '';
  let writes: string[] = [];
  let redirected = false;
  let after: SimpleCommand['after'] = null;
  let i = 0;
  // The quoted or escaped run that starts at i, copied whole; false when it does not close.
  const quoted = (): string | false => {
    const c = text[i] as string;
    if (c === '\\') return i + 1 < text.length ? text.slice(i, i + 2) : false;
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      return close < 0 ? false : text.slice(i, close + 1);
    }
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return j < text.length ? text.slice(i, j + 1) : false;
  };
  const end = (next: SimpleCommand['after']): boolean => {
    const words = parseCommand(part, options);
    if (!words) return false;
    list.push({ words, after, writes, redirected });
    part = '';
    writes = [];
    redirected = false;
    after = next;
    return true;
  };
  // A redirection at i, after its `>`, `>>` or `&>`: a duplication, or a target word.
  const redirect = (): boolean => {
    redirected = true;
    if (text[i] === '|') return false;
    if (text[i] === '&') {
      const digits = /^[0-9]+/.exec(text.slice(i + 1))?.[0];
      if (!digits) return false;
      i += 1 + digits.length;
      return i >= text.length || ' \t;&|'.includes(text[i] as string);
    }
    while (text[i] === ' ' || text[i] === '\t') i++;
    let raw = '';
    while (i < text.length && !' \t;&|<>()\n\r'.includes(text[i] as string)) {
      const run = '\\\'"'.includes(text[i] as string) ? quoted() : (text[i] as string);
      if (run === false) return false;
      raw += run;
      i += run.length;
    }
    const target = parseCommand(raw);
    if (target?.length !== 1 || target[0] === '') return false;
    writes.push(target[0] as string);
    return true;
  };
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '\\' || c === "'" || c === '"') {
      const run = quoted();
      if (run === false) return undefined;
      part += run;
      i += run.length;
    } else if (c === ';') {
      if (!end(';')) return undefined;
      i++;
    } else if (c === '&' && next === '&') {
      if (!end('&&')) return undefined;
      i += 2;
    } else if (c === '|' && next === '|') {
      if (!end('||')) return undefined;
      i += 2;
    } else if (c === '|') {
      if (next === '&' || !end('|')) return undefined;
      i++;
    } else if (c === '&' && next === '>') {
      i += next === '>' && text[i + 2] === '>' ? 3 : 2;
      if (!redirect()) return undefined;
    } else if (c === '&') {
      return undefined;
    } else if (c === '>') {
      // A file descriptor is digits standing alone just before the >.
      part = part.replace(/(^|[ \t])[0-9]+$/, '$1');
      i += next === '>' ? 2 : 1;
      if (!redirect()) return undefined;
    } else {
      part += c;
      i++;
    }
  }
  return end(null) ? list : undefined;
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
      // environ: a process's environment in /proc, where the claude process keeps its login.
      if (part === '.ssh' || part.startsWith('.env') || part.endsWith('.pem') || part.endsWith('.key') || SSH_KEY.test(part) || part === 'environ') return true;
      if (credentialName !== '' && part === credentialName) return true;
    }
  }
  return false;
}

// An `env` that runs no command, which prints the environment: after its
// options (-u, -C and -S take a value) and its assignments, nothing is left.
function printsEnvironment(words: readonly string[]): boolean {
  for (const [at, word] of words.entries()) {
    if (basename(word) !== 'env') continue;
    let i = at + 1;
    while (i < words.length) {
      const next = words[i] as string;
      if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(next)) i += 2;
      else if (next.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) i += 1;
      else break;
    }
    if (i >= words.length) return true;
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
  // The environment holds the login: printenv, and an env that runs nothing
  // (it prints the environment), are reads of it wherever they run.
  for (const words of commands) {
    if (commandWords(words).includes('printenv') || printsEnvironment(words))
      return deny('secret.read', 'the environment of a session holds its login and is never printed');
  }
  if (policy.role === 'reviewer' || policy.role === 'reader') {
    const rule = `${policy.role}.edit`;
    if (EDIT_TOOLS.has(request.tool)) return deny(rule, `a ${policy.role} reads and runs the checks; it does not edit`);
    for (const words of commands) {
      const sub = gitCommand(words)?.rest[0];
      if (sub === 'commit' || sub === 'push') return deny(rule, `a ${policy.role} does not run git ${sub}`);
    }
  }
  if (policy.role === 'author' && policy.planning === true) {
    const why = 'until its session plan has its Go, the session reads and runs the checks, and changes nothing but HANDOVER.md';
    if (EDIT_TOOLS.has(request.tool) && !isHandover(request, policy)) return deny('plan.before_go', why);
    for (const words of commands) {
      const sub = gitCommand(words)?.rest[0];
      if (sub === 'commit' || sub === 'push' || sub === 'add' || sub === 'checkout' || commandWords(words).includes('rm')) return deny('plan.before_go', why);
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

// An edit of HANDOVER.md at the root of the workdir.
function isHandover(request: ToolRequest, policy: Policy): boolean {
  const path = request.input.file_path ?? request.input.notebook_path;
  return typeof path === 'string' && inside(policy.workdir, path) && relative(policy.workdir, path) === 'HANDOVER.md';
}

function allowedEdit(request: ToolRequest, policy: Policy, context: PolicyContext): Verdict | undefined {
  const path = request.input.file_path ?? request.input.notebook_path;
  if (typeof path !== 'string' || !inside(policy.workdir, path)) return undefined;
  const parts = relative(policy.workdir, path).split('/');
  // Generated (CLAUDE.md), locked (.claude/, and .cursor/, where the Cursor
  // harness's permissions are written) or run by git on the host (.git/).
  if (parts.includes('.claude') || parts.includes('.cursor') || parts.includes('.git') || parts.at(-1) === 'CLAUDE.md') return undefined;
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

// The options a read may take, by program (review round 1 of pull request
// 240): an allowlist, never a list of the dangerous ones. `flags` are the
// short options without a value, `values` those with one (the rest of the
// group, or the next word); `long` names each long option whole, with
// whether it takes a value. GNU programs and git's parse-options take any
// unambiguous prefix of a long option (`wc --files0=` is `--files0-from=`),
// so a long option matches only by its whole name: an abbreviation asks.
// `--` ends the options. `digits`: the old count form, `head -20`.
type OptionSpec = {
  readonly flags: string;
  readonly values: string;
  readonly long: Readonly<Record<string, 'flag' | 'value' | 'optional'>>;
  readonly digits?: boolean;
};

const longs = (kind: 'flag' | 'value' | 'optional', names: string) => Object.fromEntries(names.split(' ').map((name) => [`--${name}`, kind]));

const READ_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  cat: { flags: 'AbeEnstTuv', values: '', long: longs('flag', 'show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting') },
  head: { flags: 'qvz', values: 'cn', digits: true, long: { ...longs('flag', 'quiet silent verbose zero-terminated'), ...longs('value', 'bytes lines') } },
  // No -f or -F: a tail that follows never ends.
  tail: { flags: 'qvz', values: 'cn', digits: true, long: { ...longs('flag', 'quiet silent verbose zero-terminated'), ...longs('value', 'bytes lines') } },
  ls: {
    flags: 'aAbBcCdfFgGhHiklLmnNopqQrRsStuUvxXZ1', values: 'ITw',
    long: {
      ...longs('flag', 'all almost-all author escape ignore-backups directory file-type full-time group-directories-first no-group human-readable si dereference-command-line dereference-command-line-symlink-to-dir inode kibibytes dereference numeric-uid-gid literal hide-control-chars show-control-chars quote-name reverse recursive size context zero'),
      ...longs('value', 'block-size format hide indicator-style ignore quoting-style sort time time-style tabsize width'),
      ...longs('optional', 'color classify hyperlink'),
    },
  },
  // No --files0-from: it reads the names of the files to count from a file.
  wc: { flags: 'cmlLw', values: '', long: { ...longs('flag', 'bytes chars lines max-line-length words'), ...longs('value', 'total') } },
  // No -f, --file or --exclude-from: they read a file.
  grep: {
    flags: 'abcEFGhHiIlLnoPqrRsTUvVwxyzZ', values: 'ABCDdem', digits: true,
    long: {
      ...longs('flag', 'extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case word-regexp line-regexp null-data no-messages invert-match count files-with-matches files-without-match only-matching quiet silent byte-offset line-number no-line-number line-buffered with-filename no-filename initial-tab null text recursive dereference-recursive'),
      ...longs('value', 'max-count label after-context before-context context binary-files devices directories include exclude exclude-dir regexp'),
      ...longs('optional', 'color colour'),
    },
  },
  // No --pre or --pre-glob (a program run on every file), --hostname-bin (a
  // program), -z or --search-zip (decompression programs), -f, --file or
  // --ignore-file (a file read). ripgrep takes no abbreviation of a long
  // option; the whole-name match holds whatever its version does.
  rg: {
    flags: 'acFHiIlLnNopqsSuUvwx0bPV', values: 'ABCeEgjmMrtT',
    long: {
      ...longs('flag', 'files type-list count count-matches files-with-matches files-without-match fixed-strings hidden no-hidden ignore-case smart-case case-sensitive line-number no-line-number no-heading heading no-ignore no-ignore-vcs no-ignore-parent no-ignore-dot no-ignore-global no-ignore-exclude no-ignore-files word-regexp line-regexp invert-match only-matching json vimgrep stats multiline multiline-dotall pcre2 no-pcre2 null null-data trim quiet text binary no-binary follow no-follow unrestricted column no-column no-filename with-filename passthru one-file-system no-messages crlf no-config byte-offset max-columns-preview no-require-git glob-case-insensitive line-buffered block-buffered no-unicode'),
      ...longs('value', 'after-context before-context context context-separator glob iglob max-count max-columns max-depth max-filesize type type-not regexp replace color colors sort sortr encoding threads engine path-separator'),
    },
  },
  // git's own parse-options takes abbreviations too.
  'git merge-base': { flags: 'a', values: '', long: longs('flag', 'all octopus independent is-ancestor fork-point') },
  'git rev-parse': {
    flags: 'q', values: '',
    long: {
      ...longs('flag', 'verify quiet show-toplevel show-prefix show-cdup git-dir absolute-git-dir git-common-dir is-inside-work-tree is-inside-git-dir is-bare-repository symbolic symbolic-full-name revs-only no-revs flags no-flags all'),
      ...longs('optional', 'abbrev-ref short branches tags remotes'),
    },
  },
};

// The operands of a command under its spec, and the options that named a
// value; undefined when a word is an option the spec does not have.
function readOptions(args: readonly string[], spec: OptionSpec): { operands: string[]; named: string[] } | undefined {
  const operands: string[] = [];
  const named: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!word.startsWith('-') || word === '-') {
      operands.push(word);
    } else if (word.startsWith('--')) {
      const [name = '', value] = word.split(/=(.*)/s);
      const kind = spec.long[name];
      if (kind === undefined || (kind === 'flag' && value !== undefined)) return undefined;
      if (kind === 'value' && value === undefined && ++i >= args.length) return undefined;
      named.push(name);
    } else if (!(spec.digits === true && /^-[0-9]+$/.test(word))) {
      for (let at = 1; at < word.length; at++) {
        const letter = word[at] as string;
        if (spec.flags.includes(letter)) continue;
        if (!spec.values.includes(letter)) return undefined;
        named.push(`-${letter}`);
        if (at === word.length - 1 && ++i >= args.length) return undefined;
        break;
      }
    }
  }
  return { operands, named };
}

// find's start points, then its expression, word by word: the tests and the
// actions that only print. Not -exec, -execdir, -ok, -okdir, -delete,
// -fprint*, -fls (they run or write), nor -files0-from (start points read
// from a file). find takes no abbreviation of a primary.
const FIND_ALONE = new Set(['-print', '-print0', '-ls', '-prune', '-quit', '-empty', '-true', '-false', '-readable', '-writable', '-executable', '-nouser', '-nogroup', '-depth', '-mount', '-xdev', '-noleaf', '-follow', '-daystart', '-ignore_readdir_race', '-noignore_readdir_race', '-not', '-and', '-a', '-or', '-o', '(', ')', '!', ',']);
const FIND_VALUE = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-perm', '-user', '-group', '-uid', '-gid', '-links', '-inum', '-maxdepth', '-mindepth', '-regextype', '-printf', '-used', '-fstype']);
const FIND_PATH = new Set(['-newer', '-anewer', '-cnewer', '-samefile']);

function findUnsafe(args: readonly string[], policy: Policy): boolean {
  let i = 0;
  while (args[i] === '-H' || args[i] === '-L' || args[i] === '-P') i++;
  for (; i < args.length && !(args[i] as string).startsWith('-') && !['(', ')', '!', ','].includes(args[i] as string); i++)
    if (!inside(policy.workdir, args[i] as string)) return true;
  for (; i < args.length; i++) {
    const word = args[i] as string;
    if (FIND_ALONE.has(word)) continue;
    if (!FIND_VALUE.has(word) && !FIND_PATH.has(word)) return true;
    const value = args[++i];
    if (value === undefined || (FIND_PATH.has(word) && !inside(policy.workdir, value))) return true;
  }
  return false;
}

// Long options of git log, show and diff that write a file, read one or run
// a program: refused with every prefix of their name too, although those
// commands refuse an abbreviation (git 2.47, checked by the lane).
const GIT_UNSAFE_LONG = ['--output', '--output-indicator-new', '--no-index', '--ext-diff', '--orderfile'];

// Words of a safe command that would make it write, run or reach outside.
function unsafeWords(words: readonly string[], policy: Policy): boolean {
  const [program = ''] = words;
  const args = words.slice(1);
  if (program === 'git') {
    const git = gitCommand(words);
    if (!git || git.risky) return true;
    const [sub = '', ...rest] = git.rest;
    const spec = READ_OPTIONS[`git ${sub}`];
    if (spec) {
      const read = readOptions(rest, spec);
      return !read || read.operands.some((path) => !inside(policy.workdir, path));
    }
    const { options, operands } = gitArguments(sub, rest);
    // A file read through git: a path outside the workdir (git diff reads
    // two paths without --no-index when one is outside), a message file.
    if (operands.some((path) => !inside(policy.workdir, path))) return true;
    if (sub === 'commit' && options.some((word) => /^--(?:file|template|reuse-message|reedit-message)(?:=|$)/.test(word) || /^-[A-Za-z]*[FtCc]/.test(word))) return true;
    return options.some((word) => {
      const name = word.split('=')[0] as string;
      return (name.length > 2 && GIT_UNSAFE_LONG.some((unsafe) => unsafe.startsWith(name))) || name.startsWith('--output') || word === '-o' || word.startsWith('-O') ||
        ((word.startsWith('--format') || word.startsWith('--pretty')) && /%\(|%x/.test(word));
    });
  }
  if (program === 'find') return findUnsafe(args, policy);
  const spec = READ_OPTIONS[program];
  if (!spec) return false;
  const read = readOptions(args, spec);
  if (!read) return true;
  // grep and rg: the first operand is the pattern, unless -e or --regexp
  // named one, or rg --files looks for none.
  const searches = program === 'grep' || program === 'rg';
  const patternNamed = read.named.some((option) => option === '-e' || option === '--regexp' || option === '--files');
  const paths = searches && !patternNamed ? read.operands.slice(1) : read.operands;
  return paths.some((path) => !inside(policy.workdir, path));
}

const folded = (words: readonly string[]) => (words[0] === 'git' ? ['git', ...(gitCommand(words)?.rest ?? [])] : words);

// A command one of the patterns matches, with none of its unsafe words.
function matches(words: readonly string[], patterns: readonly string[], policy: Policy): boolean {
  const command = folded(words);
  return patterns.some((pattern) => globWords(splitPattern(pattern), command)) && !unsafeWords(words, policy);
}

function safeCommand(words: readonly string[], policy: Policy): boolean {
  const [program, run, script, rest] = folded(words);
  if (program === 'npm' && run === 'run' && script !== undefined && policy.scripts.includes(script) && (rest === undefined || rest === '--')) return true;
  return matches(words, policy.safeCommands, policy);
}

// An author deletes a file its ticket changed without asking (milestone 2,
// decision 11): plain `rm`, with `-f` at most, every operand inside the
// workdir and in ticketFiles, which the service fills from the edits the
// ticket's sessions made. A recursive or any other option, an operand the
// ticket did not change, or another role falls to the asks below.
function ticketDeletion(words: readonly string[], policy: Policy): boolean {
  if (policy.role !== 'author' || words[0] !== 'rm') return false;
  const operands: string[] = [];
  let options = true;
  for (const word of words.slice(1)) {
    if (options && word === '--') { options = false; continue; }
    if (options && word.startsWith('-')) {
      if (word === '-f' || word === '--force') continue;
      return false;
    }
    operands.push(word);
  }
  return operands.length > 0 && operands.every((path) => inside(policy.workdir, path) && policy.ticketFiles.includes(relative(policy.workdir, path)));
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

// ---------------------------------------------------------------- compound

const GENERIC = 'default';

// One part of a list: its command, then each file it writes, which must be
// one an Edit may write without asking. A deny of either wins; else the
// first ask, with its own rule when it has one.
function part(request: ToolRequest, command: SimpleCommand, policy: Policy, context: PolicyContext): Verdict {
  const verdict = simple(request, command.words, policy);
  let asked: Verdict | undefined =
    verdict.decision !== 'ask' ? undefined : verdict.rule === GENERIC ? ask('shell.compound', `${command.words.join(' ')} is not a command the policy allows on its own`) : verdict;
  for (const target of command.writes) {
    const edit = evaluate({ tool: 'Write', input: { file_path: target } }, policy, context);
    if (edit.decision === 'allow' && edit.rule === 'edit.workdir') continue;
    if (edit.decision === 'deny') return edit;
    asked ??= edit.decision === 'ask' && edit.rule !== GENERIC
      ? ask(edit.rule, `the redirection to ${target}: ${edit.reason}`)
      : ask('shell.compound', `the redirection writes ${target}, which an edit could not write without asking`);
  }
  return asked ?? allow('shell.compound_safe');
}

// A list of simple commands, split part by part (owner decision of
// 2026-10-22 22:03): allowed when every part is; denied when any part is,
// wherever it stands, so that an "Allow once" given to an earlier part never
// runs a later one the policy denies; else it asks for the parts that ask
// and names them, and only them, with the rule of the first.
function compound(request: ToolRequest, command: string, policy: Policy, context: PolicyContext): Verdict {
  const list = parseList(command);
  if (!list) return ask('shell.compound', 'shell syntax the policy does not read word for word');
  const asks: { readonly words: readonly string[]; readonly verdict: Extract<Verdict, { decision: 'ask' }> }[] = [];
  for (const command of list) {
    const verdict = part(request, command, policy, context);
    if (verdict.decision === 'deny') return verdict;
    if (verdict.decision === 'ask') asks.push({ words: command.words, verdict });
  }
  const [first] = asks;
  if (!first) return allow('shell.compound_safe');
  if (asks.length === 1) return first.verdict;
  const reasons = asks.map(({ words, verdict }) => (verdict.reason.startsWith(words.join(' ')) ? verdict.reason : `${words.join(' ')}: ${verdict.reason}`));
  return ask(first.verdict.rule, `${asks.length} parts of this command ask, the others are allowed: ${reasons.join('; ')}`);
}

// ---------------------------------------------------------------- lead

// The longest Read, and the longest head, the lead may ask for: one answer
// stays far below the distance between the handover point and the
// threshold (milestone 2 plan, section 4.1).
export const LEAD_READ_LINES = 400;

const LEAD_GIT_READS = ['git log *', 'git show *', 'git diff *', 'git status', 'git branch --show-current'].map(splitPattern);
const LEAD_DELEGATES = new Set(['WebFetch', 'WebSearch', 'Agent', 'Task']);

// `head -n N` or `head -nN` with N from 1 to LEAD_READ_LINES, and the files
// it reads; undefined for any other head.
function capped(words: readonly string[]): readonly string[] | undefined {
  if (words[0] !== 'head') return undefined;
  const option = words[1] === '-n' ? words[2] : words[1]?.startsWith('-n') ? words[1].slice(2) : undefined;
  if (option === undefined || !/^[1-9][0-9]*$/.test(option) || Number(option) > LEAD_READ_LINES) return undefined;
  return words.slice(words[1] === '-n' ? 3 : 2);
}

// The lead's shell reads: a git read alone or piped into head, ls, grep or
// find piped into head, or head itself reading one file, all under the
// workdir and under milestone 1's conditions on their words. A head takes
// its one count and nothing else: a second count, a byte count or several
// files would lift the cap.
function leadRead(command: string, policy: Policy): boolean {
  const list = parseList(command);
  if (!list || list.length > 2 || list.some((part) => part.redirected)) return false;
  const [first, pipe] = list as [SimpleCommand, SimpleCommand | undefined];
  if (pipe && (pipe.after !== '|' || capped(pipe.words)?.length !== 0)) return false;
  const words = first.words;
  if (words[0] === 'git') {
    const git = gitCommand(words);
    return !!git && !git.risky && LEAD_GIT_READS.some((pattern) => globWords(pattern, ['git', ...git.rest])) && !unsafeWords(words, policy);
  }
  if (words[0] === 'head') {
    const files = capped(words);
    return files?.length === 1 && !(files[0] as string).startsWith('-') && !unsafeWords(words, policy);
  }
  return pipe !== undefined && (words[0] === 'ls' || words[0] === 'grep' || words[0] === 'find') && !unsafeWords(words, policy);
}

// Section 3.3 of the milestone 2 plan, for the lead only: what is not
// decided here goes on to the role-free rows.
function leadRows(request: ToolRequest, policy: Policy): Verdict | undefined {
  const { tool, input } = request;
  if (tool.startsWith('mcp__cleared__')) return allow('lead.tools');
  if (tool === 'Read') {
    const limit = input.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LEAD_READ_LINES)
      return deny('lead.read_cap', `read with a limit of at most ${LEAD_READ_LINES} lines (the limit parameter), and an offset for the next part`);
    return allowedRead(request, policy);
  }
  if (tool === 'Glob' || tool === 'Grep') return allowedRead(request, policy);
  if (EDIT_TOOLS.has(tool)) return deny('lead.edit', 'the lead edits nothing: a change is a ticket of a plan');
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (leadRead(command, policy)) return allow('lead.git_read');
    for (const words of looseCommands(command)) {
      const sub = gitCommand(words)?.rest[0];
      if (sub === 'commit' || sub === 'push' || sub === 'checkout' || sub === 'add') return deny('lead.edit', `the lead does not run git ${sub}: a change is a ticket of a plan`);
    }
    return deny('lead.command', `the lead runs nothing: it reads with git log, show, diff and status, and with ls, grep and find piped into head -n ${LEAD_READ_LINES} at most`);
  }
  if (LEAD_DELEGATES.has(tool)) return deny('lead.command', 'the lead reaches no network and starts no agent: it gives the work to a ticket');
  return undefined;
}

// ---------------------------------------------------------------- evaluate

// The longest Read a reader may ask for, as the lead's: an answer about the
// code reads it in parts.
export const READER_READ_LINES = LEAD_READ_LINES;

// A reader (decision 28): its own rows, then the rows every role has, with
// no learned answer; an ask becomes a refusal that keeps its reason.
function readerVerdict(request: ToolRequest, policy: Policy, context: PolicyContext): Verdict {
  const refused = denied(request, policy);
  if (refused) return refused;
  if (request.tool === 'AskUserQuestion') return deny('reader.question', 'nobody answers a reader\'s questions: answer from what the code shows, and say what it does not');
  const limit = request.input.limit;
  if (request.tool === 'Read' && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > READER_READ_LINES))
    return deny('reader.read_cap', `read with a limit of at most ${READER_READ_LINES} lines (the limit parameter), and an offset for the next part`);
  const verdict = rules(request, { ...policy, learned: [] }, context);
  return verdict.decision === 'ask' ? deny('reader.ask', `a reader reads only and waits for nobody: ${verdict.reason}`) : verdict;
}

export function evaluate(request: ToolRequest, policy: Policy, context: PolicyContext = {}): Verdict {
  if (policy.role === 'reader') return readerVerdict(request, policy, context);
  return rules(request, policy, context);
}

function rules(request: ToolRequest, policy: Policy, context: PolicyContext): Verdict {
  const refused = denied(request, policy);
  if (refused) return refused;

  if (policy.role === 'lead') {
    const lead = leadRows(request, policy);
    if (lead) return lead;
  }

  let words: readonly string[] | undefined;
  if (request.tool === 'Bash') {
    const command = typeof request.input.command === 'string' ? request.input.command : undefined;
    words = command === undefined ? undefined : parseCommand(command);
    if (!words) return command === undefined ? ask('shell.compound', 'a command the policy cannot read') : compound(request, command, policy, context);
  }

  if (READ_TOOLS.has(request.tool)) {
    const read = allowedRead(request, policy);
    if (read) return read;
  }
  if (EDIT_TOOLS.has(request.tool)) {
    const edit = allowedEdit(request, policy, context);
    if (edit) return edit;
  }
  if (words) return simple(request, words, policy);
  if (learned(request, undefined, policy)) return allow('learned');

  return asked(request, undefined, policy);
}

// The verdict of one simple command, after the deny rules.
function simple(request: ToolRequest, words: readonly string[], policy: Policy): Verdict {
  if (safeCommand(words, policy)) return allow('run.safe');
  if (policy.role === 'reviewer' && matches(words, REVIEWER_READS, policy)) return allow('reviewer.read');
  if (learned(request, words, policy)) return allow('learned');
  if (ticketDeletion(words, policy)) return allow('delete.ticket');
  return asked(request, words, policy);
}
