// What the ledger's MCP server shows of a stored text: the session cleaner's
// filter (session/clean.ts cleanText: the guard's patterns, the secret
// values of the environment, the service's folders), then the token
// families the guard does not name, then a cut. Events are cleaned before
// they are stored, but a row may predate a pattern, or come from a writer
// that did not clean it: the server cleans again at every read.
import { COMMAND_OUTPUT_LIMIT, GENERATED_ID, GUARD_PATTERNS, ID_KEYS, cleanText, secretValues, type CleanOptions } from '../session/clean.ts';

// Characters of one string that are shown: the rest is cut, after cleaning,
// so that a secret is never shown in part. A search answer shows a part, a
// timeline as much as a command's output keeps (session/clean.ts
// COMMAND_OUTPUT_LIMIT). A search reads the whole cleaned text.
export const TEXT_LIMIT = 1000;
export const TIMELINE_TEXT_LIMIT = COMMAND_OUTPUT_LIMIT;

const removed = (what: string) => `[removed: ${what}]`;

// [category, pattern], each a whole token: the prefixes lib/board-scrub.ts
// knows, and the forms GitHub, Slack, Linear, AWS, Google, Stripe and npm
// give their keys. A prefix this distinctive is looked for even glued to
// other letters (a word boundary would miss "keyghp_..."); the guard's
// `sk-` keeps its boundary, which "task-management-..." needs.
export const TOKEN_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})/g],
  ['Slack token', /xox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['Linear key', /lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g],
  ['AWS key', /(?:AKIA|ASIA)[A-Z0-9]{16}/g],
  ['Google key', /AIza[0-9A-Za-z_-]{35}/g],
  ['Stripe key', /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['npm token', /npm_[A-Za-z0-9]{36}/g],
  ['JSON web token', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
];

// What a cleaning writes in a text's place, as the words after "[": a search
// for a marker, or a part of one, is matched on the cleaned text, which a
// LIKE on the stored text cannot do (history.ts). The categories are the
// guard's and the token families' above, then the cleaner's own
// (session/clean.ts cleanText) and the two below.
export const MARKER_TEXTS: readonly string[] = [
  ...GUARD_PATTERNS.map(([category]) => category),
  ...TOKEN_PATTERNS.map(([category]) => category),
  'secret', 'service path', 'private key', 'application token', 'private term', 'environment value', 'address parameter',
].map((category) => `removed: ${category}`);

// A value given to a variable whose name says it is a secret, anywhere in a
// line (the guard finds it only at the start of one), and a secret in an
// address's query: the name is kept, the value removed. The name holds the
// word as part of a longer one (PGPASSWORD, SSHPASS, APIKEY), since a miss
// shows a secret and an extra match only hides a value; INNOCENT_WORDS are
// the words that hold those letters and are none (BYPASS_MODE=1).
const ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|PEPPER)[A-Z0-9_]*)=(?!\[removed)(?:"[^"]*"|'[^']*'|[^\s"'`]+)/g;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|AUTH|PEPPER/;
const INNOCENT_WORDS = /BYPASS|COMPASS|PASSENGER|PASSIVE|PASSAGE|PASSTHROUGH|AUTHORS?(?![A-Z])|KEYBOARD|KEYMAP|KEYWORDS?|MONKEY|DONKEY|TURKEY|HOTKEY/g;
const QUERY = /([?&](?:access_token|token|api_?key|key|secret|password|sig|signature|code)=)(?!\[removed)[^&\s"'#]+/gi;

export type Redactor = {
  // A text cleaned and cut to TEXT_LIMIT.
  text(value: string): string;
  // A JSON value cleaned string by string, and cut to TEXT_LIMIT: an id of
  // the generated shape in an id's place is kept whole, `rawEvent` is dropped.
  value(value: unknown, key?: string): unknown;
  // The same, not cut: what a search reads. Cut it with cutStrings to show it.
  whole(value: unknown, key?: string): unknown;
  // Whether cleaning changes this text: a search term shaped like a secret.
  changes(value: string): boolean;
};

export type RedactorOptions = {
  readonly env: NodeJS.ProcessEnv;           // its secret values are removed (secretValues)
  readonly paths: readonly string[];         // the ledger's folder, and any other folder of the service
};

function cut(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')} [cut: ${chars.length - limit} characters]`;
}

// Every string of a cleaned JSON value cut to the limit.
export function cutStrings(value: unknown, limit: number = TEXT_LIMIT): unknown {
  if (typeof value === 'string') return cut(value, limit);
  if (Array.isArray(value)) return value.map((entry) => cutStrings(entry, limit));
  if (typeof value !== 'object' || value === null) return value;
  return named(Object.entries(value).map(([name, entry]) => [cut(name, limit), cutStrings(entry, limit)]));
}

// An object from entries whose names may have become the same by cleaning or
// cutting: the later ones are numbered, so that no value is lost.
function named(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const used = new Set<string>();
  return Object.fromEntries(entries.map(([name, entry]) => {
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name} (${n})`;
    used.add(unique);
    return [unique, entry];
  }));
}

export function createRedactor(options: RedactorOptions): Redactor {
  const servicePaths = [...new Set([...options.paths, options.env.CLEARED_V2_STATE_DIR, options.env.HOME].filter((p): p is string => !!p && p !== '/'))];
  // The secret values at each text: the test secrets (C16) are set while the service runs.
  const clean = (): CleanOptions => ({ secrets: secretValues(options.env), servicePaths });
  const tokens = (text: string): string => {
    let out = text;
    for (const [category, pattern] of TOKEN_PATTERNS) out = out.replace(pattern, removed(category));
    return out.replace(ASSIGNMENT, (match, name: string) => (SECRET_NAME.test(name.replace(INNOCENT_WORDS, '_')) ? `${name}=${removed('environment value')}` : match)).replace(QUERY, `$1${removed('address parameter')}`);
  };
  const full = (text: string): string => tokens(cleanText(text, clean()));
  // The guard's patterns read the digits of a UUID as a phone number, so an
  // id passes whole when it has the generated shape; a token of that shape
  // (ghp_...) is still a token.
  const id = (value: string): string => (GENERATED_ID.test(value) && tokens(value) === value ? value : full(value));
  const whole = (item: unknown, key = ''): unknown => {
    if (typeof item === 'string') return ID_KEYS.has(key) ? id(item) : full(item);
    if (Array.isArray(item)) return item.map((entry) => whole(entry));
    if (typeof item !== 'object' || item === null) return item;
    // A name is decided on as it is stored (an id's key, rawEvent), and shown cleaned.
    return named(Object.entries(item).filter(([name]) => name !== 'rawEvent').map(([name, entry]) => [full(name), whole(entry, name)]));
  };
  return {
    text: (value) => cut(full(value), TEXT_LIMIT),
    value: (item, key) => cutStrings(whole(item, key)),
    whole,
    changes: (term) => full(term) !== term,
  };
}
