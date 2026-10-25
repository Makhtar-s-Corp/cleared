// The GitHub mirror's doctor section (issue #400, docs/v2/milestone-4-plan.md
// section 12), run by `node scripts/doctor.ts mirror`. It reads the mirror's
// settings as the service does (loadMirrorConfig), the token file without
// ever printing it, each repository of the workspace's services and its
// status labels through GitHubTracker, and the mirror's last full pass from
// the service's ledger, opened read-only. It writes nothing, on GitHub or in
// the ledger. Its words are messages/mirror-doctor.<language>.json, over the
// shell's units of time, in CLEARED_V2_APP_LANGUAGE (French by default).
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Translate } from '../../app/web/lib/i18n.ts';
import { ago, duration, lasted } from '../../app/web/lib/time.ts';
import { readLockConf } from '../approval/conf.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import { HeartbeatConfigError, readHeartbeatSettings } from '../heartbeat/settings.ts';
import { ledgerPath } from '../store/db.ts';
import { GitHubTracker } from './mirror-github.ts';
import { MIRROR_MESSAGES_DIR, MirrorConfigError, loadMirrorConfig } from './mirror.ts';
import { TRACKER_TIMEOUT_MS, TrackerError } from './mirror-tracker.ts';

// pass and fail count for the doctor; a notice is said and never fails;
// off: the mirror is not set up, so nothing ran.
export type MirrorCheck = { readonly level: 'pass' | 'fail' | 'notice' | 'off'; readonly text: string };

const FILE_VARIABLE = 'CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE';
// The heartbeat's default, when its own setting is refused (the status says why).
const STALE_MINUTES = 10;
// A role that labels and closes an issue: triage is the least of them.
const WRITERS = ['admin', 'maintain', 'push', 'triage'];

export function mirrorDoctorTranslator(language: Language): Translate {
  const read = (lang: Language) => JSON.parse(readFileSync(`${MIRROR_MESSAGES_DIR}mirror-doctor.${lang}.json`, 'utf8')) as Record<string, string>;
  return translator({ ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) });
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The last full pass of each tracker, from the ledger opened read-only; an
// error when the ledger cannot be read, none for a tracker with no pass.
function lastPasses(env: NodeJS.ProcessEnv): Map<string, string> | Error {
  let db: DatabaseSync | undefined;
  try {
    const path = ledgerPath(env);
    statSync(path);
    db = new DatabaseSync(path, { readOnly: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mirror_trackers'").get();
    if (!table) return new Map();
    const rows = db.prepare('SELECT tracker, read_at FROM mirror_trackers').all() as { tracker: string; read_at: string }[];
    return new Map(rows.map((row) => [String(row.tracker), String(row.read_at)]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    db?.close();
  }
}

const languageOf = (env: NodeJS.ProcessEnv): Language => (env.CLEARED_V2_APP_LANGUAGE?.trim() === 'en' ? 'en' : 'fr');

// The section's heading in the doctor's output.
export function mirrorDoctorTitle(env: NodeJS.ProcessEnv): string {
  const t = mirrorDoctorTranslator(languageOf(env));
  return t('section_title');
}

// What GitHub's refusal or its silence says of a repository; never the body of its answer.
function refusal(error: TrackerError, repo: string, api: string, t: Translate): string {
  switch (error.status) {
    case undefined: return t('repo_unreachable', { repo, api, limit: lasted(TRACKER_TIMEOUT_MS, t) });
    case 401: return t('repo_refused_401', { repo });
    case 403: return t('repo_refused_403', { repo });
    case 404: return t('repo_refused_404', { repo });
    default: return t('repo_refused', { repo, status: String(error.status) });
  }
}

export async function githubMirrorChecks(input: { readonly env: NodeJS.ProcessEnv; readonly fetch?: typeof fetch; readonly now?: Date }): Promise<MirrorCheck[]> {
  const { env } = input;
  const now = input.now ?? new Date();
  const t = mirrorDoctorTranslator(languageOf(env));
  const checks: MirrorCheck[] = [];
  const say = (level: MirrorCheck['level'], text: string) => checks.push({ level, text });

  const path = env[FILE_VARIABLE]?.trim();
  if (!path) return [{ level: 'off', text: t('section_off') }];

  // The file, read once into this function and never into a line.
  let token = '';
  try { token = readFileSync(path, 'utf8').trim(); } catch { return [{ level: 'fail', text: t('credential_file_unreadable', { path }) }]; }
  if (token === '') return [{ level: 'fail', text: t('credential_file_empty', { path }) }];
  const scrub = (list: MirrorCheck[]) => list.map((check) => ({ level: check.level, text: check.text.split(token).join('***') }));
  say('pass', t('credential_file_read'));
  if (lstatSync(path).isSymbolicLink()) say('notice', t('credential_file_link'));
  const file = statSync(path);
  if (typeof process.getuid === 'function' && file.uid !== process.getuid()) say('notice', t('credential_file_owner'));
  if ((file.mode & 0o077) !== 0) say('notice', t('credential_file_open', { mode: (file.mode & 0o777).toString(8) }));

  let api: string;
  try {
    api = loadMirrorConfig(env)?.github?.api ?? '';
  } catch (error) {
    if (!(error instanceof MirrorConfigError)) throw error;
    say('fail', t('settings_refused', { reason: error.message }));
    return scrub(checks);
  }
  let repos: string[];
  try {
    const flow = loadFlowConfig(env);
    if (!flow) {
      say('fail', t('project_missing'));
      return scrub(checks);
    }
    repos = [...new Set(workspaceOf(flow).services.map((service) => service.repo))];
  } catch (error) {
    if (!(error instanceof FlowConfigError)) throw error;
    say('fail', t('workspace_refused', { reason: error.message }));
    return scrub(checks);
  }

  const states = readLockConf(env).states;
  let staleMinutes = STALE_MINUTES;
  try { staleMinutes = readHeartbeatSettings(env).trackerMinutes; } catch (error) { if (!(error instanceof HeartbeatConfigError)) throw error; }
  const passes = lastPasses(env);

  for (const repo of repos) {
    const tracker = new GitHubTracker({ api, token, repo, states, ...(input.fetch ? { fetch: input.fetch } : {}) });
    let reached = false;
    try {
      const { issues, permissions } = await tracker.repository();
      reached = true;
      if (!issues) say('fail', t('repo_issues_off', { repo }));
      else if (!permissions) say('notice', t('repo_rights_unsaid', { repo }));
      else if (!WRITERS.some((role) => permissions[role] === true)) say('fail', t('repo_read_only', { repo }));
      else say('pass', t('repo_reached', { repo }));
    } catch (error) {
      if (!(error instanceof TrackerError)) throw error;
      say('fail', refusal(error, repo, api, t));
    }
    if (reached) {
      try {
        const labels = new Set(await tracker.labels());
        // Todo is an open issue with no status label and Done a closed one, so
        // a person needs a label for the four states between them only.
        const wanted = [states.progress, states.review, states.validate, states.go].map((state) => `status:${state}`);
        const missing = wanted.filter((label) => !labels.has(label));
        if (missing.length === 0) say('pass', t('labels_present', { repo, labels: wanted.join(', ') }));
        else say('fail', t('labels_missing', { repo, labels: missing.join(', ') }));
      } catch (error) {
        if (!(error instanceof TrackerError)) throw error;
        say('fail', refusal(error, repo, api, t));
      }
    }
    if (passes instanceof Error) {
      say('notice', t('ledger_missing', { repo, reason: reason(passes) }));
      continue;
    }
    const readAt = passes.get(tracker.name);
    if (readAt === undefined) say('notice', t('mirror_never', { repo }));
    else if ((now.getTime() - Date.parse(readAt)) / 60_000 > staleMinutes) say('fail', t('mirror_stale', { repo, time: ago(readAt, now, t), limit: duration(staleMinutes, t) }));
    else say('pass', t('mirror_recent', { repo, time: ago(readAt, now, t) }));
  }
  return scrub(checks);
}
