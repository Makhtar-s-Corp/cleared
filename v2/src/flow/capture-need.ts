// Whether a ticket's change needs the proof receipt's captures before and
// after (issue #368, matrix P226, after P210): only when the diff changes
// something a person sees, its components, styles, displayed words and
// their catalogs, page routes, templates and the assets a page draws; none
// for a change of the backend alone, of tests, of CI or of docs. The
// human's choice on the ticket (flow/capture-choice.ts) wins over the rule.
// A diff that could not be read is captured: a capture too many costs a
// minute, a missing one loses the proof.
//
// Pure, on the paths of the diff as the pull request shows them (relative
// to the repository's root, `/` between folders). What the rule cannot see
// in a path (a page rendered by a server file not named for it) is the
// human's to force on.
import { posix } from 'node:path';

export const CAPTURE_CHOICES = ['auto', 'on', 'off'] as const;
export type CaptureChoiceName = (typeof CAPTURE_CHOICES)[number];

// `screens`, the change touches what a person sees; `no_screen`, it does
// not; `forced_on` and `forced_off`, the human's choice on the ticket;
// `unread`, the diff could not be read, so the captures are taken.
export type CaptureReason = 'screens' | 'no_screen' | 'forced_on' | 'forced_off' | 'unread';
export type CaptureNeed = { readonly take: boolean; readonly reason: CaptureReason; readonly screens: readonly string[] };

// Folders whose files no person sees: tests, CI, docs.
const HIDDEN_FOLDERS = new Set(['test', 'tests', '__tests__', '__snapshots__', '__mocks__', 'spec', 'e2e', 'fixtures', 'docs', 'doc', '.github', '.gitlab', '.circleci', '.buildkite', '.storybook']);
const HIDDEN_FILE = /(?:\.(?:test|spec|stories|story)\.[^.]+|\.snap|\.md|\.mdx|\.rst|\.adoc)$|^(?:\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|CHANGELOG|LICENSE|AUTHORS)(?:\..*)?$/i;
// A server's own file inside a routes folder: SvelteKit's +server.ts and +page.server.ts, Remix's .server.ts.
const SERVER_FILE = /(?:^|[.+])server\.[cm]?[jt]s$/;

// Drawn whatever its folder: components, styles, markup, templates, and the assets and fonts a page loads.
const VISIBLE_EXT = new Set([
  '.tsx', '.jsx', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.sass', '.less', '.styl', '.pcss',
  '.html', '.htm', '.ejs', '.hbs', '.handlebars', '.mustache', '.njk', '.pug', '.liquid', '.erb', '.twig', '.jinja', '.j2', '.haml', '.slim',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf',
]);
// The words a screen shows: a catalog file anywhere, or a data file in a catalogs' folder.
const CATALOG_EXT = new Set(['.po', '.pot', '.ftl', '.xlf', '.xliff', '.arb']);
const CATALOG_FOLDERS = new Set(['i18n', 'l10n', 'locale', 'locales', 'lang', 'langs', 'messages', 'translations']);
const DATA_EXT = new Set(['.json', '.yaml', '.yml', '.toml', '.properties']);
// Page routes and views: their code files draw a page, an `api` folder's do not.
const SCREEN_FOLDERS = new Set(['screens', 'pages', 'routes', 'views', 'layouts', 'components', 'templates']);
const CODE_EXT = new Set(['.ts', '.js', '.mjs', '.cjs', '.py', '.rb', '.php', '.go', '.ex', '.exs']);
// A file named for what it draws: the guestbook's src/page.ts, Next's page.tsx and layout.tsx, SvelteKit's +page.ts.
const PAGE_NAME = /^\+?(?:page|layout|view|template)$/;

const extOf = (name: string) => posix.extname(name).toLowerCase();

export function visiblePath(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  const name = parts.at(-1) ?? '';
  const folders = parts.slice(0, -1);
  if (folders.some((folder) => HIDDEN_FOLDERS.has(folder.toLowerCase())) || HIDDEN_FILE.test(name)) return false;
  const ext = extOf(name);
  if (VISIBLE_EXT.has(ext) || CATALOG_EXT.has(ext)) return true;
  if (DATA_EXT.has(ext)) return folders.some((folder) => CATALOG_FOLDERS.has(folder.toLowerCase()));
  if (!CODE_EXT.has(ext) || SERVER_FILE.test(name) || folders.includes('api')) return false;
  return PAGE_NAME.test(posix.basename(name, ext)) || folders.some((folder) => SCREEN_FOLDERS.has(folder.toLowerCase()));
}

// The screen a visible path belongs to: the folder under `screens/`, a
// catalog's screen (`session.fr.json` is the session screen's words), the
// page a `pages/` or `routes/` file is, else the file's own name.
export function screenOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const name = parts.at(-1) ?? path;
  const under = parts.findIndex((part) => part === 'screens' || part === 'pages' || part === 'routes');
  if (under >= 0 && under < parts.length - 1) {
    const next = parts[under + 1] as string;
    return under + 1 === parts.length - 1 ? posix.basename(next, extOf(next)) : next;
  }
  const catalog = name.match(/^([^.]+)\.[a-z]{2}(?:[-_][A-Za-z]{2})?\.(?:json|ya?ml|po|ftl|properties)$/);
  if (catalog && parts.slice(0, -1).some((folder) => CATALOG_FOLDERS.has(folder.toLowerCase()))) return catalog[1] as string;
  return name;
}

// The screens of the visible paths, each once, in the diff's order.
export function screensOf(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(visiblePath).map(screenOf))];
}

// `paths` undefined: the diff could not be read.
export function captureNeed(paths: readonly string[] | undefined, choice: CaptureChoiceName = 'auto'): CaptureNeed {
  const screens = paths ? screensOf(paths) : [];
  if (choice === 'on') return { take: true, reason: 'forced_on', screens };
  if (choice === 'off') return { take: false, reason: 'forced_off', screens };
  if (!paths) return { take: true, reason: 'unread', screens };
  return screens.length > 0 ? { take: true, reason: 'screens', screens } : { take: false, reason: 'no_screen', screens };
}
