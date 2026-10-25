// The audit of O23 (lane j2-i18n-audit): the code of app/web is read, not
// run. Every component, model and library is parsed (test/audit/scan.ts) and
// the test fails on:
//   - a word a person reads (JSX text, a visible attribute such as
//     aria-label, title, placeholder, alt or data-tip, a label or a message
//     of a plain object, a Notification's title) that is not a catalog key;
//   - a number, a duration or a date that is drawn without lib/time.ts
//     (toFixed, toLocale*String without the page's language, new Intl.*,
//     hand-built clocks);
//   - a key the code names (a literal, both branches of a conditional, the
//     entries of a table of keys, the result of a function that picks one)
//     that is missing from the English or the French file of the catalog the
//     file draws with, or a key built from a prefix that no key matches;
//   - a key chosen by the run that this file has not justified;
//   - a French sentence that is the English one and is not a justified
//     cognate or proper name.
// The justified exceptions are the lists below, each with its reason. The
// renderings of test/i18n.test.tsx remain the check of what a screen draws on
// the data (a status in the service's English, a mark ⟦key⟧).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, MESSAGES_DIR, SCREENS, type Language, type Screen } from '../../src/catalog.ts';
import { scan, type Finding, type Scan } from './audit/scan.ts';

const WEB = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ['test', 'styles', 'node_modules'].includes(name) ? [] : walk(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const files = walk(WEB).map((path) => relative(WEB, path).split(sep).join('/')).sort();
const scans = new Map<string, Scan>(files.map((file) => [file, scan(file, readFileSync(join(WEB, file), 'utf8'))] as const));

const read = (screen: Screen, language: Language): Record<string, string> => JSON.parse(readFileSync(join(MESSAGES_DIR, `${screen}.${language}.json`), 'utf8')) as Record<string, string>;
const RAW: Record<Language, Record<Screen, Record<string, string>>> = {
  en: Object.fromEntries(SCREENS.map((screen) => [screen, read(screen, 'en')])) as Record<Screen, Record<string, string>> as never,
  fr: Object.fromEntries(SCREENS.map((screen) => [screen, read(screen, 'fr')])) as Record<Screen, Record<string, string>> as never,
};

// ---- the justified exceptions ------------------------------------------------------

interface Exception { readonly file: string; readonly text: string; readonly why: string }

// Text that is not a word a person reads in the app's language.
const WORDS: readonly Exception[] = [
  { file: 'shell/Sidebar.tsx', text: 'K', why: "the letter of the palette's shortcut (Ctrl+K, ⌘K), the same in both languages, drawn in a keycap" },
  { file: 'screens/lead/agent.ts', text: "The lead's thread, its state and its plans, from the service", why: "the description of an AG-UI agent the code reads (CopilotKit's registry); it is never drawn" },
  { file: 'screens/session/agent.ts', text: "The session's timeline, from the service's stream", why: "the description of an AG-UI agent the code reads (CopilotKit's registry); it is never drawn" },
];

// Numbers, durations and dates drawn without lib/time.ts, and why that is right.
const FORMATS: readonly Exception[] = [
  { file: 'screens/consumption/Consumption.tsx', text: 'cost.total', why: "a string already said by dollars() in the page's language" },
  { file: 'screens/tower/model.ts', text: 'costUsd.toFixed(2)', why: "the plan card carries the cost as a string of the card's values; planDetail reads it back with Number() and says it through decimal() in the page's language" },
  { file: 'components/editor/model.ts', text: "byte.toString(16).padStart(2, '0')", why: 'the hexadecimal digest of a file, an id and not a number a person reads' },
  { file: 'screens/lead/model.ts', text: 'at.toDateString()', why: 'compares two days to know where the thread changes day; the day itself is said by the page through Date.toLocaleDateString in its language' },
  { file: 'screens/lead/model.ts', text: 'now.toDateString()', why: 'same comparison' },
];

// A translator's argument only a run can tell, with where it resolves.
const FAILURE = 'a key returned by failure(), gestureFailure() or a model function, checked where it is written (the `key:` properties of the models)';
const DYNAMIC: readonly Exception[] = [
  { file: 'lib/request.ts', text: 'key', why: 'joined() forwards the key its caller named (request_then, request_then_ask), both literals of the same file' },
  { file: 'lib/request.ts', text: 'k', why: 'the same forwarding translator' },
  { file: 'lib/request.ts', text: 'only.key', why: "a Special's key, a literal of the intent table in lib/intent.ts (intent_*), whose prefix the audit checks" },
  { file: 'lib/status.ts', text: 'key', why: "the key column of TOOL_PHRASES, four literals (status_reading, status_editing, status_searching, status_running) in the same file" },
  { file: 'screens/inbox/Inbox.tsx', text: 'act', why: "an Answer: allow_once and allow_always are keys of the inbox catalog, reject_once is said through 'deny' on the line above" },
  { file: 'screens/inbox/Inbox.tsx', text: 'openKey', why: "Eyebrow's openKey is a literal at each of its five call sites (open_session, open_sessions, open_plan...)" },
  { file: 'screens/inbox/Inbox.tsx', text: 'side', why: "'before' or 'after', two keys of the inbox catalog" },
  { file: 'screens/inbox/Inbox.tsx', text: 'name', why: "an Answer, as for act" },
  { file: 'screens/inbox/Inbox.tsx', text: 'key', why: FAILURE },
  { file: 'screens/inbox/Inbox.tsx', text: 'after', why: "afterPlanRefusal() returns 'approve_plan_conflict' or the key it was given" },
  { file: 'screens/session/Session.tsx', text: 'failure', why: 'the failure key a caller passes to the gesture helper, a literal at each call site' },
  { file: 'screens/session/model.ts', text: 'key', why: "known(): a key that may not exist, tried with the translator, which marks it rather than throwing" },
  { file: 'screens/tower/model.ts', text: 'key', why: "planDetail's key is built a line above from literals, plan_proposes_{cost,week}_{one,other}, four keys of the tower catalog" },
  { file: 'shell/NotifyButton.tsx', text: 'view.state', why: "NotifyView.state is notify_on, notify_off or notify_unavailable, all keys of the shell catalog (shell/notify.ts)" },
  { file: 'shell/NotifyButton.tsx', text: 'failed', why: "toggleNotify() returns a notify_* key or nothing" },
];

// A French sentence equal to the English one, by the reason it is.
const SAME_IN_BOTH: ReadonlyMap<string, string> = new Map(Object.entries({
  // A name: the product's, a harness's or a maker's, said as it is in both languages.
  names: 'shell.app_name shell.language_en shell.language_fr session.open_editor_vscode session.open_editor_cursor consumption.consumption_harness_claude-code consumption.consumption_harness_codex consumption.consumption_maker_claude-code consumption.consumption_maker_codex consumption.consumption_harness_cursor inbox.variant_harness_claude-code inbox.variant_harness_codex inbox.variant_harness_cursor',
  // The owner\'s word of 2026-10-23, 08:40: "Lead" stays "Lead" in French.
  lead: 'tower.need_lead tower.role_lead tower.lead_title session.role_lead inbox.lead_label inbox.lead_line inbox.session_lead_plain lead.lead_heading',
  // A word French spells as English does (Session, Plan, Question, Ticket, Terminal, Service, Notifications, Shell, Tokens, Agent, Bug).
  shared_word: 'tower.template_bug tower.template_question shell.title_session shell.nav_sessions shell.title_lead shell.nav_plans shell.notify_label shell.palette_sessions tower.plans_title tower.services_title tower.kind_question tower.kind_plan session.ticket_label session.verb_think session.index_title session.tabs_plan session.tabs_terminal session.terminal_switch_shell session.ticket_step_service inbox.kind_question inbox.eyebrow_question inbox.facts_sessions inbox.facts_session inbox.kind_plan inbox.facts_tickets inbox.services_label inbox.plan_step_service lead.services_label lead.plan_step_service consumption.consumption_wins_agent consumption.consumption_wins_type consumption.consumption_type_bug consumption.consumption_type_question',
  // A template whose only words are shared ones, or a unit or a key cap both languages write alike.
  shared_template: 'shell.time_minutes shell.key_cap_ctrl tower.need_question tower.need_plan inbox.list_plan_one inbox.list_plan_other inbox.tickets_one inbox.tickets_other inbox.train_ticket',
}).flatMap(([why, ids]) => ids.split(' ').map((id) => [id, why] as const)));

// ---- the catalogs a file draws with ------------------------------------------------

// A screen's file draws with its catalog over the shell's, the shell's files
// with the shell's. A component, a model or a library draws with the catalog
// of every screen that imports it, directly or through another file: its
// keys must be in each of those, or in the shell's.
const screenOf = (file: string): Screen | undefined => {
  const match = /^screens\/([a-z]+)\//.exec(file);
  return match && (SCREENS as readonly string[]).includes(match[1] as string) ? (match[1] as Screen) : undefined;
};

// The shortcut sheet lists the keys of every screen, and says each in the catalog of the screen it opens on.
const SHEET_FILES: ReadonlySet<string> = new Set(['shell/keys.ts', 'shell/Shortcuts.tsx']);

const importersOf = new Map<string, Set<string>>();
for (const file of files) {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  for (const [, spec] of readFileSync(join(WEB, file), 'utf8').matchAll(/(?:from|import\()\s*'((?:\.|@\/)[^']*)'/g)) {
    const target = (spec as string).startsWith('@/') ? (spec as string).slice(2) : join(dir, spec as string).split(sep).join('/');
    if (!importersOf.has(target)) importersOf.set(target, new Set());
    importersOf.get(target)?.add(file);
  }
}

// The lists of catalogs a file draws with: one per screen that reaches it.
function contexts(file: string, seen = new Set<string>()): Screen[][] {
  const own = screenOf(file);
  if (own) return [['shell', own]];
  if (SHEET_FILES.has(file)) return [['shell', ...SCREENS.filter((screen) => screen !== 'shell')]];
  // The shell draws its own files (the sidebar, the palette) with the tower's catalog over its own (App.tsx, towerT).
  if (file.startsWith('shell/')) return [['shell', 'tower']];
  if (seen.has(file)) return [];
  seen.add(file);
  const via = [...(importersOf.get(file) ?? [])].filter((importer) => importer !== 'lib/router.tsx').flatMap((importer) => contexts(importer, seen));
  const unique = new Map(via.map((list) => [list.join('/'), list] as const));
  return unique.size === 0 ? [['shell']] : [...unique.values()];
}

const has = (language: Language, screens: readonly Screen[], key: string): boolean => screens.some((screen) => Object.hasOwn(RAW[language][screen], key));

// ---- the scanner itself, on snippets -----------------------------------------------

test('the reader finds a word, a visible attribute, a label and a bare number in a snippet, and leaves a catalog call alone', () => {
  const found = (code: string, name = 'x.tsx') => scan(name, code).findings.map((f) => `${f.rule}:${f.text}`);
  assert.deepEqual(found('const A = () => <p>Hello there</p>;'), ['jsx-text:Hello there']);
  assert.deepEqual(found("const A = ({ t }: any) => <p title=\"Close\" aria-label={ok ? 'Yes' : t('no')}>{t('hello')}</p>;"), ['attribute:title:Close', 'attribute:aria-label:Yes']);
  assert.deepEqual(found("const A = (p: any) => <p>{p.open ? 'Open' : null}{`${p.n} items`}</p>;"), ['jsx-child-literal:Open', 'jsx-child-literal:items']);
  assert.deepEqual(found("export const ITEMS = [{ label: 'Settings', title: 'nav_title' }];", 'x.ts'), ['property:label:Settings']);
  assert.deepEqual(found("const a = (n: number) => n.toFixed(2) + new Date().toLocaleDateString() + new Date().toLocaleDateString(language) + new Intl.NumberFormat('fr').format(n);", 'x.ts'), ['formatter:toFixed:n.toFixed(2)', 'formatter:toLocaleDateString:new Date().toLocaleDateString()', 'formatter:intl:new Intl.NumberFormat']);
  assert.deepEqual(found('const A = () => <p className="x">{" "}·{3}<b>12:30</b></p>;'), []);
  assert.deepEqual(scan('x.tsx', "const f = (t: any, k: string, a: boolean) => [t('one'), t(a ? 'two' : `p_${k}`), t(k)];").keys.map((k) => k.key), ['one', 'two']);
});

// ---- the audit ---------------------------------------------------------------------

const pretty = (f: Finding) => `${f.file}:${f.line} ${f.rule} "${f.text}"`;
const excused = (list: readonly Exception[], f: Finding) => list.some((e) => e.file === f.file && e.text === f.text);

test('no component writes a visible word of its own: every text a person reads comes from a catalog', () => {
  const words = [...scans.values()].flatMap((s) => s.findings).filter((f) => !f.rule.startsWith('formatter:') && !excused(WORDS, f));
  assert.deepEqual(words.map(pretty), []);
});

test('the exceptions to the words are real: each one still matches a place in the code', () => {
  const all = [...scans.values()].flatMap((s) => s.findings);
  for (const e of WORDS) assert.ok(all.some((f) => f.file === e.file && f.text === e.text), `${e.file}: "${e.text}" is no longer in the code, drop its exception`);
});

test('durations, dates and numbers are drawn through lib/time.ts and Intl in the page\'s language, never by hand', () => {
  const hand = [...scans.values()].flatMap((s) => s.findings).filter((f) => f.rule.startsWith('formatter:') && f.file !== 'lib/time.ts' && !excused(FORMATS, f));
  assert.deepEqual(hand.map(pretty), []);
});

test('the exceptions to the formatter are real: each one still matches a place in the code', () => {
  const all = [...scans.values()].flatMap((s) => s.findings);
  for (const e of FORMATS) assert.ok(all.some((f) => f.file === e.file && f.text === e.text), `${e.file}: "${e.text}" is no longer in the code, drop its exception`);
});

test('every key the code names is in the English and the French file of the catalog its file draws with', () => {
  const missing: string[] = [];
  for (const [file, result] of scans) {
    for (const { line, key } of result.keys) {
      for (const screens of contexts(file)) {
        for (const language of LANGUAGES) if (!has(language, screens, key)) missing.push(`${file}:${line} names "${key}", which ${screens.join(' / ')}.${language}.json has not`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every key built from a prefix matches a key in both languages', () => {
  const missing: string[] = [];
  for (const [file, result] of scans) {
    for (const { line, prefix, suffix } of result.prefixes) {
      for (const screens of contexts(file)) for (const language of LANGUAGES) {
        const found = screens.some((screen) => Object.keys(RAW[language][screen]).some((key) => key.startsWith(prefix) && key.endsWith(suffix) && key.length > prefix.length + suffix.length));
        if (!found) missing.push(`${file}:${line} builds \`${prefix}…${suffix}\`, which no key of ${screens.join(' / ')}.${language}.json matches`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// A key kept as data (titleKey, an error, a table's entry) is a key or the
// start of a family of keys (plan_proposes, for plan_proposes_cost_one).
const KEYS_NOT_MESSAGES: readonly (Exception & { readonly key: string })[] = [
  { file: 'screens/inbox/model.ts', key: 'credential_shape', text: '', why: "flagKey names the flag in the catalog's words (flag_credential_shape), not a message: the guard reads a catalog key with 'secret' in it as an assigned secret" },
];

test('every key kept as data (a table, an error, a titleKey) is a key of its catalog or the start of a family of keys, in both languages', () => {
  const missing: string[] = [];
  for (const [file, result] of scans) {
    for (const { line, key } of result.loose) {
      if (KEYS_NOT_MESSAGES.some((e) => e.file === file && e.key === key)) continue;
      for (const screens of contexts(file)) for (const language of LANGUAGES) {
        const found = screens.some((screen) => Object.keys(RAW[language][screen]).some((k) => k === key || k.startsWith(`${key}_`)));
        if (!found) missing.push(`${file}:${line} keeps "${key}", which ${screens.join(' / ')}.${language}.json has neither as a key nor as the start of one`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// A key picked by a table (PHASE_KEY[phase]), by a function (closeFailureKey(status)) or
// by a property (card.titleKey, checked.error) is checked where the table, the
// function or the property is written; what is left is a variable only a
// run can tell, and each of those is justified above.
const resolved = (code: string) => /^[A-Za-z_]*(?:KEYS?|LABEL|SEND|PLACEHOLDER|FAILED)\[/.test(code) || /^[A-Za-z]*(?:Key|Failure)\(/.test(code)
  || /\.(?:\w*Key|label|error|note)$/.test(code);

test('a key only a run can tell is justified, and its justification is still true', () => {
  const open: string[] = [];
  for (const [file, result] of scans) {
    for (const { line, code } of result.dynamic) {
      if (!resolved(code) && !DYNAMIC.some((e) => e.file === file && e.text === code)) open.push(`${file}:${line} names \`${code}\``);
    }
  }
  assert.deepEqual(open, []);
  for (const e of DYNAMIC) assert.ok(scans.get(e.file)?.dynamic.some((d) => d.code === e.text), `${e.file}: \`${e.text}\` is no longer in the code, drop its exception`);
});

test('a French sentence is not the English one, but for the words and names both languages share', () => {
  const same: string[] = [];
  for (const screen of SCREENS) {
    for (const [key, en] of Object.entries(RAW.en[screen])) {
      const fr = RAW.fr[screen][key];
      if (fr === en && /\p{L}{3}/u.test(en.replace(/\{[a-z_]+\}/g, '')) && !SAME_IN_BOTH.has(`${screen}.${key}`)) same.push(`${screen}.fr.json ${key} = "${en}"`);
    }
  }
  assert.deepEqual(same, []);
  for (const id of SAME_IN_BOTH.keys()) {
    const [screen, ...rest] = id.split('.');
    assert.equal(RAW.fr[screen as Screen][rest.join('.')], RAW.en[screen as Screen][rest.join('.')], `${id} differs now, drop it from the list`);
  }
});
