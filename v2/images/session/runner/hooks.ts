// The SDK hooks of the session runner (milestone 1 plan, decision 13):
// Cleared's three rules, as in-process callbacks.
//   1. No push from the session: a `git push` (the base branch included) is
//      denied before it runs. The service pushes the ticket branch from the
//      host when the session is done (decision 12), and the base branch only
//      changes through the release lock.
//   2. The guard before anything leaves: a `gh pr create` is denied when the
//      guard's patterns find something in the lines a commit of the branch
//      adds, its commit messages or the command itself. The service's
//      publish step runs the repository's whole guard again on the host,
//      private terms included (src/workspace/publish.ts); this is the early
//      check, inside the container, where only this file is copied.
//   3. HANDOVER.md at the end: a turn that ends without it is sent back
//      once with the five headings lib/memory expects. Only an author is
//      asked: a reviewer cannot write the file and a lead hands over
//      through its host tool (issue 139), so hooksFor() leaves the Stop
//      hook out for both.
// The runner (main.ts) spreads hooksFor(<the session's role>) into the
// `hooks` option of query().
//
// The image copies this file alone (images/session/Dockerfile), so it
// imports Node built-ins only. The types mirror the shapes of
// @anthropic-ai/claude-agent-sdk 0.3.306 (sdk.d.ts: HookCallback,
// HookCallbackMatcher, HookEvent, PreToolUseHookInput, StopHookInput,
// SyncHookJSONOutput) without importing the package, which only the image
// installs.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

export type HookCallback = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

export type HookCallbackMatcher = {
  matcher?: string;
  hooks: HookCallback[];
  // Seconds, for every hook of this matcher.
  timeout?: number;
};

export type Hooks = Partial<Record<string, HookCallbackMatcher[]>>;

// lib/memory's headings (adapters/local.ts, HEADINGS), in its order: a
// handover without them is not stored. A test keeps them identical.
export const HANDOVER_HEADINGS = ['## Done', '## Tried and failed, and why', '## Left to do', '## Where the artifacts are (screenshots, logs, branches)', '## Open questions'] as const;

// The guard's patterns (lib/guard/codex-guard.ts), word for word, in its
// order: `always` and `envAssignments` (what it checks in a code file of a
// diff), then `directOnly` (what it adds for any other input). A test keeps
// them identical. The guard's private terms and its list of allowed
// fixture values need the project's lists, which only the host has.
export const GUARD_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['private key', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['IBAN', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@/'"`]+@/i],
  ['email address', /\b[a-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|exemple\.fr|[a-z0-9-]+\.(?:test|invalid|localhost|example))(?![a-z0-9-]|\.[a-z0-9]))[a-z0-9.-]+\.[a-z]{2,}/i],
  ['phone number', /(?<![\d.,])(?:(?:\+|00)33 ?[1-9]|0[1-9])(?:\d{8}|(?: \d{2}){4}|(?:\.\d{2}){4})(?![\d.,])/],
  ['literal secret', /(?:pass(?:word)?|secret|token|api[_-]?key|pepper)\w*["']?\s*[:=]\s*(?:"(?!\$)[^"\s]{8,}"|'[^'\s]{8,}'|`(?!\$)[^`\s]{8,}`)/i],
  ['assigned secret', /^\s*(?:export\s+)?(?=[A-Z])[A-Z0-9_]*(?:PASS(?:WORD)?|SECRET|TOKEN|API_?KEY|PEPPER)[A-Z0-9_]*=[^\s"'$(#]{8,}/],
  ['assigned secret', /(?:pass(?:word)?|secret|token|api[_-]?key|pepper)\w*["']?\s*[:=]\s*["'][^"']*\s[^"']*["']/i],
  ['assigned secret', /^\s*[\w-]*(?:pass(?:word)?|secret|token|api[_-]?key|pepper)[\w-]*\s*:\s*(?![$"'{[(]|process\.env)[^\s#]{8,}/i],
];
const CODE_PATTERNS = GUARD_PATTERNS.slice(0, 8);
const CODE_FILE = /\.(?:m?js|cjs|jsx|ts|tsx)$/;

// The base the ticket branch started from, set by the service in the
// ticket checkout (src/workspace/checkout.ts, BASE_REF).
const BASE_REF = 'refs/cleared/base';

export type Run = (command: string, args: readonly string[], cwd: string) => Promise<string>;

const runCommand: Run = async (command, args, cwd) => {
  const { stdout } = await promisify(execFile)(command, [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

// The simple commands of a shell text, as word lists: split on ; & | ( ) `
// $( and newlines, words split on blanks, quotes and backslashes honoured.
// Coarse on purpose: it only has to find `git push` and `gh pr create`,
// and a word that is itself a shell text (sh -c "...", eval "...") is read
// as one too.
export function shellCommands(text: string, depth = 0): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (c === '\n' || ';&|()`'.includes(c) || (c === '$' && text[i + 1] === '(')) endCommand();
    else if (/\s/.test(c) || c === '<' || c === '>') endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  if (depth < 2) for (const command of [...out]) for (const w of command) if (/[\s;&|`]|\$\(/.test(w)) out.push(...shellCommands(w, depth + 1));
  return out;
}

const program = (word: string) => word.slice(word.lastIndexOf('/') + 1);

// git's global options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--attr-source']);

function gitSubcommands(words: readonly string[]): string[] {
  const found: string[] = [];
  words.forEach((word, at) => {
    if (program(word) === 'git-push' || program(word) === 'git-send-pack') found.push('push');
    if (program(word) !== 'git') return;
    for (let i = at + 1; i < words.length; i++) {
      const w = words[i] as string;
      if (GIT_VALUE_OPTIONS.has(w)) i++;
      else if (!w.startsWith('-')) {
        found.push(w);
        return;
      }
    }
  });
  return found;
}

function createsPullRequest(words: readonly string[]): boolean {
  return words.some((word, at) => {
    if (program(word) !== 'gh') return false;
    const rest: string[] = [];
    for (let i = at + 1; i < words.length && rest.length < 2; i++) {
      const w = words[i] as string;
      if (w === '-R' || w === '--repo') i++;
      else if (!w.startsWith('-')) rest.push(w);
    }
    return rest[0] === 'pr' && rest[1] === 'create';
  });
}

// Where the guard's patterns match, as "<input> line <n>: <category>",
// never the value. A diff is read as the guard reads one: the added lines
// only, a code file with the patterns of a code file.
export function guardFindings(inputs: readonly { readonly name: string; readonly text: string; readonly diff?: boolean }[]): string[] {
  const findings: string[] = [];
  for (const input of inputs) {
    let file = '';
    input.text.split('\n').forEach((raw, index) => {
      let line = raw;
      let patterns = GUARD_PATTERNS;
      if (input.diff) {
        if (raw.startsWith('-')) return;
        if (raw.startsWith('+++ ')) file = raw.slice(4).replace(/^b\//, '');
        line = raw.replace(/^(@@ [^@]* @@).*/, '$1').replace(/^[+ ]/, '');
        if (CODE_FILE.test(file)) patterns = CODE_PATTERNS;
      }
      for (const [category, pattern] of patterns)
        if (new RegExp(pattern.source, pattern.flags).test(line)) findings.push(`${input.name} line ${index + 1}: ${category}`);
    });
  }
  return findings;
}

const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'];

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function createHooks(run: Run = runCommand): Hooks {
  const preToolUse: HookCallback = async (input) => {
    const { tool_name: tool, tool_input: toolInput, cwd } = input as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
    const command = tool === 'Bash' && typeof toolInput?.command === 'string' ? toolInput.command : undefined;
    if (command === undefined) return {};
    const commands = shellCommands(command);
    if (commands.some((words) => gitSubcommands(words).includes('push')))
      return deny('git push does not run in a session: Cleared pushes the ticket branch from the host when the session is done, and the base branch only changes through the release lock. Commit your work and stop.');
    if (!commands.some(createsPullRequest)) return {};
    let findings: string[];
    try {
      const where = typeof cwd === 'string' ? cwd : process.cwd();
      // Every commit's own diff: a secret added then removed is still in the history.
      const diff = await run('git', [...GIT_SAFE, 'log', '--patch', '-U0', '--no-ext-diff', '--no-textconv', '--no-color', '--format=', '--diff-merges=first-parent', `${BASE_REF}..HEAD`], where);
      const messages = await run('git', [...GIT_SAFE, 'log', '--format=%B', `${BASE_REF}..HEAD`], where);
      findings = guardFindings([{ name: 'diff', text: diff, diff: true }, { name: 'commit messages', text: messages }, { name: 'the command', text: command }]);
    } catch {
      return deny(`The guard could not read this branch's changes against ${BASE_REF}, so nothing leaves. Cleared opens the pull request from the host when the session is done.`);
    }
    if (findings.length)
      return deny(`The guard refuses what this pull request would carry (${findings.slice(0, 10).join('; ')}). Remove it from the branch, commit, and ask again.`);
    return {};
  };

  const stop: HookCallback = async (input) => {
    const { stop_hook_active: again, cwd } = input as { stop_hook_active?: unknown; cwd?: unknown };
    if (again === true) return {};
    if (typeof cwd === 'string' && existsSync(join(cwd, 'HANDOVER.md'))) return {};
    return {
      decision: 'block',
      reason: `Before you stop, write HANDOVER.md at the root of the checkout, even if the task failed or stopped, with these exact headings, in this order:\n${HANDOVER_HEADINGS.join('\n')}\nKeep it short and factual. Never commit it: Cleared stores it in the project's memory after the session.`,
    };
  };

  return {
    PreToolUse: [{ matcher: 'Bash', hooks: [preToolUse] }],
    Stop: [{ hooks: [stop] }],
  };
}

// The hooks of an author.
export const hooks: Hooks = createHooks();

// The hooks of a role: the Stop hook is an author's only.
export function hooksFor(role: string, run?: Run): Hooks {
  const all = run === undefined ? hooks : createHooks(run);
  if (role !== 'lead' && role !== 'reviewer') return all;
  const { Stop: _stop, ...rest } = all;
  return rest;
}
