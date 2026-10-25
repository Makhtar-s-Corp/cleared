// Notifications to the human: one interface for the dispatcher, the app and
// the adapters. Other Cleared code imports only this file.
//
// What may be said is fixed here, not by whoever caused the event. A
// notification is built from an allow-list of facts the dispatcher knows (the
// kind, the ticket's identifier, its title, a health code, a number of minutes)
// and the message catalog; the ticket's title is the only text from outside,
// and it is filtered (sanitize). The detail of a ledger event, a team's
// question, a report or a ticket's body never reach a notification.
//
// An adapter is { name, ready() -> null | reason code, send(message, { signal }) -> Promise },
// message = { kind, ticket, group, title, body, url, urgent }; signal, when
// given, aborts what is still on its way (the dispatcher's deadline). Each
// adapter gets its network or process call injected (a test gives a fake one).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { message as catalog } from '../i18n.ts';
import { scrub } from '../board-scrub.ts';
import { expandHome, section } from '../conf.ts';
import { webpushAdapter } from './adapters/webpush.ts';
import { ntfyAdapter } from './adapters/ntfy.ts';
import { emailAdapter, sendmailDefault } from './adapters/email.ts';
import { telegramAdapter } from './adapters/telegram.ts';

// The events that notify. More may come (a kind is added here, to the catalog
// and to the dispatcher's sources); a kind nobody knows is never sent.
// permission and plan are v2's (docs/v2/milestone-2-plan.md, section 6);
// blocked is v1's only.
export const KINDS = ['approval', 'question', 'rollback', 'health', 'blocked', 'permission', 'plan'];
// Never held by the quiet hours.
export const URGENT = ['rollback', 'health'];
// The most pressing first: of several things that wait for one ticket, the
// first of this list is told and the others are folded into it.
export const URGENCY = ['rollback', 'health', 'approval', 'plan', 'question', 'permission', 'blocked'];
export const ADAPTERS = ['webpush', 'ntfy', 'email', 'telegram'];
// The health codes a notification can name (heartbeat problems and release
// watch outcomes). Anything else is "a health problem", with no name.
export const HEALTH_CODES = ['wake_late', 'wake_failed', 'wake_missing', 'lead_stuck', 'pending_stalled', 'service_unreachable', 'lane_idle', 'orphan_process',
  'diagnostic_failed', 'forge_credential', 'heavy_lock_invalid', 'release_health_failing', 'rollback_health_still_failing', 'release_watch_failed',
  'rollback_failed', 'rollback_migrations_blocked', 'rollback_ambiguous_base', 'lead_start_failed', 'week_stop', 'schedule_failed',
  'quota_75', 'quota_85', 'quota_read_failed'];
const TICKET = /^[A-Za-z0-9._-]{1,40}$/;

export const defaultSecretsDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleared', 'notify');

// A name that is a file, not a host. Its extension is not a top-level domain
// (app.test.ts, agents.conf), or it is one of the usual files whose extension
// also names a country (README.md, install.ts, setup.py, main.rs: .md, .sh,
// .py and .rs are domains, so mycorp.sh or ntfy.sh is a host).
const FILE_EXTENSION = /\.(?:exe|mjs|cjs|js|jsx|tsx|ts|json|conf|cfg|ini|txt|yml|yaml|log|pdf|png|jpe?g|svg|lock|env|toml|html|css|csv|rb|go|sql|bash|zsh)$/i;
const USUAL_FILE = /^(?:readme|changelog|contributing|license|security|authors|todo|notes|install|setup|build|deploy|test|tests|run|start|main|index|lib|mod|init|wake|conftest|manage|cargo)\.(?:md|sh|py|rs)$/i;
const fileName = (name) => FILE_EXTENSION.test(name) || USUAL_FILE.test(name);

// Text from outside (a ticket's title) as a notification may carry it: no
// link, path, address, key, token, password, e-mail, amount or long number,
// no invisible or direction-changing character, on one line, cut short.
// pairs = false: the second pass over a rendered sentence, where a title ending
// in "token" is followed by the catalog's own colon, not by a value.
export function sanitize(text, max = 80, { pairs = true } = {}) {
  // Cut before any pattern runs: a title of many kilobytes costs nothing, and what is past 500 characters is never shown.
  const flat = scrub(String(text ?? '').slice(0, 500).normalize('NFKC').replace(/\u3002/g, '.'), 500)
    .replace(/\s*\[amount\]\s*/g, ' [amount] ')
    .replace(/[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(pairs ? /\b(?:pass(?:word)?|passwd|pwd|pw|mdp|mot\s+de\s+passe|secret|token|api[_-]?key|key|cl[\u00E9e]|authorization)\s*[:=]\s*\S+|\b(?:pass(?:word)?|passwd|pwd|pw|mdp|mot\s+de\s+passe)\s+(?=\S*\d)\S+|\b(?:bearer|basic)\s+\S+/gi : /(?!)/g, '[secret]')
    // Credentials in an address (user:pass@host), before the e-mail rule takes the part after the colon.
    .replace(/\b[\w.+-]+:[^\s/@]+@\S+/g, '[secret]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\S*/g, '[path]')
    .replace(/(?:\b[A-Za-z]:)?\\\S*/g, '[path]')
    .replace(/\S*\/\S*\/\S*/g, '[path]')
    .replace(/(?:^|(?<=\s))[.~]\S*\/\S*/g, '[path]')
    .replace(/\S*\/\S*\.[A-Za-z0-9]{1,8}\b/g, '[path]')
    // IPv4, and IPv6 whole: the compressed form has a "::" (a lone "12:30" is no address).
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|[0-9a-f:]*::[0-9a-f:]*)(?![\w:])/gi, '[address]')
    // A bare domain or a host name (www.x.io, db.internal, пример.рф, bücher.de, xn--p1ai, svc_api.corp.net): a dot and a last label of letters. A file name is kept (fileName).
    .replace(/(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}_-]+\.)+(?:xn--[\p{L}\p{N}-]+|\p{L}{2,})(?![\p{L}\p{N}_-])/giu, (name) => (fileName(name) ? name : '[host]'))
    // Slack and similar tokens (xoxb-123-456, xapp-...), whatever their length.
    .replace(/\bxox[abposr]-[\w-]+|\bxapp-[\w-]+/gi, '[secret]')
    .replace(/\b[A-Za-z0-9+_-]{24,}={0,2}/g, '[secret]')
    .replace(/\b[0-9a-f]{16,}\b|\b0x[0-9a-f]+\b/gi, '[secret]')
    // A social security number (123-45-6789) and a card number in groups of four (4111-1111-1111-1111).
    .replace(/\b\d{3}-\d{2}-\d{4}\b|\b\d{4}(?:-\d{4}){3}\b/g, '[number]')
    .replace(/\d+[.,]\d+(?:[.,]\d+)*/g, '[number]')
    .replace(/\d(?:[\s ']?\d){4,}/g, '[number]')
    .replace(/[<>`\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const minutes = (value, key, fallback, low = 0, high = 1440) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < low || n > high) throw new Error(`[notify] ${key} must be a whole number of minutes from ${low} to ${high}`);
  return n;
};
const list = (value) => String(value ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const clock = (text) => {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// "22:00-07:00": the minutes of the day they start and end, or null when unset.
export function quietHours(value) {
  if (!value || value === 'none') return null;
  const [from, to, extra] = String(value).split('-').map((x) => x.trim());
  const start = clock(from ?? ''), end = clock(to ?? '');
  if (extra !== undefined || start === null || end === null || start === end) throw new Error('[notify] quiet_hours must read like 22:00-07:00');
  return { start, end };
}
// The service's own settings that a project must not choose: where the links
// point, which push hosts are trusted and which mail program runs. They come
// from the service's environment (CLEARED_NOTIFY_*, as CLEARED_NOTIFY_TELEGRAM_API),
// never from agents.conf, which a project's agent can change.
const serviceEnv = (env, name) => env[`CLEARED_NOTIFY_${name}`] || env[`ORCH_NOTIFY_${name}`] || '';
// The settings of [notify]. Nothing here is a secret: those stay in the private directory.
export function notifySettings(conf, env = process.env) {
  const s = section(conf, 'notify');
  const adapters = list(s.adapters ?? 'webpush').filter((a) => a !== 'none');
  for (const name of adapters) if (!ADAPTERS.includes(name)) throw new Error(`[notify] adapters: unknown adapter "${name}" (known: ${ADAPTERS.join(', ')})`);
  const events = list(s.events ?? KINDS.join(','));
  for (const kind of events) if (!KINDS.includes(kind) && kind !== 'none') throw new Error(`[notify] events: unknown event "${kind}" (known: ${KINDS.join(', ')})`);
  const timezone = s.timezone || section(conf, 'dashboard').timezone || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error(`[notify] timezone: unknown time zone "${timezone}"`); }
  const linkBase = serviceEnv(env, 'LINK_BASE').replace(/\/+$/, '');
  let base = '';
  try { const url = new URL(linkBase); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) base = url.origin; } catch { /* no link */ }
  const configuredSendmail = serviceEnv(env, 'SENDMAIL');
  if (configuredSendmail && !configuredSendmail.startsWith('/')) throw new Error('CLEARED_NOTIFY_SENDMAIL must be an absolute path');
  // Null when none of the well-known mail programs is there: the e-mail adapter is then not ready.
  const sendmail = configuredSendmail || sendmailDefault();
  // How long one dispatch may send before what is left waits for the next wake (it runs inside the wake's lock).
  const deadline = serviceEnv(env, 'DEADLINE_SECONDS') || '30';
  // Capped below wake.ts's 60-second kill, so the dispatcher ends by itself.
  if (!/^\d{1,3}$/.test(deadline) || Number(deadline) < 1 || Number(deadline) > 50) throw new Error('CLEARED_NOTIFY_DEADLINE_SECONDS must be a whole number of seconds from 1 to 50');
  return {
    adapters, events: events.filter((kind) => KINDS.includes(kind)),
    quiet: quietHours(s.quiet_hours), timezone,
    coalesceMinutes: minutes(s.coalesce_minutes, 'coalesce_minutes', 10),
    blockedMinutes: minutes(s.blocked_minutes, 'blocked_minutes', 30, 1, 10080),
    linkBase: base,
    secretsDir: expandHome(s.secrets_dir) || defaultSecretsDir(),
    // Who the push services may write to about this service (RFC 8292): an e-mail or the app's address.
    subject: s.vapid_subject || (base.startsWith('https://') ? base : ''),
    pushHosts: list(serviceEnv(env, 'PUSH_HOSTS')).map((h) => h.toLowerCase()),
    sendmail,
    deadlineMs: Number(deadline) * 1000,
    language: section(conf, 'owner').language === 'fr' ? 'fr' : 'en',
  };
}

// Whether `at` falls in the quiet hours, read on the configured clock.
export function isQuiet(settings, at = Date.now()) {
  if (!settings.quiet) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  const { start, end } = settings.quiet;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// The notification for one occurrence. Only these fields are read:
// kind, ticket, title, code, minutes, from. Anything else it carries is
// ignored. from = 'lead': a question of the project lead, which has its own
// sentence (it is no team's, and has no ticket).
export function render({ kind, ticket, title, code, minutes: waited, from }, { language = 'en', linkBase = '' } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown notification kind ${kind}`);
  const id = TICKET.test(String(ticket ?? '')) ? String(ticket) : '';
  const name = sanitize(title, 80);
  const subject = id ? (name ? `${id} · ${name}` : id) : name;
  const health = HEALTH_CODES.includes(code) ? code : 'other';
  const values = { subject: subject || catalog('notify_no_subject', language), minutes: Number.isSafeInteger(waited) && waited >= 0 ? waited : '',
    problem: catalog(`notify_health_${health}`, language) };
  const text = (key) => catalog(key, language, values);
  const lead = kind === 'question' && from === 'lead';
  const heading = text(lead ? 'notify_question_lead_title' : `notify_${kind}_title`);
  const body = text(lead ? 'notify_question_lead_body' : kind === 'health' ? (subject ? 'notify_health_body_ticket' : 'notify_health_body') : `notify_${kind}_body`);
  return {
    kind, ticket: id || null, group: id || (kind === 'rollback' ? 'rollback:none' : `health:${health}`), urgent: URGENT.includes(kind),
    // Said twice through the filter: the catalog's words are known, the title is not.
    title: sanitize(heading, 60, { pairs: false }), body: sanitize(body, 180, { pairs: false }),
    // The ticket's porthole in the app (the part after # never reaches a server's log).
    url: linkBase && id ? `${linkBase}/#ticket=${encodeURIComponent(id)}` : linkBase ? `${linkBase}/` : null,
  };
}

// The one notification nothing caused: `notify.ts test`, to check a setup. Fixed words, no ticket.
export function testMessage({ language = 'en', linkBase = '' } = {}) {
  return { kind: 'test', ticket: null, group: 'test', urgent: false, title: catalog('notify_test_title', language), body: catalog('notify_test_body', language), url: linkBase ? `${linkBase}/` : null };
}

// The adapters [notify] adapters names, each with what it needs injected.
export function createAdapters(settings, { store, transport = fetch, run } = {}) {
  return settings.adapters.map((name) => {
    if (name === 'webpush') return webpushAdapter({ store, subject: settings.subject, extraHosts: settings.pushHosts, transport });
    if (name === 'ntfy') return ntfyAdapter({ credentials: () => store.credentials('ntfy'), transport });
    if (name === 'telegram') return telegramAdapter({ credentials: () => store.credentials('telegram'), transport });
    return emailAdapter({ credentials: () => store.credentials('email'), sendmail: settings.sendmail, ...(run ? { run } : {}) });
  });
}
