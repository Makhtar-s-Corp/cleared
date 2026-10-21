# Cleared v2: decisions log

Each entry has a date, the decision as it was taken, and its consequences for this repository. Path-level verdicts are in [keep-and-drop.md](keep-and-drop.md). Counts were taken on the `v2` branch at commit `bd496f1`.

## 2026-10-21: what Cleared v2 is

**Decision.** Cleared v2 is a harness for many parallel coding sessions. Claude Code and Codex sessions run in parallel, each in its own Docker container. A project lead session coordinates them. v2 also has memory, review by a model other than the author's, and human approval before any deploy, through the existing lock service (the release broker, `serve/release-broker.mjs`).

**Consequences.**
- Sessions are long-lived and run in containers. v1 lanes are one-shot CLI runs in host worktrees, opened by bash (`spawn-lane.sh`, `lane-run.sh`, `flow-lanes.sh`). The lane model is replaced, not ported.
- The release broker and its client `release-request.mjs` stay. So do the checks the broker runs before a merge, today in `merge-pr.sh`.
- Cross-model review stays. `review-pr.sh` (bash) has to exist in Node before milestone 4.
- The project lead becomes a session. The prompts of the v1 lead wake (`prompts/release.md`, `prompts/release-live.md`, `prompts/handover.md`, `prompts/talk.md`) are adapted.

## 2026-10-21: Node for the whole core, no bash

**Decision.** The whole core is written in Node. No bash script remains.

**Consequences.**
- The repository tracks 39 `.sh` files (`git ls-files '*.sh' | wc -l`). All 39 are removed in milestone 4.
- Some of them carry behavior v2 keeps, so that behavior has to exist in Node before the file goes:
  - `merge-pr.sh`: the guarded merge
  - `ask-validation.sh`: the approval request
  - `review-pr.sh`: cross-model review
  - `wake.sh`: the wake
  - `lib/ports.sh`: the port rules
  - `serve/install.sh`: the installer
  - `tracker.sh`, `lib/tracker/adapters/dispatch.sh`, `lib/tracker/adapters/linear.sh`, `lib/tracker/adapters/env.sh`, `lib/tracker/guard.sh`: tracker access
  - the `guard_text` function of `lib/common.sh`
- `.github/workflows/checks.yml` runs `bash -n` on every shell file. That step goes.
- `CONTRIBUTING.md` lists bash and jq as requirements for the local suite. That list changes.
- The jq files under `prompts/` are run by `wake.sh`. Their content moves with the wake.
- 27 of the 36 files under `test/` name a `.sh` file (`grep -lE '[A-Za-z0-9_-]+\.sh' $(git ls-files test) | wc -l`). Tests of kept areas keep their cases and change their harness. Tests of dropped areas go.

## 2026-10-21: app login by password, no passkeys

**Decision.** The app signs the human in with a password. Passkeys are dropped.

**Consequences.**
- These files go: `app/lib/webauthn.mjs`, `app/lib/grant-socket.mjs`, `app/public/register.html`, `app/public/register.js` and `test/app-authenticator.mjs`.
- `cleared app passkey` (`app/main.mjs`) goes.
- Some files lose their passkey parts: `app/lib/actions.mjs`, `app/lib/notifications.mjs`, `app/lib/credentials.mjs`, `app/public/actions.js`, `app/public/notify.js` and `app/screenshots-actions.mjs`.
- Open: today a passkey confirms "Clear to land", "Send back" and turning notifications on, each time. What confirms these gestures with a password login is not decided.

## 2026-10-21: Claude Code first, then Codex

**Decision.** v2 supports Claude Code sessions first. Codex sessions follow.

**Consequences.**
- v1 requires the reviewer to be a different model from the one that wrote the change (README, Principles).
- Until Codex sessions exist, another Claude model reviews: see "model choice per lane" below.
- `lib/route.mjs`, which picks a model per role with fallbacks, is proposed for keep.

## 2026-10-21: what v2 keeps

**Decision.** v2 keeps:
- the tracker contract and adapters (`lib/tracker`), with the local adapter becoming the ticket store
- memory (`lib/memory`)
- the deploy lock service
- automatic and manual rollback
- the post deploy health watch
- the heartbeat and `cleared status`
- the fast lane rules on the real diff
- web notifications
- the private terms and secrets guard
- the SQLite ledger
- the app: the Node server, the snapshot, `app/DESIGN.md` and the en and fr catalog

**Consequences.**
- These paths stay:
  - `lib/tracker/`, `lib/memory/`, `lib/ledger.mjs`, `lib/release.mjs`, `lib/heartbeat.mjs`, `lib/fast-lane.mjs`
  - `lib/guard/`, `lib/notify.mjs`, `lib/notify/`, `lib/i18n.mjs`, `lib/i18n/`
  - `lib/board-collector.mjs`, `lib/board-report.mjs`, `lib/board-scrub.mjs`
  - `serve/release-broker.mjs`, `release-request.mjs`, `cleared` and `app/`
- The local adapter stores tickets, comments and history in `ledger.db` today. Its approval proof needs two system accounts and an Ed25519 key held by the human (docs/trackers.md).
- Open: the three system accounts mode is dropped, so what proves a human approval in the local store is not decided.
- Web notifications are kept. The `ntfy`, `telegram` and `email` adapters in `lib/notify/adapters/` are not named. Open.

## 2026-10-21: what v2 drops

**Decision.** v2 drops:
- the bash lanes
- the one-shot harness adapters (`claude -p`, `codex exec`)
- the terminal adapters (Orca, none)
- the permission translation per CLI
- the three system accounts default mode
- sudo
- bubblewrap
- the heavy operations lock
- passkeys
- the special Codex container mode
- every remaining bash script of the core

**Consequences.**
- Removed in milestone 4:
  - `adapters/` and `lib/contract.sh`
  - `lib/terminal/`
  - the lane scripts (`spawn-lane.sh`, `lane-run.sh`, `flow-lanes.sh`, `kill-lane.sh`, `tidy-lanes.sh`, `adopt-lane.sh`, `tell-lane.sh`, `push-lane.sh`)
  - `when-free.sh`, `host-state.sh` and `lib/screens.mjs`
  - `lead-command.mjs`, `serve/lead-actions.mjs` and `serve/check-harness.sh`
- `[permissions.*]`, `[terminal]`, `[adapter.claude]` and `[adapter.codex]` go from `agents.example.conf` and `docs/configuration.md`.
- `docs/security.md` loses its sections on the agents' account, bubblewrap, sudo and the heavy-command door.
- Some files only serve dropped parts but are not named in the decision. The static dashboard (`dashboard.sh`, `lib/dashboard.mjs`, its three units) and the decision flow of `talk.sh` (`decide.sh`, `confirm-decision.sh`) are examples. They are marked `proposed` in keep-and-drop.md and still need a decision.

## 2026-10-21: removals happen in milestone 4

**Decision.** Most removals happen in milestone 4.

**Consequences.**
- No milestone plan exists in the repository. Every removal in keep-and-drop.md is placed in M4 until one does.
- Until milestone 4, v1 files stay in the tree next to the v2 code.

## 2026-10-21: v1 is stopped without an archive

**Decision.** The owner decided not to archive the v1 state when stopping it, because it is not needed. The v1 services and timers are disabled.

**Consequences.**
- No copy of the v1 runtime state (ledger, lanes, worktrees, snapshot) is made before it stops. v2 starts from the repository, not from a v1 archive.
- The orchestrator reported on 2026-10-21 that the v1 stop was executed and verified, including the disabled services and timers. This change does not verify it.
- The units `serve/` installs are still tracked: `cleared-wake.timer`, `cleared-dashboard-refresh.timer`, `cleared-legacy-import.timer` and their services. Their verdicts are in keep-and-drop.md.

## 2026-10-21: lane branches are named v2-jN-topic

**Decision.** A v2 lane's branch is named `v2-jN-topic`, where N is the milestone number, for example `v2-j0-keep-and-drop`. Its pull request targets the `v2` branch.

**Consequences.**
- The name `v2/jN-topic` is not possible. Git stores branches as paths under `refs/heads/`, so `refs/heads/v2/...` cannot exist next to `refs/heads/v2`. Locally, `git branch -m v2/j0-keep-and-drop` fails with "'refs/heads/v2' exists; cannot create 'refs/heads/v2/j0-keep-and-drop'". The remote has a `v2` branch too.
- The `v2` branch keeps its name.

## 2026-10-21: model choice per lane

**Decision.**
- The model may vary from lane to lane: Haiku for small fixes and simple docs, Opus for the core, Sonnet for review.
- The reviewer is always a different model from the author.
- Fable is allowed only when strong planning is needed, for example splitting a milestone into lanes or designing the session contract. It is never used for coding or review.
- Every use of Fable is logged in this file, with its reason.

**Consequences.**
- Milestone 0 used no Fable.
- The milestone 0 lanes (keep-and-drop, skeleton-ci and adapters-doc) were authored by Opus 5.5 and reviewed by Sonnet 5.5, in two rounds and in fresh sessions. For this lane, the two reviews on its pull request are signed "Sonnet 5.5, fresh session". For the other two lanes, this is as the orchestrator reported it.
- Until Codex sessions exist, the reviewer is a different Claude model from the author. This settles the review question in the "Claude Code first, then Codex" entry.

## 2026-10-21: CI runs on pushes to v2

**Decision.** The v2 workflow and the checks workflow also run on pushes to the `v2` branch, not only on pull requests.

**Consequences.**
- `.github/workflows/v2.yml` gets `push: branches: [v2]`. Its `pull_request` trigger stays on `branches: [v2]`.
- `.github/workflows/checks.yml` (the v1 verify job) had `push: branches: [main]`. It is now `[main, v2]`. Its `pull_request` trigger has no branch filter and is unchanged.
- A push to `v2` now starts both workflows. Their jobs have timeouts of 10 and 15 minutes.
- The guard step of `v2.yml` used `github.base_ref`, which GitHub leaves empty on a push. It now takes `github.event.before` on a push, so the guard checks the commits the push brings. When `before` is all zeros (a new branch), it uses `HEAD~1`. The checkout has `fetch-depth: 0`, so `before` is present in the history. Checked locally: `--base origin/` exits 1, and a real commit as base passes. Not tested on a real push: the push path runs only after merge.
- `test/ci-triggers.test.mjs` reads both `on:` blocks and fails if a trigger is removed.
- Author: Haiku 5.5 (claude-haiku-5-5), lane `v2-j1-ci-housekeeping`.

## 2026-10-21: dashboard-builder is defined outside the repository

**Decision.** The `dashboard-builder` agent is not defined in this repository. Its definition is `~/.claude/agents/dashboard-builder.md`, in the user's agents directory. Its frontmatter says `model: opus`. This lane does not change that file.

**Consequences.**
- The repository has no `.claude/agents/` directory, and no tracked file other than this log names `dashboard-builder`. Checked with `git grep -n dashboard-builder` on the branch, excluding this log.
- The file is per user, so a change to it applies to every project on that machine, not to this repository.
- To run this agent on Haiku, change line 5 of that file to `model: haiku`. This is not tested: the lane did not spawn the agent after the change, so whether the next spawn uses Haiku is unknown.
- The `Agent` tool also takes a `model` argument per call. The spawns in the global CLAUDE.md do not pass one, so the frontmatter decides.
- Author: Haiku 5.5 (claude-haiku-5-5), lane `v2-j1-ci-housekeeping`.

## 2026-10-21: Fable 5.1 used once to plan milestone 1

**Decision.** Fable 5.1 was used once, on 2026-10-21, to plan milestone 1: the split into lanes and waves, the session contract, the event subset, the policy rules and the choice of the Claude Code driving mode. Reason: strong planning, the case the "model choice per lane" entry allows. It wrote no code and reviewed nothing.

**Consequences.**
- The plan is [milestone-1-plan.md](milestone-1-plan.md). Its lanes are authored by Opus 5.5 or Haiku 5.5 and reviewed by Sonnet 5.5, as the model rule says.
- The decisions the plan takes (its section 2) are copied into this log, with their consequences, when the lane that implements each one lands.

## 2026-10-21: the session's Docker runtime (lane 2)

**Decision.** The runtime follows decisions 3 and 4 of the [milestone 1 plan](milestone-1-plan.md), with these choices made by the lane:

1. **The session network has no address on the host.** The internal network is created with `--opt com.docker.network.bridge.gateway_mode_ipv4=isolated`. Reason: on the first doctor run, with `--internal` alone, the network's gateway address was on the host's bridge. From the session, a TCP connect to that address reached a host service listening on all addresses. Every host service listening on all addresses would have been reachable the same way. With the isolated mode the network has no gateway, and the bridge holds no IPv4 address (`ip addr show` lists none besides link-local).
2. **The egress container has its own labelled bridge network**, `cleared-v2-<id>-out`, instead of Docker's default bridge. The plan names one internal network per session. Reason: the default bridge is an object without the label, and the rule is never to run docker against one. Also, egress containers of different sessions would otherwise share a network.
3. **Stop and remove act only on ids a labelled list just returned.** `docker stop`, `rm`, `exec`, `network rm` and `volume rm` take no `--filter`. So `docker.ts` lists with `--filter label=cleared.dev=v2 --filter label=cleared.session=<id>` in the same call, and names only those ids, after `--`. It holds no list of ids in memory, so a restarted service can still stop a session. A listed row without the label is refused, even if the CLI ignored the filter.
4. **The egress proxy:**
   - It accepts `CONNECT` only, to a host name on the allow list, on the listed port. A literal IP address is refused.
   - It refuses a name when any address it resolves to is private, loopback, link-local, shared (Tailscale's 100.64.0.0/10), multicast or reserved, or is one of the host's own addresses. It then dials the address it checked, not the name.
   - The allow list file sits in a folder mounted read only. Reason: the service replaces the file with a rename, which a single-file bind mount would not follow.
   - The proxy listens on the address its `egress` alias has on the session network. That is an address inside the container's network namespace, and nothing is published on the host.
5. **Test services come from a table of known images**, `postgres:16` only in milestone 1. The setting is `[session] services = [alias=]image:tag, ...`, for lane 3's example config. Reason: an image's `VOLUME` would create an anonymous volume without the label. The table makes each such path a tmpfs, and the doctor checks that the Postgres container has no volume mount. Postgres uses trust authentication: a disposable database on a network only the session reaches, so no password exists.
6. **The session container:**
   - It runs as the service's uid and gid, with a read-only root and `HOME=/tmp`.
   - It has no capability and `no-new-privileges`. Its default limits are 4 GB (swap equal), 2 CPUs and 1024 processes.
   - The image creates the config volume's folder with mode 1777, so the volume is writable whatever uid the service has.
7. **The devcontainer reading also takes `build.context`**, which the specification resolves like `build.dockerfile`. Without it, a Dockerfile that copies files from the repository root could not be built. Both paths must stay inside the checkout, symbolic links followed. An `image` the file names is pulled as it is, from any registry, with no check of who published it: the project chooses it, and the README says so.
8. **The image runs Claude Code's postinstall by name** (`npm install --allow-scripts=@anthropic-ai/claude-code`). The npm of `node:24` skips install scripts not allowed by name, and the package's postinstall puts the native binary in place. The SDK's peer dependencies resolved in the image to `@anthropic-ai/sdk` 1.0.0, `@modelcontextprotocol/sdk` 1.32.1 and `zod` 4.6.7. Only the SDK itself is pinned.

**Consequences.**
- The plan's unknowns for lane 2, as the doctor run measured them:
  - Names outside the session network do not resolve on an internal network, so the proxy resolves them.
  - npm and Claude Code 2.1.306 honour `HTTPS_PROXY`.
  - With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (set in the image), a `claude -p` run with an invalid key asked only for `api.anthropic.com:443`. Without it, it also asked for `http-intake.logs.us5.datadoghq.com:443`, which was refused.
  - The default allow list stays `api.anthropic.com` and `registry.npmjs.org`. Hosts a logged-in session needs are unknown until lane 4's run.
- A project whose devcontainer names another image needs Node 24, Claude Code and the SDK in that image for lane 4's runner.
- `docker.ts` gives lane 4 `Docker.attach` (`docker start --attach --interactive`) for the runner's standard streams, and `startSession` with `interactive: true` creates the session container without starting it.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j1-container`.
