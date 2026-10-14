import { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.mjs';
import { route } from '../lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.mjs';

export const conf = loadConf(join(ORCH_HOME, 'agents.example.conf'));

// Every folder a test makes is removed once the file is done. The temporary
// folder of the host has a limit on the number of files, shared with the CI
// and the lanes: on 2026-10-08 the folders these tests left behind, run after
// run, filled it, and nothing could write there any more.
const scratchDirs = [];
export const scratch = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};
// (the dependencies a lane is handed are read-only: made writable again before they go)
after(() => { for (const dir of scratchDirs) { try { execFileSync('chmod', ['-R', 'u+w', dir]); } catch { /* gone already */ } rmSync(dir, { recursive: true, force: true }); } });
// A project for the tests that run the real scripts with the example settings: a repository that carries, where
// those settings name them, the lists the guard reads (invented private terms, as fingerprints).
let fixtureProjectDir = null;
export function fixtureProject() {
  if (fixtureProjectDir) return fixtureProjectDir;
  const dir = scratch('orch-project-');
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.cleared'), { recursive: true });
  writeFileSync(join(dir, '.cleared', 'agents.conf'), readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'));
  for (const file of ['codex-guard-allow.json', 'private-terms.json']) execFileSync('cp', [join(ORCH_HOME, 'test', 'fixtures', 'guard', file), join(dir, 'scripts', file)]);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fixtureProjectDir = dir;
  return dir;
}
// These tests are about the files of this checkout and about nothing of the machine they run on: the guard is the
// one of the working tree (not the one of the branch the tool follows), and no project is named for the machine.
process.env.ORCH_GUARD_TOOL_REF = '';
process.env.XDG_CONFIG_HOME = scratch('orch-config-');
export const task = (over) => ({ role: 'dev', labels: [], project: null, paths: [], prLines: null, authorModel: null, forced: null, ...over });
export const first = (over) => route(conf, task(over)).chain[0].alias;


export function sandbox({ policy = 'fallback', maxLanes = 3 } = {}) {
  const home = scratch('orch-home-');
  const state = join(home, 'state');
  const repo = join(home, 'repo');
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'lane-run.sh'), join(ORCH_HOME, 'spawn-lane.sh'), join(ORCH_HOME, 'kill-lane.sh'), join(ORCH_HOME, 'wake.sh'), join(ORCH_HOME, 'push-lane.sh'), join(ORCH_HOME, 'tell-lane.sh'), join(ORCH_HOME, 'adopt-lane.sh'), join(ORCH_HOME, 'host-state.sh'), join(ORCH_HOME, 'talk.sh'), join(ORCH_HOME, 'talk-run.sh'), join(ORCH_HOME, 'decide.sh'), join(ORCH_HOME, 'confirm-decision.sh'), join(ORCH_HOME, 'check-lead-model.sh'), join(ORCH_HOME, 'review-pr.sh'), join(ORCH_HOME, 'merge-pr.sh'), join(ORCH_HOME, 'ask-validation.sh'), join(ORCH_HOME, 'tidy-lanes.sh'), join(ORCH_HOME, 'digest-note.sh'), join(ORCH_HOME, 'flow-lanes.sh'), join(ORCH_HOME, 'when-free.sh'), home]);
  execFileSync('mkdir', ['-p', join(home, 'adapters'), repo, join(home, 'lanes')]);
  execFileSync('cp', ['-r', join(ORCH_HOME, 'prompts'), home]);
  const fake = (name, exit) => writeFileSync(join(home, 'adapters', `${name}.sh`), `#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/../lib/contract.sh"
case "$1" in
  list-models) shift; [ ${name} != first ] || [ -z "\${FIRST_GONE:-}" ] || exit 0; printf '%s\\n' "$@" ;;
  talk) shift; [ ${name} != first ] || [ -z "\${FIRST_CANNOT_TALK:-}" ] || exit 2
    printf '%s\\n' "${name}" "$@" "edit=\${ORCH_EDIT_ONLY:-}" "read=\${ORCH_READ_DIRS:-}" "mode=\${ORCH_PERMISSION_MODE:-}" "allow=\${ORCH_ALLOW:-}" "run=\${ORCH_RUN_ID:-}" > "\${ORCH_STATE_DIR}/talked"; exit 0 ;;
  run) shift; contract_parse_run "$@"; printf '%s|%s|%s\\n' "\${ORCH_PERMISSION_MODE:-}" "\${ORCH_ALLOW:-}" "\${ORCH_DENY:-}" > "\${ORCH_STATE_DIR}/allowed-${name}"; echo "\${ORCH_SIGNED:-}" > "\${ORCH_STATE_DIR}/signed-${name}"; [ -z "\${FIRST_DIES:-}" ] || [ ${name} != first ] || exit 141; body=$(mktemp); echo "\${ANSWER:-answer of ${name}}" > "$body"; [ -z "\${FAKE_LEAVES:-}" ] || eval "\$FAKE_LEAVES"
    contract_usage "$(jq -c --argjson limits "\${FAKE_LIMITS:-null}" '. + (if $limits then {limits: $limits} else {} end) + (if $cost then {cost_usd: $cost} else {} end)' --argjson cost "\${FAKE_COST:-null}" <<<'{"tokens_total": 10}')"; echo "budget=\${ORCH_BUDGET_USD:-none}" > "\${ORCH_STATE_DIR}/budget-${name}"; code=${exit}; contract_report ${name} "$code" "$body"; exit "$code" ;;
esac
`, { mode: 0o755 });
  fake('first', '${FIRST_EXIT:-0}');
  fake('second', '${SECOND_EXIT:-0}');
  // tracker and GitHub as files the test writes: what they "say now".
  writeFileSync(join(home, 'tracker.sh'), `#!/usr/bin/env bash
if [ "$1" = ticket-prefix ]; then echo X; exit; fi
if [ "$1" = legacy-line-allowed ]; then exit 0; fi
if [ "$1" = changes ]; then cat "${join(home, 'tracker-now.json')}"; exit; fi
if [ "$1" = comment ]; then [ -z "\${FAKE_TRACKER_DOWN:-}" ] || exit 1; [ -z "\${FAKE_TRACKER_FULL:-}" ] || exit 4; { echo "$2 from=$4"; cat "$3"; } > "${join(home, 'tracker-posted')}"; echo "$2" >> "${join(home, 'tracker-posted-log')}"; echo "https://example.test/comment"; exit; fi
if [ "$1" = waiting ]; then echo '[{"identifier":"X-7","title":"Un écran à valider","url":"u","since":"2026-01-02T10:00:00Z"}]'; exit; fi
if [ "$1" = comments ]; then [ -z "\${FAKE_TRACKER_COMMENTS_DOWN:-}" ] || exit 1; cat "${join(home, 'tracker-comments.json')}" 2>/dev/null || echo '[{"id":"c1","createdAt":"2026-01-02T10:00:00Z","body":"Un commentaire du ticket de suivi."}]'; exit; fi
if [ "$1" = moved-by-owner ]; then echo "$2 $3 \${4:-}" >> "${join(home, 'tracker-moved-asked')}"; exit "$(cat "${home}/tracker-moved-$2" 2>/dev/null || cat "${join(home, 'tracker-moved')}" 2>/dev/null || echo 5)"; fi
if [ "$1" = list ]; then cat "${home}/tracker-list-$2.json" 2>/dev/null || echo '[]'; exit; fi
if [ "$1" = identity ]; then cat "${join(home, 'tracker-identity')}" 2>/dev/null || echo app; exit; fi
if [ "$1" = move ]; then [ -z "\${FAKE_TRACKER_MOVE_DOWN:-}" ] || exit 1; echo "$2 -> $3" >> "${join(home, 'tracker-moves')}"; echo "$3" > "${join(home, 'tracker-state')}"; exit; fi
if [ "$1" = upload ]; then case "$2" in *.png) echo "https://uploads.example.test/$(basename "$2")" ;; *) echo "not an image" >&2; exit 1 ;; esac; exit; fi
if [ "$1" = state ]; then cat "${home}/tracker-state-$2" 2>/dev/null || cat "${join(home, 'tracker-state')}" 2>/dev/null || echo "In Review"; exit; fi
if [ "$1" = issue ]; then title=$(cat "${home}/tracker-title-$2" 2>/dev/null || echo "Titre de $2"); jq -nc --arg id "$2" --arg title "$title" --rawfile description <(cat "${home}/tracker-description-$2" 2>/dev/null || true) '{identifier: $id, title: $title, url: "u", project: null, labels: [], description: $description}'; exit; fi
echo '{"identifier":"X-1","title":"t","url":"u","project":null,"labels":[]}'
`, { mode: 0o755 });
  writeFileSync(join(home, 'tracker-now.json'), '[]');
  // What GitHub says of itself: all is well, unless a test writes otherwise. No test asks the real page.
  writeFileSync(join(home, 'github-status.json'), JSON.stringify({ components: ['Git Operations', 'Pull Requests', 'Actions', 'API Requests', 'Webhooks'].map((name) => ({ name, status: 'operational' })) }));
  writeFileSync(join(home, 'pulls-now.json'), '[]');
  writeFileSync(join(home, 'prompts', 'dev.md'), 'prompt\n');
  writeFileSync(join(home, 'prompts', 'release.md'), 'lead prompt\n');
  writeFileSync(join(home, 'prompts', 'handover.md'), 'handover prompt\n');
  writeFileSync(join(home, 'prompts', 'release-live.md'), 'acting lead prompt\n');
  writeFileSync(join(home, 'prompts', 'review.md'), 'review prompt\n');
  writeFileSync(join(home, 'prompts', 'talk.md'), 'talk prompt, decisions in @DECISIONS@, default ticket @REPORT_ON@\n');
  writeFileSync(join(home, 'agents.conf'), `[models]\na = first:m1\nb = second:m2\n[fallbacks]\na = b\nb = a\n[roles]\ndev = a\nrelease = a\ntalk = a\nreview = a\n[review]\ndiffers_from_author = yes\nwhen_same = b\nauthor_role = dev\nper_hour = 3\n[talk]\nrole = talk\n[permissions.talk]\nmode = read-only\nallow = only-for-the-talk\ndeny = never\n[policy]\nguard_refusal = ${policy}\n[limits]\nmax_lanes = ${maxLanes}\ncounted_roles = dev\n[lanes]\nroot = ${join(home, 'lanes')}\nbase = main\npush_roles = dev talk\n[tracker]\nadapter = local\nteam = X\nowner_name = the user\nprogress_state = In Progress\nreview_state = In Review\ntodo_state = Todo\nvalidate_state = À valider\ngo_state = Go MEP\ndone_state = Done\nwriteup_role =\n[lead]\nrole = release\nlive = no\nmax_minutes = 20\nname = chef de projet\nreport_on = X-100\nreport_hours = 6\nmessages_per_lane_per_hour = 2\n[permissions.release-live]\nmode = read-only\nallow = only-for-the-acting-lead\ndeny = never\n[currency]\nusd_eur = 1\n[rules]\n[security]\nallow_shared_uid = true\n`);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  // What the guard must know of the project (its private terms, as fingerprints, and the values it allows) is the
  // project's, read from its trusted ref: here, invented ones.
  execFileSync('mkdir', ['-p', join(repo, 'scripts')]);
  for (const file of ['codex-guard-allow.json', 'private-terms.json']) execFileSync('cp', [join(ORCH_HOME, 'test', 'fixtures', 'guard', file), join(repo, 'scripts', file)]);
  mkdirSync(join(repo, '.cleared'), { recursive: true });
  writeFileSync(join(repo, '.cleared', 'agents.conf'), '[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n');
  writeFileSync(join(home, 'agents.conf'), `${readFileSync(join(home, 'agents.conf'), 'utf8')}\n[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // No test talks to the real Orca: this one opens a terminal that runs nothing.
  execFileSync('mkdir', ['-p', join(home, 'bin')]);
  writeFileSync(join(home, 'bin', 'gh'), `#!/usr/bin/env bash
if [ "$1 $2" = "pr list" ]; then [ -z "\${FAKE_GH_LIST_DOWN:-}" ] || exit 1
  head=; previous=; for arg in "$@"; do [ "$previous" != --head ] || head=$arg; previous=$arg; done
  if [ -n "$head" ]; then cat "${home}/pr-head-\${head//\\//-}.json" 2>/dev/null || echo '[]'; else cat "${join(home, 'pulls-now.json')}"; fi
elif [ "$1 $2" = "pr create" ]; then [ -z "\${FAKE_GH_DOWN:-}" ] || exit 1; printf '%s\\n' "$@" > "${join(home, 'pr-create-args')}"; echo "https://example.test/pull/41"
elif [ "$1 $2" = "pr ready" ]; then echo "$3 \${4:-}" >> "${join(home, 'pr-ready')}"
elif [ "$1 $2" = "run view" ]; then case " $* " in *" --json jobs "*) cat "${join(home, 'run-jobs.json')}" 2>/dev/null || echo '{"jobs":[]}' ;; *) echo "$3" >> "${join(home, 'run-viewed')}"; cat "${join(home, 'run-log.txt')}" 2>/dev/null || true ;; esac
elif [ "$1 $2" = "run rerun" ]; then [ -z "\${FAKE_GH_RERUN_DOWN:-}" ] || exit 1; [ -z "\${FAKE_GH_RERUN_FORBIDDEN:-}" ] || { echo 'HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r/actions/runs/77/rerun-failed-jobs)' >&2; exit 1; }; echo "$3 $4" >> "${join(home, 'run-rerun')}"
elif [ "$1 $2" = "pr close" ]; then [ -z "\${FAKE_GH_CLOSE_DOWN:-}" ] || exit 1; echo "$3" >> "${join(home, 'pr-closed')}"
elif [ "$1 $2" = "pr merge" ]; then printf '%s\\n' "$@" > "${join(home, 'pr-merged')}"
elif [ "$1 $2" = "pr view" ]; then [ "\${FAKE_GH_VIEW_DOWN:-}" != "$3" ] || exit 1; cat "${home}/pr-view-$3.json" 2>/dev/null || cat "${join(home, 'pr-view.json')}"
elif [ "$1 $2" = "run list" ]; then case " $* " in *" --event schedule "*) cat "${join(home, 'night-runs.json')}" 2>/dev/null || echo '[]' ;; *" --event workflow_dispatch "*) cat "${join(home, 'night-runs-by-hand.json')}" 2>/dev/null || echo '[]' ;; *" --branch "*) if [ -f "${join(home, 'runs-of-branch.json')}" ]; then filter=; previous=; for arg in "$@"; do [ "$previous" != --jq ] || filter=$arg; previous=$arg; done; jq -r "$filter" "${join(home, 'runs-of-branch.json')}"; else echo 77; fi ;; *) echo "\${FAKE_GH_RUNS:-[]}" ;; esac
elif [ "$1" = api ]; then echo 2020-01-01T00:00:00Z
else echo 0; fi
`, { mode: 0o755 });
  writeFileSync(join(home, 'bin', 'docker'), '#!/usr/bin/env bash\n', { mode: 0o755 });
  // FAKE_ORCA_FAILS: how many times it refuses to open a terminal before it does.
  writeFileSync(join(home, 'bin', 'orca'), `#!/usr/bin/env bash
if [ "$1 $2" = "terminal create" ]; then
  count=$(cat "${join(home, 'orca-calls')}" 2>/dev/null || echo 0); echo $((count + 1)) > "${join(home, 'orca-calls')}"
  [ "$count" -ge "\${FAKE_ORCA_FAILS:-0}" ] || exit 1
  echo '{"handle":"t1"}'
fi
if [ "$1 $2" = "worktree rm" ]; then exit 1; fi
if [ "$1 $2" = "worktree set" ]; then shift 2; printf '%s\\n' "$*" >> "${join(home, 'orca-named')}"; fi
if [ "$1 $2" = "terminal create" ]; then printf '%s\\n' "$*" >> "${join(home, 'orca-terminals')}"; fi
if [ "$1 $2" = "terminal list" ]; then [ -z "\${FAKE_ORCA_DOWN:-}" ] || exit 1; cat "${join(home, 'terminals.json')}" 2>/dev/null || echo '{"result":{"terminals":[]}}'; fi
if [ "$1 $2" = "terminal send" ]; then printf '%s\\n' "$@" > "${join(home, 'orca-sent')}"; fi
if [ "$1 $2" = "terminal close" ]; then [ -z "\${FAKE_ORCA_CLOSE_FAILS:-}" ] || exit 1; echo "$4" >> "${join(home, 'orca-closed')}"; printf '%s\n' "$*" >> "${join(home, 'orca-close-args')}"; fi
`, { mode: 0o755 });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'release-broker.secret'), 'fixture-broker-secret', { mode: 0o600 });
  const env = { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}`, ORCH_REPO: repo, ORCH_STATE_DIR: state, ORCH_CONF: join(home, 'agents.conf'), ORCH_BROKER_SECRET: 'fixture-broker-secret', ORCH_GUARD_REF: 'main', ORCH_GITHUB_STATUS: `file://${join(home, 'github-status.json')}` };
  return { home, state, repo, env, git };
}

export function runLane(box, firstExit, extra = {}, cwd = box.repo) {
  const runDir = scratch('orch-run-');
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }, { alias: 'b', adapter: 'second', model: 'm2' }]));
  writeFileSync(join(runDir, 'lane.env'), `ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=${extra.ORCH_COMMENT_TEST ?? 'none'}\nORCH_WRITEUP_ROLE=\n`);
  const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd, env: { ...box.env, FIRST_EXIT: String(firstExit), ...extra }, encoding: 'utf8' });
  const db = openLedger(join(box.state, 'ledger.db'));
  const runs = db.prepare('select model, outcome, exit_code from runs order by rowid').all().map((row) => ({ ...row }));
  const events = db.prepare('select kind from events order by rowid').all().map((row) => row.kind);
  db.close();
  return { status: run.status, runs, events, comment: readFileSync(join(runDir, 'comment.md'), 'utf8') };
}

export function laneWithRemote(branch, message = 'feat: the work of the lane') {
  const box = sandbox();
  const remote = join(box.home, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', 'origin', 'main');
  const path = join(box.home, 'lanes', branch.replace('/', '-'));
  box.git('worktree', 'add', '-q', '-b', branch, path, 'main');
  if (message) execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', message]);
  const push = (target = path) => spawnSync(join(box.home, 'push-lane.sh'), [target], { env: box.env, encoding: 'utf8' });
  const onRemote = () => execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n');
  const created = () => { try { return readFileSync(join(box.home, 'pr-create-args'), 'utf8').trim().split('\n'); } catch { return null; } };
  return { box, remote, path, push, onRemote, created };
}

export function flowBox({ maxLanes = 1 } = {}) {
  const lane = laneWithRemote('feat/unrelated', null);
  const { box } = lane;
  execFileSync('git', ['-C', box.repo, 'worktree', 'remove', '--force', lane.path]);
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8')
    .replace('[lanes]\n', '[lanes]\ntodo_since = 2026-01-01T00:00:00Z\nruns_per_day = 4\nbase_without_model = no\nclosed_states = Done, Canceled\n')
    .replace('base = main', 'base = origin/main')
    .replace(/max_lanes = \d+/, `max_lanes = ${maxLanes}`)}[merge]\ncode_paths = server/\nverdict = rien de bloquant\n`);
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  const env = { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none') };
  const flow = (extra = {}) => spawnSync(join(box.home, 'flow-lanes.sh'), [], { env: { ...env, ...extra }, encoding: 'utf8' });
  const todo = (tickets) => writeFileSync(join(box.home, 'tracker-list-Todo.json'), JSON.stringify(tickets.map((identifier, index) => ({ identifier, title: `Titre de ${identifier}`, updatedAt: `2026-01-02T10:0${index}:00Z`, state: 'Todo' }))));
  const by = (ticket, code) => writeFileSync(join(box.home, `tracker-moved-${ticket}`), String(code));
  const record = (ticket) => JSON.parse(readFileSync(join(box.state, 'lanes', `${ticket}.json`), 'utf8'));
  const there = (ticket) => { try { readdirSync(join(box.home, 'lanes', `dev-${ticket}`)); return true; } catch { return false; } };
  const moves = () => { try { return readFileSync(join(box.home, 'tracker-moves'), 'utf8').trim().split('\n'); } catch { return []; } };
  const stuck = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select kind, ticket from events where kind in ('lane_stuck', 'lane_asks') order by rowid").all().map((row) => `${row.kind} ${row.ticket}`); db.close(); return rows; };
  // The session of the lane of a ticket: it commits what it was asked, says what it has to say, and ends.
  const session = (ticket, { commit = 'fix: the work', answer = 'Fait.\n\nQuestions pour the user : aucune.', exit = 0, bringBase = false } = {}) => {
    const kept = record(ticket);
    const runDir = join(box.state, 'runs', kept.runs.at(-1).run);
    if (bringBase) execFileSync('git', ['-C', kept.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'merge', '-q', '--no-edit', 'origin/main']);
    if (commit) execFileSync('git', ['-C', kept.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', commit]);
    const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: kept.worktree, env: { ...env, ANSWER: answer, FIRST_EXIT: String(exit), SECOND_EXIT: String(exit) }, encoding: 'utf8' });
    return { run, prompt: readFileSync(join(runDir, 'prompt.md'), 'utf8'), head: execFileSync('git', ['-C', box.repo, 'rev-parse', `dev/${ticket}`], { encoding: 'utf8' }).trim() };
  };
  const pull = (over) => writeFileSync(join(box.home, 'pr-view.json'), JSON.stringify({ number: 41, state: 'OPEN', isDraft: true, headRefName: 'dev/X-5', baseRefName: 'main', title: 't', body: 'b', additions: 1, deletions: 0, files: [], statusCheckRollup: [], ...over }));
  return { box, lane, env, flow, todo, by, record, there, moves, stuck, session, pull };
}

export function reviewedPull(files, { answer = 'Verdict : rien de bloquant.', prepare = null, ticket = 'X-5', table = { tooling_paths: 'ops/cleared/, docs/decisions.md', guarded_paths: '.github/, compose, Dockerfile, ops/cleared/merge-pr.sh' } } = {}) {
  const lane = laneWithRemote('feat/w', 'feat: the work of the lane');
  const { box } = lane;
  // What a pull request changes is read from git, not from what GitHub lists: the files are really in the branch.
  const laneGit = (...args) => execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  if (prepare) prepare({ box, lane, git: laneGit });
  for (const file of files) {
    mkdirSync(dirname(join(lane.path, file)), { recursive: true });
    writeFileSync(join(lane.path, file), `${file}\n`);
  }
  if (files.length) {
    laneGit('add', '-A');
    laneGit('commit', '-q', '-m', 'feat: the files of the pull request');
  }
  // The host of the sandbox is its own: no process of the real one (a CI running its screen tests) is read.
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  const env = { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none') };
  const headOf = () => execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publish = (over = {}) => {
    execFileSync('git', ['-C', lane.path, 'push', '-q', 'origin', 'feat/w']);
    execFileSync('git', ['-C', box.repo, 'fetch', '-q', 'origin']);
    writeFileSync(join(box.home, 'pr-view.json'), JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, title: 't', body: 'b', headRefName: 'feat/w', baseRefName: 'main', headRefOid: headOf(), createdAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 0, files: files.map((path) => ({ path })), statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }], ...over }));
  };
  // The base of the sandbox is its local main: the scripts read it as origin/main once it is pushed.
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8').replace('base = main', 'base = origin/main')}[merge]\ntooling_paths = ${table.tooling_paths}\nguarded_paths = ${table.guarded_paths}\ncode_paths = server/, frontend/, shared/\nverdict = rien de bloquant\nlines_until = 2026-01-03T00:00:00Z\nqueue_hours = 24\n`);
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[tracker]\nadapter = local\nteam = X\n', '[tracker]\nadapter = local\nteam = X\nvalidate_state = À valider\ngo_state = Go MEP\ndone_state = Done\n'));
  publish();
  const opened = JSON.parse(spawnSync(join(box.home, 'review-pr.sh'), ['7', ticket, '--author-model', 'b'], { env, encoding: 'utf8' }).stdout);
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [opened.run_dir], { cwd: opened.worktree, env: { ...env, ANSWER: answer }, encoding: 'utf8' }).status, 0);
  const merge = (args = [], extra = {}, input = undefined) => spawnSync(join(box.home, 'merge-pr.sh'), ['7', ticket, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input });
  const merged = () => { try { return readFileSync(join(box.home, 'pr-merged'), 'utf8').trim().split('\n'); } catch { return null; } };
  const moves = () => { try { return readFileSync(join(box.home, 'tracker-moves'), 'utf8').trim().split('\n'); } catch { return []; } };
  const ledgerKinds = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select kind from events where kind in ('merged_by_script', 'merge_refused') order by rowid").all().map((row) => row.kind); db.close(); return rows; };
  const hisLine = (body, over = {}) => writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'u1', body, byOwner: true, createdAt: '2026-01-02T10:00:00Z', editedAt: null, ...over }]));
  const ask = (input = '**Ce qui change.** Je la mets en ligne ?', extra = {}) => spawnSync(join(box.home, 'ask-validation.sh'), [ticket, '-', '--pr', '7'], { env: { ...env, ...extra }, encoding: 'utf8', input });
  return { lane, box, env, headOf, publish, merge, merged, moves, ledgerKinds, hisLine, ask, git: laneGit };
}
