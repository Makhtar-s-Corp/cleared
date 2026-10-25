#!/usr/bin/env node
// Puts a pull request live: the one way a merge is done without a person at
// the keyboard. It checks, and judges nothing. Every condition is read from
// GitHub, git, the ledger, the tracker and the host, and all of them must hold:
//   1. the pull request is open, not a draft, and its checks are all green;
//   2. its branch holds the base, or lacks only what is not code;
//   3. the version that goes live was reviewed by a model other than its
//      author, for this ticket, and the reviewer concluded what [merge]
//      verdict says: the reviewed commit is the head, or the head only adds
//      merges of the base that changed nothing by themselves;
//   4. the user agreed: he put the ticket in his status of agreement himself
//      (tracker.ts moved-by-owner), for the version he was shown
//      (ask-validation.ts keeps which), or wrote « Fusion : <ticket> » before
//      the statuses existed. Invisible tooling ([merge] tooling_paths) needs
//      neither; what touches the checks of the CI, the deployment, his
//      written rules or this lock itself, with all it runs or reads
//      ([merge] guarded_paths), always needs his own agreement. What the pull
//      request changes is read from git, renames undone: GitHub cuts a long
//      list of files short;
//   5. the host is free for a merge: no CI, no deployment settling, GitHub
//      up. One go-live at a time, under one lock from the first read to the
//      merge.
// Then it merges the very commit it checked, and, when the ticket was in the
// status of agreement, says where to see the result and puts it in Done.
//
//   merge-pr.ts <pull request> <ticket> [<announcement file|->] [--dry-run]
//
// The announcement (product language: what changes, where to see it, how to
// check in a minute) is asked for whenever the user's agreement was needed.
// Exit: 0 merged (or, with --dry-run, would be); 3 not merged, kept in the
// queue: it only waits (the host is busy, a check still runs) and the wake
// does it later with these same checks (with --dry-run: would be kept);
// 5 the same, said to the wake that tries the queue; 6 no: something must
// change first, and it says what.
//
// The port of merge-pr.sh and of the part of host-state.sh it read
// (docs/v2/milestone-4-plan.md, step b): the same checks, in the same order,
// with the same messages, records and exit codes. What only v1's lanes
// wrote is not read any more: their records (the fast lane's mark, the two
// teams on one ticket), so every merge waits as the full circuit's does.
//
// A service on GitLab (docs/v2/milestone-5-plan.md, section 11) says so in
// its agents.conf ([forge] adapter = gitlab, with gitlab_url, gitlab_project
// and gitlab_token_file): its merge request is read from GitLab's REST API
// (lib/gitlab.ts) in gh's words, so the same checks judge it, in the same
// order; its host is free when no pipeline of the project runs or waits; it
// is merged at the commit that was checked (GitLab's `sha`), its branch
// kept. gh is never called for it. GitLab silent is "not now", as GitHub
// down is.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { confGet, confSoft, die, gh, ghShown, git, githubDown, hasText, idsOf, ledgerEvent, ledgerInit, ledgerRows, lockFile, main, nowUtc, ORCH_HOME, onlyBaseMerges, projectEnv, readJson, say, ScriptExit, scratchDir, shownLeft, tracker, userMessage, writeWhole } from './lib/script.ts';
import { GitLabClient, GitLabError, gitlabLockClient, gitlabLockSettings, hostOnGitLab, lockPull, mergeOnGitLab } from './lib/gitlab.ts';

const USAGE = 'usage: merge-pr.ts <pull request> <ticket> [<announcement file|->] [--dry-run]';

type Pull = { state?: unknown; isDraft?: unknown; headRefName?: unknown; headRefOid?: unknown; baseRefName?: unknown; createdAt?: unknown; statusCheckRollup?: { conclusion?: unknown; status?: unknown }[] | null };
type Asked = { at?: unknown; pulls?: { pr: number; head?: string; merged_at?: string | null }[]; closing?: boolean; [key: string]: unknown };

const jqOr = (...values: unknown[]): unknown => values.find((value) => value !== null && value !== undefined && value !== false) ?? values.at(-1);

// A GitLab service's project and the client that holds its token.
type Lab = { readonly client: GitLabClient; readonly project: string };
const FORGE_KEYS = ['gitlab_url', 'gitlab_project', 'gitlab_token_file', 'app_id', 'installation_id', 'app_private_key_file', 'app_login', 'app_user_id', 'use_tracker_app'];
// GitLab gave no answer, or one of its own trouble: not now.
const silent = (error: unknown): boolean => error instanceof GitLabError && (error.status === undefined || error.status >= 500);

// A Node command of the tool whose output goes where this one's goes.
function node(file: string, args: readonly string[], options: { readonly stderr?: 'inherit' | 'pipe' | 'ignore'; readonly stdout?: 'inherit' | 'pipe' | 'ignore' } = {}): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ['--no-warnings', join(ORCH_HOME, file), ...args], { env: process.env, encoding: 'utf8', stdio: ['ignore', options.stdout ?? 'inherit', options.stderr ?? 'inherit'] });
  return { status: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

// What the host says of itself for a merge (host-state.sh, as merge-pr.sh
// read it): GitHub down, the CI runs that are not over, and a deployment that
// may be settling. A deployment builds its images before any container
// starts: until ten minutes after the last change of the base branch, the
// host is not free.
function hostState(): { free: boolean; down: string | null } {
  const down = githubDown();
  if (down.code === 0 && down.out) return { free: false, down: down.out };
  const target = confGet('lanes', 'base').replace(/^origin\//, '');
  const listed = ghShown(['run', 'list', '--limit', '20', '--json', 'status,headBranch,event,headSha']);
  if (listed.status !== 0) throw new ScriptExit(listed.status);
  let runs: { status?: unknown }[] = [];
  try { runs = (JSON.parse(listed.stdout) as { status?: unknown }[]).filter((run) => run.status !== 'completed'); } catch { throw new ScriptExit(5); }
  const committed = ghShown(['api', `repos/{owner}/{repo}/commits/${target}`, '--jq', '.commit.committer.date']);
  const merged = Date.parse(committed.stdout.trim());
  if (committed.status !== 0 || !Number.isFinite(merged)) throw new ScriptExit(1);
  return { free: runs.length === 0 && !deploying(merged), down: null };
}

function deploying(merged: number): boolean {
  const sinceMerge = Math.trunc((Math.floor(Date.now() / 1000) - Math.floor(merged / 1000)) / 60);
  const docker = spawnSync('docker', ['ps', '--format', '{{.Status}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const settling = (docker.stdout ?? '').split('\n').filter((line) => /Up ([0-9]+ seconds|About a minute|[1-3] minutes)/.test(line)).length;
  return sinceMerge < 10 || settling > 0;
}

// The same, on GitLab's side: its pipelines running or waiting on the
// project, and the base's last change.
async function hostStateOnGitLab(lab: Lab): Promise<boolean> {
  const target = confGet('lanes', 'base').replace(/^origin\//, '');
  const host = await hostOnGitLab(lab.client, lab.project, target);
  if (!Number.isFinite(host.baseChangedAt)) throw new ScriptExit(1);
  return host.runs === 0 && !deploying(host.baseChangedAt);
}

// What GitLab says now of each merge request shown on the ticket and not
// merged by this lock, in gh's words; one it cannot say is left unsaid.
async function statesOnGitLab(lab: Lab, pulls: readonly { readonly pr: number; readonly merged_at?: string | null }[]): Promise<(pr: number) => string> {
  const states = new Map<number, string>();
  for (const one of pulls) {
    if (one.merged_at != null) continue;
    try { states.set(one.pr, (await lockPull(lab.client, lab.project, one.pr)).state); } catch { /* unsaid: the ticket is not closed on a guess */ }
  }
  return (pr) => states.get(pr) ?? '';
}

await main(async () => {
  const { state } = projectEnv();
  const name = basename(process.argv[1] ?? 'merge-pr.ts');
  function refuse(text: string): never { say(`${name}: ${text}`); throw new ScriptExit(6); }
  if (!confSoft('security', 'agent_user') && confSoft('security', 'allow_shared_uid') !== 'true') {
    refuse('release lock requires [security] agent_user; create a separate agent account and run serve/install.ts, or explicitly set [security] allow_shared_uid = true');
  }
  // Only the service account's broker may enter the merge implementation.
  // The secret lives in service-owned state; a harness cannot read it.
  if (process.getuid?.() !== statSync(join(ORCH_HOME, 'merge-pr.ts')).uid) refuse('only the service account can execute a merge');
  const secret = process.env.ORCH_BROKER_SECRET || '';
  let kept: string | null = null;
  try { kept = readFileSync(join(state, 'release-broker.secret'), 'utf8').replace(/\n+$/, ''); } catch { kept = null; }
  if (!secret || kept === null || secret !== kept) refuse('only the release broker can execute a merge');

  const args = process.argv.slice(2);
  if (args.length < 2 || !/^[0-9]+$/.test(args[0]!) || !/^[A-Z]+-[0-9]+$/.test(args[1]!)) die(USAGE);
  // A GitLab service: its settings and its token are checked before anything is read.
  let lab: Lab | null = null;
  if (confSoft('forge', 'adapter') === 'gitlab') {
    try {
      const settings = gitlabLockSettings(Object.fromEntries(FORGE_KEYS.map((key) => [key, confSoft('forge', key)])), projectEnv().repo);
      lab = { client: gitlabLockClient(settings), project: settings.project };
    } catch (error) { refuse(error instanceof Error ? error.message : String(error)); }
  }
  const pr = args[0]!;
  const ticket = args[1]!;
  let announcement = '';
  let dryRun = false;
  for (const arg of args.slice(2)) {
    if (arg === '--dry-run') dryRun = true;
    else { if (announcement) die(USAGE); announcement = arg; }
  }
  const work = scratchDir('cleared-merge-');
  let held: { release(): void } | null = null;
  try {
    if (announcement === '-') { announcement = join(work.path, 'announcement.md'); writeFileSync(announcement, readFileSync(0)); }
    if (announcement && (!existsSync(announcement) || !statSync(announcement).isFile())) die(`no such file: ${announcement}`);
    ledgerInit();
    function no(text: string): never { refuse(`#${pr} is not put live: ${text}`); }
    // "Not now" is not "no": a go-live that only waits for the host, for a
    // check still running or for the tracker's history is kept in a queue the
    // wake tries again by itself, with no model, with these same checks each
    // time.
    function later(text: string): never {
      if (dryRun) { process.stdout.write(`${userMessage('merge_dry_queue', { reason: text })}\n`); throw new ScriptExit(3); }
      if (process.env.ORCH_FROM_QUEUE) { say(`${name}: #${pr} is not put live now: ${text}`); throw new ScriptExit(5); }
      const queue = join(state, 'merge-queue');
      mkdirSync(queue, { recursive: true });
      const said = announcement ? join(queue, `${pr}.announcement.md`) : '';
      if (announcement) copyFileSync(announcement, said);
      writeWhole(join(queue, `${pr}.json`), `${JSON.stringify({ pr: Number(pr), ticket, at: nowUtc(), why: text, announcement: said }, null, 2)}\n`);
      process.stdout.write(`${userMessage('merge_queue', { pr, reason: text })}\n`);
      throw new ScriptExit(3);
    }
    // One go-live at a time, from the first read to the merge: the wake that
    // tries the queue and a call of the lead would both read a free host, and
    // a branch that holds the base, before either had merged. A dry run
    // merges nothing: it neither waits for the lock nor holds it.
    if (!dryRun) {
      mkdirSync(state, { recursive: true });
      held = lockFile(join(state, 'merge.lock'), 0);
      if (!held) later('another go-live is being done');
    }
    // A watched release must finish before another merge can make the cause of
    // a health failure ambiguous. The queue is retried by the normal wake.
    const active = node('lib/release.ts', ['active']).status;
    if (active !== 0) { if (active === 3) later('the previous release is still being monitored'); die('release watch state could not be read'); }
    if (node('lib/release.ts', ['check']).status !== 0) no('[release] settings are invalid; fix them before shipping');

    let pull: Pull;
    if (lab) {
      // 1, on GitLab: its merge request and the statuses of its head, in gh's words.
      try {
        const read = await lockPull(lab.client, lab.project, Number(pr));
        pull = { ...read, statusCheckRollup: read.checks.map((conclusion) => ({ conclusion })) };
      } catch (error) {
        if (silent(error)) later(`GitLab does not answer (${(error as Error).message})`);
        die(`merge request !${pr} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      const down = githubDown();
      if (down.code === 0 && down.out) later(`GitHub is down (${down.out})`);

      // 1. Open, not a draft, green.
      const viewed = ghShown(['pr', 'view', pr, '--json', 'number,state,isDraft,headRefName,headRefOid,baseRefName,createdAt,statusCheckRollup']);
      if (viewed.status !== 0) die(`pull request #${pr} could not be read`);
      try { pull = JSON.parse(viewed.stdout) as Pull; } catch { die(`pull request #${pr} could not be read`); }
    }
    if (pull.state !== 'OPEN') no('it is not open');
    if (pull.isDraft !== false) no('it is a draft');
    const head = String(pull.headRefOid ?? 'null');
    const branch = String(pull.headRefName ?? 'null');
    const base = confGet('lanes', 'base');
    const target = base.replace(/^origin\//, '');
    if (String(pull.baseRefName ?? 'null') !== target) no(`it does not go to ${target}`);
    const checks = (pull.statusCheckRollup ?? []).map((check) => String(jqOr(check.conclusion, check.status, '')).toUpperCase());
    if (checks.some((check) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', ''].includes(check))) later('its checks still run');
    if (checks.some((check) => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check))) no('a check is not green');
    if (!checks.includes('SUCCESS')) no('no check ran on it');

    // 2. The base is in it, or what it lacks is not code.
    const fetched = git(['fetch', '--quiet', 'origin', target, branch]);
    if (fetched.stderr) process.stderr.write(fetched.stderr);
    if (fetched.status !== 0) die('the branches could not be fetched');
    if (git(['rev-parse', `origin/${branch}`]).stdout.trim() !== head) later('its branch moved while it was read');
    // What it changes, from git: every path, and for a file that moved, where
    // it came from as well as where it went.
    const names = (range: string) => JSON.stringify(git(['diff', '--name-only', '--no-renames', range]).stdout.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1));
    const filesJson = join(work.path, 'files.json');
    writeFileSync(filesJson, `${names(`${base}...${head}`)}\n`);
    if (git(['merge-base', '--is-ancestor', base, head]).status !== 0) {
      const lag = join(work.path, 'lag.json');
      writeFileSync(lag, `${names(`${head}...${base}`)}\n`);
      if (node('lib/merge.ts', ['lag', lag]).status !== 0) no(`its branch lacks code that is on ${target}: the lane brings ${target} in first`);
    }

    // 3. Reviewed, for this ticket, with the verdict asked for, at this version.
    let reviewed = '';
    for (const row of ledgerRows("select run_id from runs where role = 'review' and source = 'dispatcher' and outcome = 'done' and pr_number = ? and ticket = ? order by started_at desc", Number(pr), ticket)) {
      const report = join(state, 'reports', `${String(row.run_id)}.md`);
      let commit = '';
      try { commit = (readFileSync(report, 'utf8').split('\n').find((line) => line.startsWith('commit: ')) ?? '').slice('commit: '.length); } catch { commit = ''; }
      if (!commit) continue;
      if (node('lib/merge.ts', ['verdict', report], { stderr: 'ignore' }).status !== 0) continue;
      if (onlyBaseMerges(commit, head)) { reviewed = commit; break; }
    }
    if (!reviewed) no(`this version (${head.slice(0, 8)}) has no review for ${ticket} that concludes « ${confGet('merge', 'verdict')} »: have it reviewed`);

    // 4. The agreement of the user.
    const needs = node('lib/merge.ts', ['needs', filesJson], { stdout: 'pipe' }).stdout.replace(/\n+$/, '');
    const go = confGet('tracker', 'go_state');
    const validate = confGet('tracker', 'validate_state');
    const askedPath = join(state, 'validations', `${ticket}.json`);
    const asked = readJson<Asked>(askedPath);
    let agreed = '';
    const sendBack = () => { if (!dryRun) tracker(['move', ticket, validate], { quiet: false }); };
    if (needs !== 'tooling') {
      // His move is read from the tracker, and not from one that cannot tell
      // him from an agent, unless the project says it accepts that ([merge]
      // separate_identity = no).
      if (confSoft('merge', 'separate_identity') !== 'no' && tracker(['identity']).stdout.replace(/\n+$/, '') !== 'app') {
        no('the tracker cannot tell the user from an agent (the scripts act under the key of a person): no agreement is read from it ([merge] separate_identity). Give the agents their own application');
      }
      // His move answers a request: the time of the last one made on this ticket.
      const requested = asked && asked.at !== null && asked.at !== undefined && asked.at !== false ? String(asked.at) : '';
      const moved = tracker(['moved-by-owner', ticket, go, ...(requested ? [requested] : [])]);
      process.stdout.write(moved.stdout);
      switch (moved.status) {
        case 0: {
          // His move is his agreement to what he was shown, and to nothing
          // else: another pull request of the ticket, a commit of the branch,
          // or the base brought in with a conflict that was resolved, was seen
          // by nobody but a reviewer. The base brought in as it is changes
          // nothing of what the pull request does, and the checks ran again on
          // it: his agreement stands (his rule of 2026-10-08).
          const shown = asked?.pulls?.find((one) => one.pr === Number(pr))?.head ?? '';
          if (!shown) no(`${ticket} is in « ${go} », but the user was never shown #${pr}: ask him for it (ask-validation.ts ${ticket} - --pr ${pr})`);
          if (!onlyBaseMerges(shown, head)) {
            sendBack();
            if (!dryRun) ledgerEvent({ kind: 'merge_refused', ticket, value: Number(pr), detail: `#${pr}: the user agreed to ${shown.slice(0, 8)} and the branch is now at ${head.slice(0, 8)}: ${ticket} is back in « ${validate} », to be asked again with this version` });
            no(`this version (${head.slice(0, 8)}) is not the version he was shown (${shown.slice(0, 8)}): ${ticket} is back in « ${validate} ». Ask him again with this version (ask-validation.ts ${ticket} - --pr ${pr})`);
          }
          agreed = 'status';
          break;
        }
        case 7: later(`tracker has not written yet who put ${ticket} in « ${go} »`);
        case 8:
          // By him, but before the request: an agreement to something else, and
          // a card that somebody else put back where he had left it.
          sendBack();
          if (!dryRun) ledgerEvent({ kind: 'merge_refused', ticket, value: Number(pr), detail: `#${pr}: the move of the user to « ${go} » is older than the request made at ${requested}: it answers another request. ${ticket} is back in « ${validate} »` });
          no(`the move of the user to « ${go} » is older than the request made at ${requested}: ${ticket} is back in « ${validate} », where the request waits for him`);
        case 6:
          // In his status, but not put there by him: never live, and back to the status that asks him.
          sendBack();
          if (!dryRun) ledgerEvent({ kind: 'merge_refused', ticket, value: Number(pr), detail: `#${pr}: ${ticket} was put in « ${go} » by an integration or another account, not by the user: back to « ${validate} »` });
          no(`${ticket} is in « ${go} » but the user did not put it there himself: put back in « ${validate} »`);
        case 5: {
          // Not in his status: a line he wrote before the statuses existed still counts.
          if (tracker(['legacy-line-allowed']).status === 0) {
            const comments = [tracker(['comments', ticket]).stdout, tracker(['comments', confSoft('lead', 'report_on')]).stdout]
              .flatMap((text) => text.split('\n').filter((line) => line.trim()).map((line) => { try { return JSON.parse(line) as unknown; } catch { return null; } }));
            const all = comments.reduce<unknown[]>((sum, list) => (Array.isArray(list) ? [...sum, ...list] : sum), []);
            const commentsFile = join(work.path, 'comments.json');
            writeFileSync(commentsFile, `${JSON.stringify(comments.length === 0 ? null : all)}\n`);
            const idsFile = join(work.path, 'agent-ids.txt');
            writeFileSync(idsFile, idsOf([join(state, 'tracker-comments.jsonl')]));
            const opened = String(jqOr(pull.createdAt, ''));
            const line = node('lib/merge.ts', ['line', commentsFile, idsFile, ticket, opened, ...(needs === 'guarded' ? [pr] : [])]);
            if (line.status === 0) agreed = 'line';
          }
          break;
        }
        default: die(`tracker could not say who moved ${ticket}`);
      }
      if (!agreed) no(`the user has not agreed: ${ticket} is not in « ${go} »${needs === 'guarded' ? ' (it touches the checks of the CI, the deployment, his written rules or the tooling of the go-lives: his own agreement is needed, tooling or not)' : ''}. Ask him (ask-validation.ts ${ticket} - --pr ${pr})`);
      if (!announcement || !hasText(readFileSync(announcement, 'utf8'))) no('an announcement is needed for what the user agreed to: what changes, where to see it, how to check');
    }

    // 5. The host.
    let free: boolean;
    if (lab) {
      try { free = await hostStateOnGitLab(lab); }
      catch (error) {
        if (silent(error)) later(`GitLab does not answer (${(error as Error).message})`);
        throw error;
      }
    } else free = hostState().free;
    if (!free) later('the host is not free for a merge (a CI or a deployment settling)');

    if (dryRun) {
      process.stdout.write(`${JSON.stringify({ would_merge: Number(pr), ticket, head, reviewed_commit: reviewed, kind: needs, agreement: agreed || 'none needed' }, null, 2)}\n`);
      return 0;
    }

    // The very commit that was checked, and nothing that arrived since.
    if (lab) {
      try { await mergeOnGitLab(lab.client, lab.project, Number(pr), head); }
      catch (error) { die(`GitLab did not merge !${pr}: ${error instanceof Error ? error.message : String(error)}`); }
    } else {
      const merged = gh(['pr', 'merge', pr, '--merge', '--match-head-commit', head]);
      if (merged.stderr) process.stderr.write(merged.stderr);
      if (merged.status !== 0) die(`GitHub did not merge #${pr}`);
    }
    ledgerEvent({ kind: 'merged_by_script', ticket, value: Number(pr), detail: `#${pr} at ${head.slice(0, 8)}, reviewed at ${reviewed.slice(0, 8)}, ${needs}, agreement: ${agreed || 'none needed'}, full lane` });
    // Its time from Todo to Done, in working time, the human's wait and the
    // machine's (lib/fast-lane.ts measure): never a reason not to go on.
    if (node('lib/fast-lane.ts', ['measure', ticket, pr, 'full'], { stdout: 'ignore', stderr: 'ignore' }).status !== 0) say(`${name}: the time of ${ticket} could not be measured`);
    const watched = node('lib/release.ts', ['start', ticket, pr, 'full'], { stderr: 'pipe' });
    if (watched.status !== 0) {
      const reason = watched.stderr.replace(/\n+$/, '').split('\n').at(-1) ?? '';
      ledgerEvent({ kind: 'release_watch_failed', ticket, value: Number(pr), detail: `the merge succeeded but its release watch could not start: ${reason}` });
      const failed = join(work.path, 'release-watch-failed.md');
      writeFileSync(failed, `${userMessage('release_watch_failed', { title: `#${pr} (${ticket})`, reason })}\n`);
      if (tracker(['comment', ticket, failed, 'Cleared'], { quiet: true }).status !== 0) {
        mkdirSync(join(state, 'tracker-outbox'), { recursive: true });
        copyFileSync(failed, join(state, 'tracker-outbox', `${ticket}--release-watch-${pr}.md`));
      }
      say(`${name}: #${pr} merged, but release monitoring failed: ${reason}. Retry with node ${ORCH_HOME}/lib/release.ts start ${ticket} ${pr}`);
    }
    process.stdout.write(`merged: #${pr} (${ticket}) at ${head.slice(0, 8)}\n`);

    // What the user agreed to is told to him where he agreed, and closed. A
    // comment the hourly limit holds back leaves with the grouped ones.
    if (announcement) {
      const told = tracker(['comment', ticket, announcement, process.env.ORCH_SIGNED || confGet('lead', 'name')]);
      if (told.status !== 0) {
        mkdirSync(join(state, 'tracker-outbox'), { recursive: true });
        const part = join(state, 'tracker-outbox', `.${pr}.part`);
        copyFileSync(announcement, part);
        spawnSync('mv', [part, join(state, 'tracker-outbox', `${ticket}--mise-en-ligne-${pr}.md`)]);
      }
    }
    // The ticket is closed once everything he was shown on it is live. A pull
    // request he was shown and that GitHub says closed or merged since no
    // longer counts; one GitHub cannot be asked about still does: the ticket
    // is not closed on a guess, the ledger keeps it, and the wake asks again.
    if (agreed === 'status') {
      const record = readJson<Asked>(askedPath) ?? {};
      record.pulls = (record.pulls ?? []).map((one) => (one.pr === Number(pr) ? { ...one, merged_at: nowUtc() } : one));
      writeWhole(askedPath, `${JSON.stringify(record, null, 2)}\n`);
      const left = lab ? shownLeft(askedPath, await statesOnGitLab(lab, record.pulls ?? [])) : shownLeft(askedPath);
      if (left.unknown !== 0) {
        writeWhole(askedPath, `${JSON.stringify({ ...record, closing: true }, null, 2)}\n`);
        const pending = (record.pulls ?? []).filter((one) => one.merged_at === null || one.merged_at === undefined).map((one) => `#${one.pr}`).join(', ');
        ledgerEvent({ kind: 'ticket_left_open', ticket, value: Number(pr), detail: `#${pr} is live, and ${ticket} stays in « ${go} »: GitHub did not say what became of ${pending}, shown on the same ticket. Nothing to do: the wake asks GitHub again by itself, and closes the ticket once every other pull request shown is live or closed, if the ticket still is where the user put it` });
      } else if (left.open === 0) {
        const done = confGet('tracker', 'done_state');
        if (tracker(['move', ticket, done]).status === 0) {
          const now = readJson<Asked>(askedPath) ?? record;
          delete now.closing;
          writeWhole(askedPath, `${JSON.stringify(now, null, 2)}\n`);
        } else say(`${name}: #${pr} is live, but ${ticket} could not be put in « ${done} »`);
      }
    }
    return 0;
  } finally {
    held?.release();
    work.remove();
  }
});
