#!/usr/bin/env node
// The fast lane: a short circuit for a tiny change that cannot hurt, decided
// by written rules and never by a model (docs/fast-lane.md). Two moments:
//   - at opening, from the ticket: a label or a project the settings declare
//     fast ([fast_lane] labels, projects), set by the user himself (the
//     tracker's history says who), picks the light author;
//   - after the author's work, from what merging one exact commit would land
//     on the base, which is authoritative: every changed path in [fast_lane]
//     safe_paths and of a file type it takes (FILE_TYPES: prose, style
//     sheets, translations), at most max_lines changed lines, no migration, no
//     dependency file, no path of the engine or of security, and nothing but
//     plain text in the lines each file gains. Whatever cannot be read, or is
//     not plainly a small text change, takes the full circuit.
// The fast lane removes waits, never a gate: the full checks green, a review
// by another model and the human's agreement to the exact version all stay.
// The settings are the ones of the project's main checkout (lib/conf.ts),
// never those of the branch being judged; what is decided is kept in the
// lane record, in the state an agent cannot write, bound to one commit.
//
//   fast-lane.ts opening                       the ticket (tracker.ts issue JSON) on stdin: prints fast or full
//   fast-lane.ts decide <lane key> <commit>    the rules at that commit, kept in the lane record: prints fast or full
//   fast-lane.ts check <lane key> <commit>     the same, written nowhere (a rehearsal)
//   fast-lane.ts demote <lane key> <reason>    the ticket takes the full circuit for good (a team that asked a question)
//   fast-lane.ts targeted <lane key> <commit>  the targeted tests command for that commit, its words NUL-separated (exit 3: none)
//   fast-lane.ts tests-done <lane key> <commit> <exit code | skipped>
//   fast-lane.ts measure <ticket> <pr> <fast|full>   one ticket_measured event, once its pull request is merged
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCH_HOME, loadConf, projectDir, runAsCommand, section, stateDir } from './conf.ts';
import { checkoutReadEnv, gitFirstLine } from './git-checkout.ts';
import { addEvent, ledgerPath, openLedger } from './ledger.ts';

const list = (text) => String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const yes = (value) => ['yes', 'true'].includes(String(value ?? '').trim().toLowerCase());

// A path the rules can read: plain ASCII segments, none empty, none "." or
// "..", none beginning with "-" (a file name a test runner would take for an
// option) or with "@" (a file list for some runners). Anything else (a space,
// a backslash, an accent, a look-alike letter, a control character) is not
// judged: the full circuit.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._@+-]*$|^\.[A-Za-z0-9_][A-Za-z0-9._@+-]*$/;
export const pathFormOk = (path) => typeof path === 'string' && path.length > 0 && path.length <= 300
  && path.split('/').every((part) => SEGMENT.test(part) && part !== '.' && part !== '..');

// Never fast, whatever the settings say: Cleared's own settings and prompts,
// the forge's workflows, the agents' rules, git's own files.
const PROTECTED_SEGMENTS = new Set(['.cleared', '.github', '.claude', '.codex', '.husky', '.devcontainer', '.circleci', '.gitlab']);
const PROTECTED_NAMES = new Set(['claude.md', 'agents.md', 'codeowners', 'makefile', 'justfile', 'procfile']);
// The deployment's own files, in their usual variants (Dockerfile.web, compose.prod.yaml).
const PROTECTED_FORMS = [/^(?:docker|container)file(?:\..+)?$/, /^(?:docker-)?compose(?:\.[a-z0-9_-]+)*\.ya?ml$/, /\.dockerfile$/];
// A dependency is declared or pinned by these, wherever they are.
const DEPENDENCY_NAMES = new Set(['package.json', 'npm-shrinkwrap.json', 'pnpm-workspace.yaml', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs',
  '.nvmrc', '.node-version', '.tool-versions', 'pipfile', 'pyproject.toml', 'setup.py', 'setup.cfg', 'constraints.txt', 'gemfile', 'go.mod', 'go.sum', 'go.work',
  'cargo.toml', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mix.exs', 'podfile',
  'package.swift', 'package.resolved', 'deno.json', 'deno.jsonc', 'vcpkg.json', 'conanfile.txt', 'conanfile.py', 'flake.nix']);
const DEPENDENCY_FORMS = [/\.lock$/i, /\.lockb$/i, /-lock\.(?:json|ya?ml)$/i, /\.lockfile$/i, /^requirements.*\.(?:txt|in)$/i];
// A migration, wherever it is.
const MIGRATION_SEGMENTS = new Set(['migrations', 'migration', 'migrate']);
const MIGRATION_FORMS = [/\.sql$/i];

// The file types the fast lane may touch: an allow list, on top of the safe
// paths. A safe place says nothing of what a file there does: docs/build.sh
// runs, docs/theme.js runs in the page, docs/post.mdx imports modules and
// evaluates expressions. Only types whose content is text the scan can read
// whole, and that nothing runs, are taken: prose (md, markdown, txt), style
// sheets (css, every load and escape of which the content rule refuses) and
// translations (json, po). Not reStructuredText (its directives include
// other files and raw HTML), not CSV (often data loaded into a database, and
// formulas for a spreadsheet). The extension is compared as it is written,
// never folded: "README.MD" or "x.Sh" is not "md", and the full circuit
// takes it. [fast_lane] file_types can only narrow this list;
// extra_file_types widens it explicitly, never with a type of CODE_TYPES.
export const FILE_TYPES = ['md', 'markdown', 'txt', 'css', 'json', 'po'];
// Types that run, are interpreted, or configure something that does: never
// fast, whatever the settings say, as an extension or as any inner part of a
// name ("notes.php.md": a server that maps every extension of a name runs it).
export const CODE_TYPES = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'command', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'com', 'exe', 'dll', 'so', 'dylib', 'bin', 'run',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'coffee', 'wasm', 'map',
  'py', 'pyw', 'pyc', 'pyi', 'ipynb', 'rb', 'erb', 'rake', 'php', 'phtml', 'phar', 'php3', 'php4', 'php5', 'php7', 'phps', 'pl', 'pm', 'cgi', 'fcgi', 'lua', 'tcl', 'awk', 'sed',
  'go', 'rs', 'java', 'jar', 'war', 'class', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hs', 'ml', 'fs', 'fsx', 'dart', 'swift', 'm', 'mm', 'r', 'jl', 'nim', 'zig',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'csx', 'vb', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'reg', 'scr', 'msi', 'apk', 'deb', 'rpm', 'dmg', 'pkg',
  'html', 'htm', 'xhtml', 'shtml', 'shtm', 'stm', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'xsd', 'dtd', 'rss', 'atom', 'mdx', 'markdoc', 'rst', 'adoc', 'asciidoc', 'tex', 'org',
  'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties', 'plist', 'json5', 'jsonc', 'hjson', 'cson', 'neon', 'hcl', 'tf', 'tfvars', 'nix', 'dhall', 'jsonnet', 'libsonnet', 'cue', 'kdl',
  'njk', 'nunjucks', 'liquid', 'hbs', 'handlebars', 'mustache', 'ejs', 'haml', 'slim', 'pug', 'jade', 'jinja', 'jinja2', 'j2', 'twig', 'tpl', 'tmpl', 'tt', 'mako', 'eex', 'heex', 'leex', 'razor', 'cshtml', 'vbhtml',
  'asp', 'aspx', 'ascx', 'ashx', 'asmx', 'axd', 'jsp', 'jspx', 'jsf', 'cfm', 'cfml', 'xsjs',
  'sql', 'sqlite', 'db', 'lock', 'lockb', 'service', 'socket', 'timer', 'desktop', 'htaccess', 'htpasswd', 'npmrc', 'gitattributes', 'gitmodules', 'gitignore', 'mailmap',
  'dockerfile', 'containerfile', 'makefile', 'mk', 'cmake', 'ninja', 'bazel', 'bzl', 'star', 'csproj', 'vbproj', 'fsproj', 'sln', 'props', 'targets', 'pom',
  'patch', 'diff', 'pem', 'key', 'crt', 'cer', 'p12', 'pfx']);
// Files of an allowed type that configure a tool or a deployment, wherever they are: not prose, not a translation.
const CONFIG_NAMES = new Set(['vercel.json', 'now.json', 'netlify.json', 'firebase.json', 'renovate.json', 'turbo.json', 'nx.json', 'angular.json', 'project.json',
  'lerna.json', 'app.json', 'biome.json', 'wrangler.json', 'manifest.json', 'appsettings.json', 'launch.json', 'settings.json', 'tasks.json', 'devcontainer.json',
  'components.json', 'cypress.json', 'openapi.json', 'swagger.json', 'cmakelists.txt', 'robots.txt']);
const CONFIG_FORMS = [/^(?:ts|js)config(?:\.[^.]+)*\.json$/i, /\.config\.json$/i, /^appsettings\.[^.]+\.json$/i, /^\.?(?:eslint|prettier|babel|swc|stylelint|markdownlint)rc(?:\..+)?$/i];
// A type as the settings may name one: lower-case letters and digits only.
const TYPE_FORM = /^[a-z0-9]{1,16}$/;
export function fileTypeOk(path, types) {
  const name = String(path ?? '').split('/').at(-1);
  // Plain ASCII, as the path rule says, checked here again on its own.
  if (!/^[A-Za-z0-9._@+-]+$/.test(name)) return false;
  const parts = name.split('.');
  // A name with no extension (a hook, a script), a dotfile (a tool's settings), an empty part ("a..md", "x.md."): not judged.
  if (parts.length < 2 || parts.some((part) => part === '')) return false;
  const extension = parts.at(-1);
  if (!types.has(extension) || CODE_TYPES.has(extension)) return false;
  // Every inner part too, in any case: "notes.sh.md", "x.PHP.md".
  if (parts.slice(1, -1).some((part) => CODE_TYPES.has(part.toLowerCase()))) return false;
  if (CONFIG_NAMES.has(name.toLowerCase()) || CONFIG_FORMS.some((form) => form.test(name))) return false;
  return true;
}
const fileTypes = (narrow, extra) => {
  const chosen = list(narrow);
  const widened = list(extra);
  for (const type of [...chosen, ...widened]) {
    if (!TYPE_FORM.test(type)) throw new Error(`[fast_lane] "${type}" is not a file type (lower-case letters and digits, no dot)`);
  }
  const outside = chosen.find((type) => !FILE_TYPES.includes(type));
  if (outside !== undefined) throw new Error(`[fast_lane] file_types can only narrow the built-in list (${FILE_TYPES.join(', ')}): "${outside}" is not in it; extra_file_types widens it, at the project's own risk`);
  const code = widened.find((type) => CODE_TYPES.has(type));
  if (code !== undefined) throw new Error(`[fast_lane] extra_file_types cannot take "${code}": a type that runs, is interpreted or configures something is never fast`);
  return new Set([...(chosen.length ? chosen : FILE_TYPES), ...widened]);
};

// The few glob forms the settings may use: "dir/" (all under it), "*" (within
// one segment), "?" (one character), "**" (any number of segments, as a
// whole segment). Nothing else: a pattern with another sign is refused, and
// refused settings make nothing fast. A segment that begins with "." (a
// dotfile, a dot directory) is matched only by a pattern segment that begins
// with "." too: "*" and "**" never take it, so "docs/" holds no docs/.env.
const GLOB_FORM = /^[A-Za-z0-9._@+*?/-]+$/;
export function globMatcher(pattern) {
  const text = String(pattern ?? '').trim();
  if (!GLOB_FORM.test(text) || text.startsWith('/')) throw new Error(`[fast_lane] unreadable path pattern "${text}"`);
  // "dir/" is what lies under dir, at one segment or more: never a file named dir.
  const parts = (text.endsWith('/') ? `${text}*/**` : text).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || (part.includes('**') && part !== '**'))) throw new Error(`[fast_lane] unreadable path pattern "${text}"`);
  const compiled = parts.map((part) => (part === '**' ? '**' : {
    dot: part.startsWith('.'),
    re: new RegExp(`^${part.replace(/[.+]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`),
  }));
  return (path) => {
    const segments = path.split('/');
    const seen = new Map();
    const at = (i, j) => {
      const key = i * 4096 + j;
      if (seen.has(key)) return seen.get(key);
      let result;
      if (i === compiled.length) result = j === segments.length;
      else if (compiled[i] === '**') result = at(i + 1, j) || (j < segments.length && !segments[j].startsWith('.') && at(i, j + 1));
      else result = j < segments.length && compiled[i].re.test(segments[j]) && (compiled[i].dot || !segments[j].startsWith('.')) && at(i + 1, j + 1);
      seen.set(key, result);
      return result;
    };
    return at(0, 0);
  };
}

const whole = (raw, key, fallback, min, max) => {
  const text = String(raw ?? fallback).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < min || n > max) throw new Error(`[fast_lane] ${key} must be a whole number from ${min} to ${max}`);
  return n;
};

// The command line of the targeted tests, cut into words with no shell: a
// word in single or double quotes keeps its spaces, and nothing is expanded.
// The signs a shell would read are refused, so that nobody believes they
// work. {files} must be one whole word, once: it becomes the changed files,
// one argument each.
export function commandWords(command) {
  const text = String(command ?? '').trim();
  if (!text) return [];
  if (/[;|&$`<>()\\\n\r]/.test(text)) throw new Error('[fast_lane] tests_command runs without a shell: no ; | & $ ` < > ( ) \\ in it');
  const words = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(text))) words.push(match[1] ?? match[2] ?? match[3]);
  if (words.some((word) => /['"]/.test(word))) throw new Error('[fast_lane] tests_command has an unbalanced quote');
  const placeholders = words.filter((word) => word.includes('{files}'));
  if (placeholders.length !== 1 || placeholders[0] !== '{files}') throw new Error('[fast_lane] tests_command must hold {files} once, as a word of its own');
  if (words[0] === '{files}') throw new Error('[fast_lane] tests_command must start with a program, not {files}');
  return words;
}
export function targetedArgv(command, files) {
  const words = commandWords(command);
  if (!words.length) return [];
  if (!files.length || !files.every(pathFormOk)) throw new Error('the changed files cannot be handed to the targeted tests');
  return words.flatMap((word) => (word === '{files}' ? files : [word]));
}

// Every key the section knows. A key that is not one of them (a typo such as
// never_path) is refused, not ignored: the fast lane would otherwise run
// without the limit its author meant to set.
const FAST_KEYS = new Set(['enabled', 'labels', 'projects', 'author_model', 'review_model', 'safe_paths', 'never_paths', 'dependency_files',
  'max_lines', 'max_files', 'max_file_bytes', 'tests_command', 'tests_timeout_minutes', 'capture_screen', 'forbidden_text', 'trust_label_without_actor',
  'file_types', 'extra_file_types']);

// Literal texts the content rule refuses on top of its own (compared without
// case): never a pattern, so that nothing in them can be slow or clever.
const forbiddenText = (raw) => list(raw).map((text) => {
  if (text.length > 200 || /[\u0000-\u001F\u007F]/.test(text)) throw new Error('[fast_lane] forbidden_text holds comma-separated texts of at most 200 characters');
  return text.toLowerCase();
});

// The settings, checked whole: one that cannot be read makes nothing fast.
export function fastSettings(conf) {
  const s = section(conf, 'fast_lane');
  const unknown = Object.keys(s).find((key) => !FAST_KEYS.has(key));
  if (unknown !== undefined) throw new Error(`[fast_lane] unknown key "${unknown}": the fast lane is off for every ticket until it is removed or spelled as the docs say`);
  const words = commandWords(s.tests_command);
  const migrations = list(section(conf, 'release').migration_paths).map((p) => p.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase());
  return {
    enabled: yes(s.enabled),
    labels: list(s.labels),
    projects: list(s.projects),
    authorModel: s.author_model || '',
    reviewModel: s.review_model || '',
    safe: list(s.safe_paths).map(globMatcher),
    never: list(s.never_paths).map(globMatcher),
    dependencies: list(s.dependency_files).map(globMatcher),
    types: fileTypes(s.file_types, s.extra_file_types),
    migrations,
    guarded: list(section(conf, 'merge').guarded_paths).map((p) => p.toLowerCase()),
    maxLines: whole(s.max_lines, 'max_lines', 40, 1, 2000),
    maxFiles: whole(s.max_files, 'max_files', 10, 1, 200),
    maxBytes: whole(s.max_file_bytes, 'max_file_bytes', 100000, 1, 5000000),
    testsCommand: words.length ? s.tests_command.trim() : '',
    testsTimeoutMinutes: whole(s.tests_timeout_minutes, 'tests_timeout_minutes', 10, 1, 120),
    captureScreen: s.capture_screen || '',
    forbidden: forbiddenText(s.forbidden_text),
    trustLabelWithoutActor: yes(s.trust_label_without_actor),
  };
}

// At opening: the ticket's own label or project, as the tracker says it, and
// only when the user set it. An agent can create a ticket (the lead files
// follow-ups, [tracker] create_label and create_project may be the fast
// ones) or add a label: a mark it set picks nothing. Who set each label and
// the project is what the tracker's history says (tracker.ts label-actors:
// {labels: {name: {kind, id}}, project: {kind, id} | null}); a mark counts
// when its setter is the human owner (kind "human", which the adapters give
// only to [tracker] owner_id). A tracker that cannot say (actors null) gives
// nothing, unless the project opts in with trust_label_without_actor = yes.
// A tracker whose scripts act under the user's own key cannot say either: a
// mark it gives to the user (kind "human") may be an agent's, and reads as
// "unverified", which counts only with the same opt-in. An agent it names is
// refused in every case.
const UNVERIFIED = 'unverified';
export function openingDecision(settings, issue, actors = null) {
  if (!settings.enabled) return { lane: 'full', ignored: [] };
  const labels = Array.isArray(issue?.labels) ? issue.labels.map(String) : [];
  const project = issue?.project == null ? '' : String(issue.project);
  const marks = [
    ...labels.filter((label) => settings.labels.includes(label)).map((label) => ({ what: 'label', name: label, by: actors?.labels?.[label] })),
    ...(project !== '' && settings.projects.includes(project) ? [{ what: 'project', name: project, by: actors?.project }] : []),
  ];
  const known = actors && typeof actors === 'object';
  const trusted = (mark) => (!known ? settings.trustLabelWithoutActor
    : mark.by?.kind === 'human' || (mark.by?.kind === UNVERIFIED && settings.trustLabelWithoutActor));
  const why = (mark) => (!known ? 'the tracker cannot say who set it'
    : mark.by?.kind === UNVERIFIED ? 'set under the key the agents share with the user: the tracker cannot say who set it ([merge] separate_identity)'
      : `set by ${mark.by?.kind ?? 'nobody known'}`);
  const ignored = marks.filter((mark) => !trusted(mark)).map((mark) => `${mark.what} ${mark.name} (${why(mark)})`);
  return { lane: marks.some(trusted) ? 'fast' : 'full', ignored };
}
export const openingLane = (settings, issue, actors = null) => openingDecision(settings, issue, actors).lane;

// Can the tracker tell the user from an agent? As merge-pr.ts reads it before
// it takes any agreement from the tracker: no when the scripts act under the
// key of a person (tracker.ts identity is not "app"), unless the owner says
// he accepts that ([merge] separate_identity = no). An identity that cannot
// be read is not an application's.
export const sharedIdentity = (conf, identity) => section(conf, 'merge').separate_identity !== 'no' && identity !== 'app';
export function trackerIdentity() {
  try { return execFileSync(join(ORCH_HOME, 'tracker.ts'), ['identity'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unknown'; }
}
// What the tracker says of who set each mark, with the user's own marks made
// unverified when it cannot tell him from an agent.
export const unverifiedActors = (actors) => {
  if (!actors || typeof actors !== 'object') return null;
  const blur = (by) => (by?.kind === 'human' ? { ...by, kind: UNVERIFIED } : by);
  return { ...actors, labels: Object.fromEntries(Object.entries(actors.labels ?? {}).map(([name, by]) => [name, blur(by)])), project: blur(actors.project ?? null) };
};

// The opening decision with the tracker asked: who set the marks, and whether
// it can tell the user from an agent at all. The tracker is asked only for a
// ticket that carries a fast mark. Even opted in (trust_label_without_actor),
// a mark the tracker says an agent set is refused: the opt-in only covers a
// tracker that cannot say.
export function openingFor(conf, settings, issue, { identity = trackerIdentity, actorsOf = labelActors } = {}) {
  if (openingDecision({ ...settings, trustLabelWithoutActor: true }, issue).lane !== 'fast') return openingDecision(settings, issue, null);
  const actors = actorsOf(issue?.identifier);
  return openingDecision(settings, issue, sharedIdentity(conf, identity()) ? unverifiedActors(actors) : actors);
}

// Who set the labels and the project of a ticket, from the tracker; null when it cannot say.
export function labelActors(ticket) {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(String(ticket ?? ''))) return null;
  try {
    const actors = JSON.parse(execFileSync(join(ORCH_HOME, 'tracker.ts'), ['label-actors', ticket], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }));
    return actors && typeof actors === 'object' && actors.labels && typeof actors.labels === 'object' ? actors : null;
  } catch { return null; }
}

const protectedPath = (path, settings) => {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  if (segments.some((part) => PROTECTED_SEGMENTS.has(part) || part.startsWith('.git'))) return true;
  if (PROTECTED_NAMES.has(segments.at(-1)) || PROTECTED_FORMS.some((form) => form.test(segments.at(-1)))) return true;
  // Compared without case: a checkout on a disk that ignores it would take
  // ".Cleared/" for ".cleared/".
  if (settings.guarded.some((prefix) => lower.startsWith(prefix))) return true;
  return settings.never.some((match) => match(path) || match(lower));
};
const dependencyPath = (path, settings) => {
  const name = path.split('/').at(-1);
  return DEPENDENCY_NAMES.has(name.toLowerCase()) || DEPENDENCY_FORMS.some((form) => form.test(name)) || settings.dependencies.some((match) => match(path));
};
const migrationPath = (path, settings) => {
  const lower = path.toLowerCase();
  return lower.split('/').some((part) => MIGRATION_SEGMENTS.has(part)) || MIGRATION_FORMS.some((form) => form.test(lower))
    || settings.migrations.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
};

// The reasons a diff takes the full circuit, as codes (the card says them in
// words; lib/i18n app_srv_fast_reason_<code>). The first path that broke a
// rule is kept for the project lead, never shown on the card.
export const RULE_REASONS = ['empty', 'too_many_files', 'too_many_lines', 'too_large', 'unusual_change', 'binary', 'path_form', 'protected', 'dependency', 'migration', 'outside_safe', 'file_type', 'content', 'link', 'asked'];
export function judgeDiff(entries, settings) {
  const reasons = [];
  const offending = {};
  const add = (code, path = null) => {
    if (!reasons.includes(code)) reasons.push(code);
    if (path && !offending[code]) offending[code] = path;
  };
  if (!entries.length) add('empty');
  if (entries.length > settings.maxFiles) add('too_many_files');
  let lines = 0;
  const lowered = new Set();
  for (const entry of entries) {
    if (!pathFormOk(entry.path)) { add('path_form', null); continue; }
    // Two paths that differ only by case: the same file on some disks.
    const lower = entry.path.toLowerCase();
    if (lowered.has(lower)) add('path_form', entry.path);
    lowered.add(lower);
    // Only a file added or changed, as a plain file both before and after.
    // A deletion, a rename (seen as a deletion and an addition), a change of
    // type or of mode, a symbolic link (120000), a submodule (160000), an
    // executable (100755), an unmerged or unknown status: not judged here.
    if (!['A', 'M'].includes(entry.status) || entry.newMode !== '100644' || (entry.status === 'M' && entry.oldMode !== '100644')) add('unusual_change', entry.path);
    if (entry.binary) add('binary', entry.path);
    if (!(Number.isSafeInteger(entry.size) && entry.size <= settings.maxBytes)) add('too_large', entry.path);
    if (Number.isSafeInteger(entry.added) && Number.isSafeInteger(entry.deleted)) lines += entry.added + entry.deleted;
    if (protectedPath(entry.path, settings)) add('protected', entry.path);
    if (dependencyPath(entry.path, settings)) add('dependency', entry.path);
    if (migrationPath(entry.path, settings)) add('migration', entry.path);
    if (!settings.safe.some((match) => match(entry.path))) add('outside_safe', entry.path);
    // A safe place, then a type the fast lane takes. Settings built without a
    // list of types (an older caller) take the built-in one, never every type.
    if (!fileTypeOk(entry.path, settings.types ?? new Set(FILE_TYPES))) add('file_type', entry.path);
    // What the file gains is read too: plain text nothing interprets, or the full circuit.
    const finding = contentFinding(entry.addedLines, settings.forbidden ?? []);
    if (finding) add(finding === 'link' ? 'link' : 'content', `${entry.path} (${finding})`);
  }
  if (lines > settings.maxLines) add('too_many_lines');
  return { fast: reasons.length === 0, reasons, lines, files: entries.length, offending };
}

// `git diff-tree --raw -z` and `--numstat -z`, read into one entry a path.
// Anything that does not read as expected throws: the caller takes the
// full circuit.
export function parseRaw(buffer) {
  const parts = buffer.toString('latin1').split('\0');
  if (parts.at(-1) === '') parts.pop();
  const entries = [];
  for (let i = 0; i < parts.length;) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/.exec(parts[i]);
    if (!meta) throw new Error('unreadable raw diff');
    const status = meta[5];
    const paths = ['R', 'C'].includes(status) ? 2 : 1;
    const named = parts.slice(i + 1, i + 1 + paths);
    if (named.length !== paths || named.some((path) => !path)) throw new Error('unreadable raw diff');
    // Names are read as bytes: one that is not plain ASCII never matches a rule.
    entries.push({ oldMode: meta[1], newMode: meta[2], oldBlob: meta[3], newBlob: meta[4], status, path: named.at(-1), from: paths === 2 ? named[0] : null });
    i += 1 + paths;
  }
  return entries;
}
export function parseNumstat(buffer) {
  const parts = buffer.toString('latin1').split('\0');
  if (parts.at(-1) === '') parts.pop();
  const out = new Map();
  for (const part of parts) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(part);
    if (!match || out.has(match[3])) throw new Error('unreadable numstat');
    out.set(match[3], { binary: match[1] === '-' || match[2] === '-', added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]) });
  }
  return out;
}

// `git diff-tree -p -U0` with the prefixes a/ and b/, read into the lines each
// file gains (and the count of those it loses), as UTF-8 text. Strict: a
// header, a hunk or a line that does not read as expected throws, and the
// caller takes the full circuit. A gained line that is not valid UTF-8 is
// kept as null: the content rule refuses it.
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function parsePatch(buffer) {
  const lines = buffer.toString('latin1').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const files = new Map();
  let current = null;
  let path = null;
  let hunk = false;
  for (const line of lines) {
    const opened = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (opened) {
      if (opened[1] !== opened[2] || files.has(opened[2])) throw new Error('unreadable patch');
      path = opened[2];
      current = { added: [], deleted: 0, binary: false };
      files.set(path, current);
      hunk = false;
      continue;
    }
    if (!current) throw new Error('unreadable patch');
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { hunk = true; continue; }
    if (hunk) {
      if (line.startsWith('+')) {
        let text;
        try { text = utf8.decode(Buffer.from(line.slice(1), 'latin1')); } catch { text = null; }
        current.added.push(text);
      } else if (line.startsWith('-')) current.deleted += 1;
      else if (line !== '\\ No newline at end of file' && !line.startsWith(' ')) throw new Error('unreadable patch');
      continue;
    }
    if (/^(?:new file mode|deleted file mode|old mode|new mode) \d{6}$/.test(line) || /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d{6})?$/.test(line)) continue;
    if ([`--- a/${path}`, '--- /dev/null', `+++ b/${path}`, '+++ /dev/null'].includes(line)) continue;
    if (line === `Binary files a/${path} and b/${path} differ` || /^Binary files (?:\/dev\/null|a\/\S+) and (?:\/dev\/null|b\/\S+) differ$/.test(line)) { current.binary = true; continue; }
    throw new Error('unreadable patch');
  }
  return files;
}

// The content rule: what a file in the safe paths gains must be plain text
// that nothing interprets. A safe path is only a place; a style sheet can
// load a remote URL or hide a banner, a translation interpolated into HTML can
// carry a tag, a template can run an expression. Every line a file gains is
// read (the same diff the other rules read), compared without case, and any
// of these sends the ticket to the full circuit: markup or a tag ("<",
// "%3c", an HTML entity "&...;" or "&#"), a remote or inline load ("url(",
// "@import", "@font-face", "@namespace", "data:", "javascript:", "vbscript:",
// "expression(", "behavior:", "-moz-binding"), a template or interpolation
// ("{{", "{%", "${", "#{", "<%"), a file included at build time ("{!", "!include"), an escape that can spell any of them
// ("\" before a hex digit, "\u", "\x"), an event handler ("on...="), a remote address ("scheme://", "//host",
// "www.", "mailto:", a Markdown image: reason "link"), and the characters that hide text from a reader or speak to a
// reviewer (controls, zero-width, bidi, the tag block). Each line is read as it is and as NFKC folds it. One
// scan for every file, prose included: Markdown carries raw HTML, MDX and
// Jekyll run what is in it. [fast_lane] forbidden_text adds literal texts.
const CONTENT_PATTERNS = [
  ['markup', /<|%3c|&#|&[a-z][a-z0-9]*;/i],
  ['load', /url\s*\(|@import|@font-face|@namespace|\bdata\s*:|javascript\s*:|vbscript\s*:|expression\s*\(|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(|src\s*\(|cross-fade\s*\(|element\s*\(|paint\s*\(/i],
  ['template', /\{\{|\{%|\$\{|#\{/],
  // A file pulled into a Markdown page at build time: markdown-include's "{!file!}", the "!include" of several preprocessors.
  ['template', /\{!|!include/i],
  ['escape', /\\[0-9a-f]|\\u|\\x/i],
  ['handler', /\bon[a-z]+\s*=/i],
  // A remote address in any form: a scheme and "//", a protocol-relative "//host", "www.", "mailto:", a Markdown image.
  ['link', /[a-z][a-z0-9+.-]*:\/\/|\/\/[a-z0-9]|www\.|mailto\s*:|!\[[^\]]*\]\(/i],
  // Controls but the tab (a carriage return only at the end), format characters, line and paragraph separators, and the
  // invisible fillers and look-alikes that hide text or carry an instruction to a reviewer.
  ['hidden', /(?!\t)(?!\r$)\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}|[\u{34F}\u{61C}\u{115F}\u{1160}\u{180E}\u{2800}\u{3164}\u{FFA0}\u{FE00}-\u{FE0F}\u{E0000}-\u{E007F}]/u],
];
export function contentFinding(added, extra = []) {
  if (!Array.isArray(added)) return 'unread';
  for (const line of added) {
    if (typeof line !== 'string') return 'encoding';
    // Read as it is and with its blanks taken out, written or escaped: a
    // browser drops a tab or a newline inside a URL ("java\tscript:").
    // And as NFKC folds it: fullwidth look-alikes ("＜script", "ｊａｖａｓｃｒｉｐｔ:") read as the ASCII they become.
    for (const form of new Set([line, line.normalize('NFKC')])) {
      const squeezed = form.replace(/\\[tnrfbv]|[\t\n\f\r\v ]+/g, '');
      for (const [name, pattern] of CONTENT_PATTERNS) if (pattern.test(form) || pattern.test(squeezed)) return name;
      const lower = form.toLowerCase();
      if (extra.some((text) => lower.includes(text))) return 'forbidden_text';
    }
  }
  return null;
}

// What landing a commit on the base would change, as git says it, on the
// project's main checkout with its read environment (lib/git-checkout.ts):
// plumbing, no external diff, no text conversion, no rename detection. Not
// the branch's diff against the point it left the base: the tree the merge
// makes (git merge-tree --write-tree, git 2.38 or later), against the base's
// own tree. A history with more than one merge base (criss-cross merges)
// makes git and the forge merge from a virtual base, where a file can come
// back to an old version without the branch's diff showing it: not judged.
// A merge that conflicts is not judged either. The trees the merge writes go
// to a scratch object directory, never into the checkout's.
const MAX_ENTRIES = 500;
const READ = { maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const HEX = /^[0-9a-f]{40,64}$/;
export function readDiff(repo, base, commit) {
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || !/^[A-Za-z0-9._/-]+$/.test(commit) || commit.startsWith('-') || base.startsWith('-')) throw new Error('unreadable commit');
  const rev = (ref) => execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', ref], { ...READ, env: checkoutReadEnv(repo) }).toString().trim();
  const head = rev(`${commit}^{commit}`);
  const tip = rev(`${base}^{commit}`);
  if (!HEX.test(head) || !HEX.test(tip)) throw new Error('unreadable commit');
  const bases = execFileSync('git', ['-C', repo, 'merge-base', '--all', '--end-of-options', tip, head], { ...READ, env: checkoutReadEnv(repo) }).toString().split('\n').filter(Boolean);
  if (bases.length !== 1 || !HEX.test(bases[0])) throw new Error(bases.length > 1 ? 'more than one merge base (criss-cross history)' : 'no merge base');
  const baseTree = rev(`${tip}^{tree}`);
  const objects = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { ...READ, env: checkoutReadEnv(repo) }).toString().trim();
  const scratchObjects = mkdtempSync(join(tmpdir(), 'cleared-fast-lane-objects-'));
  // The read environment, with the objects the merge writes kept in the scratch directory.
  const git = (args, options = {}) => execFileSync('git', ['-C', repo].concat(args),
    { ...READ, env: { ...checkoutReadEnv(repo), GIT_OBJECT_DIRECTORY: scratchObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(objects, 'objects') }, ...options });
  try {
    let merged;
    try { merged = git(['merge-tree', '--write-tree', '--no-messages', tip, head]).toString().split('\n')[0]; }
    catch (error) {
      if (error.status === 1) throw new Error('the merge conflicts');
      const said = gitFirstLine(error);
      throw new Error(/unknown option|usage: git merge-tree/i.test(String(error.stderr ?? '')) ? `git cannot compute the merge (git merge-tree --write-tree needs git 2.38 or later): ${said}` : `the merge cannot be computed: ${said}`);
    }
    if (!HEX.test(merged)) throw new Error('unreadable merge');
    const raw = parseRaw(git(['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', baseTree, merged]));
    if (raw.length > MAX_ENTRIES) return { head, entries: raw.map((entry) => ({ ...entry, size: null })) };
    const counts = parseNumstat(git(['diff-tree', '-r', '-z', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', baseTree, merged]));
    if (counts.size !== raw.length || raw.some((entry) => !counts.has(entry.path))) throw new Error('the two readings of the diff differ');
    // The lines each file gains, from a third reading that must agree with the
    // two others, file by file and line by line. One that does not read, or
    // does not agree, leaves the content unread: the content rule refuses
    // it, and the other rules still say what they see.
    let patch = null;
    try {
      patch = parsePatch(git(['diff-tree', '-r', '-p', '-U0', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', baseTree, merged]));
      const agrees = patch.size === raw.length && raw.every((entry) => {
        const read = patch.get(entry.path);
        const counted = counts.get(entry.path);
        return read && (counted.binary || (read.added.length === counted.added && read.deleted === counted.deleted));
      });
      if (!agrees) patch = null;
    } catch { patch = null; }
    const blobs = raw.filter((entry) => !/^0+$/.test(entry.newBlob)).map((entry) => entry.newBlob);
    const sizes = new Map();
    if (blobs.length) {
      const listed = git(['cat-file', '--batch-check'], { input: `${blobs.join('\n')}\n` });
      for (const line of listed.toString().split('\n')) {
        const match = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
        if (match) sizes.set(match[1], match[2] === 'blob' ? Number(match[3]) : null);
      }
    }
    return { head, entries: raw.map((entry) => ({ ...entry, ...counts.get(entry.path), addedLines: patch ? patch.get(entry.path).added : null, size: sizes.get(entry.newBlob) ?? null })) };
  } finally { rmSync(scratchObjects, { recursive: true, force: true }); }
}

// Kept for the state of one lane: what was decided, at which commit. A
// demotion is for good: a ticket sent back to the full circuit by a rule
// never comes back to the fast lane. What says nothing of the change (the
// settings unreadable or the fast lane off, git that cannot answer now)
// gives the full circuit for this call and is not kept as a demotion.
export function decideLane({ conf, repo, base, commit, record, read = readDiff }) {
  const kept = record?.fast_lane;
  if (!kept || kept.opening !== 'fast') return { state: 'full', reasons: ['not_fast_at_opening'], keep: false };
  if (kept.state !== 'fast') return { state: 'full', reasons: Array.isArray(kept.reasons) && kept.reasons.length ? kept.reasons : ['earlier'], keep: false };
  let settings;
  try { settings = fastSettings(conf); } catch (error) { return { state: 'full', reasons: ['settings'], keep: false, problem: error.message }; }
  if (!settings.enabled) return { state: 'full', reasons: ['disabled'], keep: false };
  let diff;
  // A git too old to compute the merge is said (once a round, as the settings are): nothing is fast until it is updated.
  try { diff = read(repo, base, commit); } catch (error) { return { state: 'full', reasons: ['unreadable'], keep: false, ...(/git 2\.38/.test(error?.message) ? { problem: error.message } : {}) }; }
  const judged = judgeDiff(diff.entries, settings);
  return { state: judged.fast ? 'fast' : 'full', reasons: judged.reasons, head: diff.head, lines: judged.lines, files: judged.files, offending: judged.offending, keep: true, entries: diff.entries };
}

// Only the service writes what is decided: the state is its own, and a
// process of another account (the agents') is refused before it reads
// anything, even where the file system would refuse it anyway.
export function assertService({ uid = process.getuid(), owner = statSync(stateDir()).uid } = {}) {
  if (uid !== owner) throw new Error('only the service account decides the lane of a ticket');
}

const recordPath = (key) => {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+(?:\.2)?$/.test(String(key))) throw new Error(`"${key}" is not a lane`);
  return join(stateDir(), 'lanes', `${key}.json`);
};
const readRecord = (key) => {
  try { const value = JSON.parse(readFileSync(recordPath(key), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
};
// The fast-lane fields of a record, changed by a patch that is merged into
// them. The read and the rewrite of the whole file happen under the record's
// lock, the one the shell writers take too (lane_write in lib/common.sh): a
// flock held by the command that runs the rewrite, for as long as it runs.
const writeRecord = (key, patch) => {
  const path = recordPath(key);
  execFileSync('flock', ['-w', '30', `${path}.lock`, process.execPath, fileURLToPath(import.meta.url), 'record-write', String(key)],
    { input: JSON.stringify(patch), stdio: ['pipe', 'ignore', 'pipe'] });
};
const rewriteRecord = (key, patch) => {
  const path = recordPath(key);
  const current = readRecord(key) ?? {};
  const next = { ...current, fast_lane: { ...(current.fast_lane ?? {}), ...patch } };
  writeFileSync(`${path}.fast.part`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${path}.fast.part`, path);
  return next;
};
const ticketOf = (key) => String(key).replace(/\.2$/, '');
const event = (kind, ticket, detail, value = null) => {
  const db = openLedger(ledgerPath());
  try { addEvent(db, { kind, ticket, detail: typeof detail === 'string' ? detail : JSON.stringify(detail), value }); } finally { db.close(); }
};

export function decide(key, commit, { conf = loadConf(), repo = projectDir(), read = readDiff, write = true } = {}) {
  if (write) assertService();
  const record = readRecord(key);
  const base = section(conf, 'lanes').base || 'origin/main';
  const result = decideLane({ conf, repo, base, commit, record, read });
  // The settings that cannot be read are said, once per round, not swallowed.
  if (result.problem) process.stderr.write(`fast-lane: ${result.problem}\n`);
  if (!result.keep || !write) return result;
  const kept = record.fast_lane;
  const at = new Date().toISOString();
  if (result.state === 'fast') {
    if (kept.head !== result.head) {
      writeRecord(key, { head: result.head, lines: result.lines, files: result.files, at });
      event('fast_lane_kept', ticketOf(key), { head: result.head, lines: result.lines, files: result.files });
    }
    return result;
  }
  // When it left the fast lane: a review read before that does not count for the full circuit (merge-pr.ts, review-pr.sh).
  writeRecord(key, { state: 'full', head: result.head, reasons: result.reasons, at, demoted_at: at });
  const first = Object.entries(result.offending).map(([code, path]) => `${code}: ${path}`).join('; ');
  event('fast_lane_fallback', ticketOf(key), { head: result.head, reasons: result.reasons, lines: result.lines, files: result.files, first: first.slice(0, 400) });
  return result;
}

export function demote(key, reason) {
  assertService();
  if (!RULE_REASONS.includes(reason)) throw new Error(`unknown reason "${reason}"`);
  const record = readRecord(key);
  if (record?.fast_lane?.state !== 'fast') return false;
  const at = new Date().toISOString();
  writeRecord(key, { state: 'full', reasons: [reason], at, demoted_at: at });
  event('fast_lane_fallback', ticketOf(key), { head: record.fast_lane.head ?? null, reasons: [reason] });
  return true;
}

// The targeted tests of a commit the rules just found fast, never of another.
export function targeted(key, commit, { conf = loadConf(), repo = projectDir(), read = readDiff } = {}) {
  const settings = fastSettings(conf);
  if (!settings.testsCommand) return null;
  const record = readRecord(key);
  if (record?.fast_lane?.state !== 'fast') return null;
  const diff = read(repo, section(conf, 'lanes').base || 'origin/main', commit);
  if (diff.head !== record.fast_lane.head) return null;
  return targetedArgv(settings.testsCommand, diff.entries.map((entry) => entry.path));
}

// The targeted tests of a commit: their exit code, or "skipped" when they could
// not run there (no command line, no room to run them): the card says which.
export function testsDone(key, commit, code) {
  assertService();
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !(code === 'skipped' || /^\d+$/.test(String(code)))) throw new Error('usage: tests-done <lane key> <commit> <exit code|skipped>');
  if (code === 'skipped') {
    writeRecord(key, { tests: { head: commit, skipped: true, at: new Date().toISOString() } });
    event('fast_lane_tests', ticketOf(key), { head: commit, skipped: true }, null);
    return;
  }
  writeRecord(key, { tests: { head: commit, exit: Number(code), at: new Date().toISOString() } });
  event('fast_lane_tests', ticketOf(key), { head: commit, exit: Number(code) }, Number(code));
}

// ---- Measurement ----

// The time of one ticket from Todo to Done, in three parts that do not
// overlap one another's start: working (some agent session running: the
// union of their times), the human's wait (from the notification that told
// him, else from the moment the card asked him, to his gesture), and the
// machine's wait (the rest: checks, queues, the host). Minutes, one decimal.
export function measureTicket({ todoAt, doneAt, runs = [], cardAt = null, notifiedAt = null, gestureAt = null }) {
  const start = Date.parse(todoAt);
  const end = Date.parse(doneAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const clip = (t) => Math.min(end, Math.max(start, t));
  const spans = runs.map((run) => [clip(Date.parse(run.started_at)), clip(Date.parse(run.ended_at ?? doneAt))])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  const union = (list) => {
    let total = 0, from = null, to = null;
    for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
      if (from === null || a > to) { if (from !== null) total += to - from; from = a; to = b; } else to = Math.max(to, b);
    }
    return from === null ? 0 : total + (to - from);
  };
  const working = union(spans);
  const askedFrom = Number.isFinite(Date.parse(notifiedAt)) ? Date.parse(notifiedAt) : Date.parse(cardAt);
  const gesture = Date.parse(gestureAt);
  const human = Number.isFinite(askedFrom) && Number.isFinite(gesture) && gesture >= askedFrom ? [clip(askedFrom), clip(gesture)] : null;
  const busy = union(human ? [...spans, human] : spans);
  const minutes = (ms) => Math.round(ms / 6000) / 10;
  return {
    total: minutes(end - start),
    working: minutes(working),
    humanWait: human ? minutes(human[1] - human[0]) : null,
    machineWait: minutes(Math.max(0, end - start - busy)),
    humanFrom: human ? (Number.isFinite(Date.parse(notifiedAt)) ? 'notification' : 'card') : null,
  };
}

export const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
};

// The median time from Todo to Done of the tickets merged in the last days,
// by lane, from the ticket_measured events.
export function lanesMedian(db, { now = Date.now(), days = 7 } = {}) {
  // The stamps are compared as dates: the ledger holds more than one ISO form.
  const rows = db.prepare("SELECT value, detail, at FROM events WHERE kind = 'ticket_measured'").all()
    .filter((row) => Date.parse(row.at) >= now - days * 86400e3).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const by = { fast: [], full: [] };
  for (const row of rows) {
    let lane = 'full';
    try { lane = JSON.parse(row.detail ?? '{}').lane === 'fast' ? 'fast' : 'full'; } catch { /* an unreadable detail counts as full */ }
    if (Number.isFinite(row.value)) by[lane].push(row.value);
  }
  return { days, fast: { minutes: median(by.fast), count: by.fast.length }, full: { minutes: median(by.full), count: by.full.length } };
}

// Stamps are compared as dates, never as text: the ledger holds more than one ISO form.
const since = (rows, after) => rows.filter((row) => !Number.isFinite(Date.parse(after)) || Date.parse(row.at) >= Date.parse(after))
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

function gestureTime(db, ticket, after, conf) {
  const clears = since(db.prepare("SELECT at, detail FROM events WHERE kind = 'app_gesture' AND ticket = ?").all(ticket), after);
  for (const row of clears) {
    try { const detail = JSON.parse(row.detail ?? '{}'); if (detail.gesture === 'clear' && detail.result === 'written') return row.at; } catch { /* not one */ }
  }
  // His move in the tracker's history, where the tracker keeps one.
  try {
    const go = section(conf, 'tracker').go_state;
    const history = JSON.parse(execFileSync(join(ORCH_HOME, 'tracker.ts'), ['history', ticket], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const move = [...history].reverse().find((entry) => entry.status === go && entry.by?.kind === 'human' && (!after || entry.at >= after));
    if (move) return move.at;
  } catch { /* a tracker that keeps no history: the human's wait is not measured */ }
  return null;
}

export function measure(ticket, pr, lane, { conf = loadConf(), now = () => new Date().toISOString() } = {}) {
  assertService();
  const db = openLedger(ledgerPath());
  try {
    const record = readRecord(ticket) ?? {};
    // Known only from the tracker's own stamp (todo_at): an unknown Todo is not guessed from the opening.
    const todoAt = record.todo_at ?? null;
    const merges = db.prepare("SELECT at FROM events WHERE kind = 'merged_by_script' AND ticket = ? AND value = ?").all(ticket, Number(pr))
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    const doneAt = merges[0]?.at ?? now();
    let cardAt = null;
    try { cardAt = JSON.parse(readFileSync(join(stateDir(), 'validations', `${ticket}.json`), 'utf8')).at ?? null; } catch { /* never asked: a change that needed no agreement */ }
    let notifiedAt = null;
    for (const row of cardAt ? since(db.prepare("SELECT at, detail FROM events WHERE kind = 'notification_sent' AND ticket = ?").all(ticket), cardAt) : []) {
      try { if (JSON.parse(row.detail ?? '{}').event === 'approval') { notifiedAt = row.at; break; } } catch { /* not one */ }
    }
    const gestureAt = cardAt ? gestureTime(db, ticket, cardAt, conf) : null;
    const runs = todoAt ? since(db.prepare('SELECT started_at, ended_at FROM runs WHERE ticket = ?').all(ticket).map((run) => ({ ...run, at: run.started_at })), todoAt) : [];
    const measured = todoAt ? measureTicket({ todoAt, doneAt, runs, cardAt, notifiedAt, gestureAt }) : null;
    if (!measured) return null;
    addEvent(db, { kind: 'ticket_measured', ticket, value: measured.total, detail: JSON.stringify({ lane: lane === 'fast' ? 'fast' : 'full', pr: Number(pr), todo_at: todoAt, done_at: doneAt,
      working_min: measured.working, human_wait_min: measured.humanWait, machine_wait_min: measured.machineWait, human_wait_from: measured.humanFrom }) });
    return measured;
  } finally { db.close(); }
}

if (runAsCommand(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'opening') {
      // The lane on the first line; on a second, the marks set by somebody
      // else than the user, which picked nothing (spawn-lane.sh keeps them in the ledger).
      let lane = 'full';
      let ignored = [];
      try {
        const conf = loadConf();
        const settings = fastSettings(conf);
        const issue = JSON.parse(readFileSync(0, 'utf8'));
        ({ lane, ignored } = openingFor(conf, settings, issue));
      } catch (error) { process.stderr.write(`fast-lane: ${error.message}: the ticket takes the full circuit\n`); }
      process.stdout.write(`${lane}\n${ignored.length ? `not set by the user, so not fast: ${ignored.join('; ')}\n` : ''}`);
    } else if (command === 'decide') {
      if (args.length !== 2) throw new Error('usage: fast-lane.ts decide <lane key> <commit>');
      process.stdout.write(`${decide(args[0], args[1]).state}\n`);
    } else if (command === 'check') {
      if (args.length !== 2) throw new Error('usage: fast-lane.ts check <lane key> <commit>');
      process.stdout.write(`${decide(args[0], args[1], { write: false }).state}\n`);
    } else if (command === 'demote') {
      if (args.length !== 2) throw new Error('usage: fast-lane.ts demote <lane key> <reason>');
      demote(args[0], args[1]);
    } else if (command === 'targeted') {
      if (args.length !== 2) throw new Error('usage: fast-lane.ts targeted <lane key> <commit>');
      const argv = targeted(args[0], args[1]);
      if (!argv) process.exitCode = 3;
      else process.stdout.write(argv.map((word) => `${word}\0`).join(''));
    } else if (command === 'record-write') {
      // Internal: the rewrite writeRecord runs under the lock it holds.
      assertService();
      rewriteRecord(args[0], JSON.parse(readFileSync(0, 'utf8')));
    } else if (command === 'tests-done') {
      testsDone(args[0], args[1], args[2]);
    } else if (command === 'measure') {
      if (args.length !== 3 || !existsSync(stateDir())) throw new Error('usage: fast-lane.ts measure <ticket> <pr> <fast|full>');
      measure(args[0], args[1], args[2]);
    } else throw new Error('usage: fast-lane.ts opening | decide | check | demote | targeted | tests-done | measure');
  } catch (error) {
    process.stderr.write(`fast-lane: ${error.message}\n`);
    process.exitCode = 1;
  }
}
