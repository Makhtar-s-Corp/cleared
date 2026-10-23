// What a session's request asks, in the person's language: the inbox's
// item, the session thread's card, the tower's row and the palette say it
// alike (docs/v2/ui-overhaul-plan.md, 2.5.1 to 2.5.3 and U9, lane 37).
//
// A command is said by lib/intent.ts's sentence, with what that table does
// not read whole or reads too gently taken first: a command it cannot
// summarise (a write to a file, a substitution, a heredoc, a shell given a
// script) is "a compound command", and the shapes an approval must not
// understate say themselves (a force push, a script fetched and run, sudo,
// a recursive or absolute delete, rights, an edit in place). Those open the
// command's fold. The decision stays the service policy's: this is reading.
// The reason is said by the service's code, else the policy's own sentence
// is shown as written. Pure, so the tests run it under Node; the words are
// the shell catalog's, which every screen's translator holds.
import type { ReasonCode } from '../../../src/api/types.ts';
import type { Role } from '../../../src/session/contract.ts';
import type { ToolInput } from '../../../src/session/events.ts';
import type { Verdict } from '../../../src/session/policy.ts';
import type { Translate } from './i18n.ts';
import { commandParts, intentSentence, intentsOf, type CommandPart } from './intent.ts';

export type Request = { readonly input: ToolInput; readonly tool: string; readonly reasonCode?: ReasonCode | undefined };

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const RUNNERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'php']);
const FETCHERS = new Set(['curl', 'wget']);

// A shell or an interpreter given its script on the command line.
const SCRIPTED: Readonly<Record<string, RegExp>> = {
  sh: /^-[a-z]*c[a-z]*$/, bash: /^-[a-z]*c[a-z]*$/, zsh: /^-[a-z]*c[a-z]*$/, dash: /^-[a-z]*c[a-z]*$/, ksh: /^-[a-z]*c[a-z]*$/,
  python: /^-c$/, python3: /^-c$/, node: /^-(?:e|p|-eval|-print)$/, perl: /^-[a-z]*e$/i, ruby: /^-e$/,
};

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]|['"]$/g, ''));
const programOf = (words: readonly string[]): string => (words[0] ?? '').split('/').at(-1) ?? '';

// What the intent table cannot read whole: a write to a file (`>` or `>>` to
// anything but /dev/null), a substitution, a heredoc, a process substitution,
// eval or source, a script given on the command line, a pipe into a shell.
export function opaque(command: string): boolean {
  // Single quotes keep their text literal; double quotes still substitute.
  const live = command.replace(/'[^']*'/g, "''");
  if (/\$\(|`|<<|<\(|>\(/.test(live)) return true;
  const unquoted = live.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const match of unquoted.matchAll(/(?:^|[^<>&\d])\d?(>>?|&>)\s*([^\s;&|]+)/g)) if (!/^&\d$|^\/dev\/null$/.test(match[2] ?? '')) return true;
  return commandParts(command).some((part) => {
    const words = wordsOf(part.text);
    const program = programOf(words);
    if (program === 'eval' || program === 'source' || program === '.') return true;
    if (part.op === '|' && SHELLS.has(program)) return true;
    const flag = SCRIPTED[program];
    return flag !== undefined && words.slice(1).some((w) => flag.test(w));
  });
}

// A part an approval must say in its own words; `open`: its fold opens too.
type Special = { readonly key: string; readonly values?: Readonly<Record<string, string>>; readonly open: boolean; readonly inner?: string };

function special(part: CommandPart): Special | undefined {
  const words = wordsOf(part.text);
  const program = programOf(words);
  const args = words.slice(1);
  if (program === 'sudo' || program === 'doas') {
    const at = args.findIndex((w) => !w.startsWith('-'));
    return { key: 'intent_as_root', open: true, inner: at < 0 ? '' : args.slice(at).join(' ') };
  }
  if (program === 'git' && args.find((w) => !w.startsWith('-')) === 'push') {
    if (args.some((w) => w === '--delete' || w === '-d' || /^:/.test(w))) return { key: 'intent_push_delete', open: true };
    if (args.some((w) => /^(?:-f|--force(?:-with-lease)?(?:=.*)?|--mirror)$/.test(w) || /^\+/.test(w))) return { key: 'intent_force_push', open: true };
  }
  if (program === 'chmod' || program === 'chown' || program === 'chgrp') return { key: 'intent_permissions', open: args.some((w) => /^-[a-zA-Z]*R/.test(w)) };
  if ((program === 'sed' || program === 'perl') && args.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith('--in-place'))) return { key: 'intent_edit_files', open: false };
  if (program === 'rm' || program === 'rmdir' || program === 'unlink' || program === 'shred') {
    const flags = args.filter((w) => w.startsWith('-'));
    const paths = args.filter((w) => !w.startsWith('-'));
    const wide = flags.some((w) => /^-[a-zA-Z]*[rRf]|^--(?:recursive|force)$/.test(w)) || paths.some((p) => p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..') || /[*?]/.test(p));
    if (paths.length === 1) return { key: 'intent_delete_path', values: { path: paths[0] as string }, open: wide };
    return wide ? { key: 'intent_delete', open: true } : undefined;
  }
  return undefined;
}

// A script fetched and handed to a shell or an interpreter: `curl … | sh`.
const remoteScript = (parts: readonly CommandPart[]): boolean =>
  parts.some((part, index) => part.op === '|' && RUNNERS.has(programOf(wordsOf(part.text))) && parts.slice(0, index).some((p) => FETCHERS.has(programOf(wordsOf(p.text)))));

const capital = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const lower = (text: string) => text.charAt(0).toLocaleLowerCase() + text.slice(1);

// The words between two intents: "puis" in a title, "puis à" after
// "Autoriser … à" (French repeats the preposition), "and" in English.
type Join = 'request_then' | 'request_then_ask';
const joined = (t: Translate, key: Join): Translate => (k, values) => (k === 'intent_and' ? t(key) : t(k, values));

function commandSentence(command: string, tool: string, t: Translate, join: Join): string {
  const parts = commandParts(command);
  if (remoteScript(parts)) return capital(t('intent_remote_script'));
  if (opaque(command)) return capital(t('intent_opaque'));
  const specials = parts.map(special);
  const found = specials.filter((s): s is Special => s !== undefined);
  if (found.length > 0) {
    // One special part and nothing else that says something: its own words; else the fold says it all.
    const rest = parts.filter((_, index) => specials[index] === undefined).map((p) => p.text).join('; ');
    if (found.length > 1 || intentsOf(rest).length > 0) return capital(t('intent_opaque'));
    const only = found[0] as Special;
    if (only.key === 'intent_as_root') return t('intent_as_root', { intent: only.inner ? commandSentence(only.inner, tool, t, join) : t('intent_unknown', { name: 'sudo' }) });
    return capital(t(only.key, only.values ?? {}));
  }
  const intents = intentsOf(command);
  const first = intents[0];
  if (intents.length === 0 || (intents.length === 1 && first?.kind === 'unknown')) {
    // A command the table does not know is said by its first word ("Lancer docker"), never cut short.
    return capital(t('intent_unknown', { name: first?.name ?? (programOf(wordsOf(parts[0]?.text ?? '')) || tool) }));
  }
  return intentSentence(command, joined(t, join));
}

// The title: what the request means to do.
export function requestTitle(request: Request, t: Translate): string {
  const { input } = request;
  if (input.kind === 'execute') return commandSentence(input.command, request.tool, t, 'request_then');
  if (input.kind === 'read' || input.kind === 'edit' || input.kind === 'delete' || input.kind === 'move' || input.kind === 'search' || input.kind === 'fetch') return t(`intent_tool_${input.kind}`);
  return t('intent_tool_other', { tool: request.tool });
}

// The request asked of the person (Codex's "Allow … to …?"), naming who asks.
export function requestAsk(request: Request, role: Role | undefined, t: Translate): string {
  const sentence = request.input.kind === 'execute' ? commandSentence(request.input.command, request.tool, t, 'request_then_ask') : requestTitle(request, t);
  return t(`request_ask_${role ?? 'session'}`, { intent: lower(sentence) });
}

// What a tool acts on, as it shows in a fold.
export function targetOf(input: ToolInput): string {
  switch (input.kind) {
    case 'read': case 'edit': case 'delete': case 'move': return input.path;
    case 'execute': return input.command;
    case 'search': return input.pattern;
    case 'fetch': return input.target;
    default: return '';
  }
}

// The fold: the command one part per line, each after its operator (cut for
// display only: the policy decides on the whole), or the tool's target.
export function requestFold(input: ToolInput): CommandPart[] {
  if (input.kind === 'execute') return commandParts(input.command);
  const shown = targetOf(input);
  return shown ? [{ op: '', text: shown }] : [];
}

// The fold opens by itself when the command is what the person must read.
export function requestFoldOpen(request: Request): boolean {
  if (request.input.kind !== 'execute') return false;
  const { command } = request.input;
  const parts = commandParts(command);
  return request.reasonCode === 'compound' || opaque(command) || remoteScript(parts) || parts.some((part) => special(part)?.open === true);
}

// The codes said in the person's words; any other (unknown, or a code a
// later policy adds) shows the policy's sentence. Until the policy sends its
// codes, the rules whose meaning is one of them (session/policy.ts) give it.
const SAID: ReadonlySet<string> = new Set(['compound', 'not_allowed', 'network', 'dependency', 'outside_checkout']);
const RULE_CODES: Readonly<Record<string, ReasonCode>> = { 'install.package': 'dependency', network: 'network' };
const SUBCOMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'cargo', 'go', 'make', 'pip', 'pip3']);

// The command a "not allowed" names: the part the policy's sentence starts
// with (it names the part that asks), else the command's first part; said by
// its program and, for git, npm and the like, its subcommand.
function askingName(command: string, reason: string): string {
  const parts = commandParts(command);
  const part = parts.find((p) => reason.startsWith(p.text)) ?? parts.find((p) => reason.includes(p.text)) ?? parts[0];
  const words = wordsOf(part?.text ?? command);
  const program = words[0] ?? command;
  const sub = SUBCOMMANDS.has(program) ? words.slice(1).find((w) => !w.startsWith('-')) : undefined;
  return sub ? `${program} ${sub}` : program;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Why it asks: said in the person's language when the service gave a code
// the app knows, else the service's own sentence, as written.
export function requestReason(request: Request, suggestion: Verdict, t: Translate): { readonly said?: string; readonly raw?: string } {
  if (suggestion.decision !== 'ask') return {};
  const code = request.reasonCode ?? RULE_CODES[suggestion.rule];
  if (code && SAID.has(code)) {
    if (code !== 'not_allowed') return { said: t(`reason_${code}`) };
    return request.input.kind === 'execute' ? { said: t('reason_not_allowed', { name: askingName(request.input.command, suggestion.reason) }) } : { said: t('reason_not_allowed_plain') };
  }
  return suggestion.reason ? { raw: sentence(suggestion.reason) } : {};
}
