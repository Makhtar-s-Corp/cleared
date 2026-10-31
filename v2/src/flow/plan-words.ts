// A plan's step is written for a person (issue #501): no command name, no file
// name, no path. One check, read by the tool that refuses such a plan
// (flow/engine.ts) and by the screens that fold what still comes through (an
// older session, a plan the author would not reword). No import: the web app
// runs it too.
//
// It reads the shape of the words, so it can be wrong. A false alarm costs one
// refused plan, and a person's sentences ("et/ou", "JJ/MM/AAAA", "make sure",
// "Node.js") are its tests. A word that is both a program and a common word
// counts only with what makes it a command ("make test", not "make sure").

const EXTENSIONS = 'tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|html|ya?ml|toml|ini|conf|lock|xml|svg|png|jpe?g|sql|txt|csv|log|py|go|rs|rb|java|kt|php|swift|sh|vue|svelte|ipynb';
const FILE = new RegExp(`(?<![\\w@])[\\w.-]*\\w\\.(?:${EXTENSIONS})(?![\\w-])`, 'i');
// Products written like a file.
const PRODUCTS = /\b(?:node|next|nuxt|vue|react|express|three|d3)\.js\b/gi;
const NAMED_FILE = /\b(?:Dockerfile|Makefile|Procfile|Gemfile)\b/;
const DOTFILE = /(?:^|[\s("'])\.[a-z][\w.-]*/;

const PROGRAMS = /(?<![\w-])(?:npm|npx|pnpm|yarn|pytest|vitest|jest|eslint|prettier|tsc|sudo|curl|wget|grep|chmod|chown|mkdir|rmdir|psql|pip3?|gradle|mvn|dotnet|terraform|gh)(?![\w-])/i;
const SUBCOMMANDS = /(?<![\w-])(?:git (?:status|diff|log|add|commit|push|pull|checkout|rebase|merge|stash|clone|fetch|reset|branch|switch|restore|cherry-pick|show|tag)|go (?:test|build|run|mod|vet|get|fmt)|make (?:test|build|install|clean|lint|all|check|dev)|cargo (?:test|build|run|add|check)|docker (?:compose|build|run|ps|exec|pull|push|logs)|deno (?:run|test|task)|bun (?:run|test|install|add))(?![\w-])/;
// In a code span, the bare name of a program is a command too.
const BARE_PROGRAM = /^(?:git|go|make|cargo|docker|deno|bun|node|python3?|ls|cat|rm|mv|cp|cd|sed|awk)$/;
const FLAG = /(?:^|\s)--?[a-zA-Z][\w-]*/;
const SHELL = /&&|\|\||\$\(|\s\|\s|(?:^|\s)[A-Z][A-Z0-9_]+=\S/;
const CODE_SPAN = /`([^`]+)`/g;

const FOLDERS = new Set(['src', 'lib', 'tests', 'docs', 'dist', 'packages', 'scripts', 'config', 'node_modules', 'bin', 'components', 'migrations']);
// A date, or a date's format: jj/mm/aaaa, dd/mm/yyyy, 31/10/2026.
const DATE_PART = /^(?:\d+|j{1,2}|d{1,2}|m{1,2}|a{2,4}|y{2,4}|h{1,2}|s{1,2})$/i;

function isPath(word: string): boolean {
  if (!word.includes('/')) return false;
  if (/^[a-z][a-z+.-]*:\/\//i.test(word)) return true;
  if (/^(?:~|\.{1,2})?\/./.test(word)) return true;
  const parts = word.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.every((part) => DATE_PART.test(part)) || word === word.toUpperCase()) return false;
  return parts.length >= 3 || FOLDERS.has(parts[0] as string);
}

// The words of a sentence without what surrounds them: quotes, brackets, a final comma.
const wordsOf = (text: string): string[] =>
  text.split(/\s+/).map((word) => word.replace(/^[("'«`[]+/, '').replace(/[)"'»`\],;:!?]+$/, '').replace(/\.$/, '')).filter(Boolean);

function codeSpanIsCommand(text: string): boolean {
  for (const [, span] of text.matchAll(CODE_SPAN)) {
    const code = (span as string).trim();
    if (/\s/.test(code) || BARE_PROGRAM.test(code)) return true;
  }
  return false;
}

export function isTechnical(text: string): boolean {
  if (codeSpanIsCommand(text)) return true;
  const plain = text.replaceAll('`', ' ').replace(PRODUCTS, ' ');
  return FILE.test(plain) || NAMED_FILE.test(plain) || DOTFILE.test(plain)
    || PROGRAMS.test(plain) || SUBCOMMANDS.test(plain) || FLAG.test(plain) || SHELL.test(plain)
    || wordsOf(plain).some(isPath);
}

// The numbers of a plan's technical steps, from one.
export const technicalSteps = (steps: readonly string[]): number[] =>
  steps.flatMap((step, index) => (isTechnical(step) ? [index + 1] : []));
