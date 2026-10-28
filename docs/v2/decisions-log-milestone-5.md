## 2026-10-25: milestone 5's plan, in thirteen lanes and five waves, and C5 done (the author's choices, lane `v2-j5-plan`, issue #404)

**The need.** Issue #404, docs only. (1) Matrix line C5 (the project page kept up to date) still read `later`, though P59 delivered it in pull request 395 with its tests. (2) Milestone 5 had no plan. The issue asks for `docs/v2/milestone-5-plan.md` from the brief's section 6 and the matrix lines D14, B6.5, B6.5p, C4, C15, C16, C18 and M10: the one-command install (Docker Compose, label `cleared.dev=v2`), the browser setup assistant, `cleared doctor` and the README, with the proof that a newcomer gets a first ticket live in under an hour following the assistant only. The plan splits the work into lanes (files owned, tests, proof) and marks what needs real accounts or a fresh machine. As earlier lanes noted, the brief's section 6 and sections 9 and 10 of `milestone-2-plan.md` are not in the repository. The content is taken from the matrix lines and the two complements, and the conventions from sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md).

**The branch.** The brief asked for `v2/j5-plan`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-plan`, the `v2-jN-topic` form of B4.1.

**Decision.**
1. **C5 is `done`**, delivered by 395 (P59, P240 to P242) after 313 and 363, and proven by P59's three test files. It keeps P59's limit: no screen shows the page.
2. **The plan** ([milestone-5-plan.md](milestone-5-plan.md)) has the proof as ten measured steps (section 1), where milestone 5 starts (section 2) and sixteen decisions (section 3). Among them: Linux with Docker Engine for this milestone, since sibling containers get host paths. A labelled Compose project with `service`, `app` and `broker`, only the app published, on `127.0.0.1`, the port checked first. A setup code on first start. A settings file under the environment, with tokens in their own files and never sent back. One `cleared` command that runs `src/cli/<command>.ts`. Steps and doctor sections as files, so that lanes add files rather than edit shared ones. A forge contract with GitHub behind it. API tokens that never approve. Test secrets encrypted at rest and cleaned from every output. Prepared images keyed by a hash. The setup session as a ticket. Links proposed, never written alone.
3. **Lanes and waves.** Wave 1: `v2-j5-compose`, `v2-j5-assistant`, `v2-j5-forge`. Wave 2: `v2-j5-doctor`, `v2-j5-run`, `v2-j5-connect`. Wave 3: `v2-j5-images`, `v2-j5-gitlab`. Wave 4: `v2-j5-secrets`, `v2-j5-env-setup`, `v2-j5-first-ticket`. Wave 5: `v2-j5-docs`, `v2-j5-proof`. Each lane has its own section with its context, what exists at the end and how it is proven, what is out of scope, the files it owns and the real accounts or machines it needs. Section 17 names the files two waves share.
4. **Matrix.** D14, B6.5, B6.5p, C4, C15, C16, C18 and M10 go from `later` to `planned`, each naming its lanes and the plan's section (rule 3). No `P` line is added: each lane adds its own when it delivers, as the issue says.

**Questions for the owner** (section 19 of the plan; defaults applied where the action stays in this repository):
1. The one command: from a clone with images built on the machine; published images and a Compose file fetched from the registry (recommended); or a published installer image. The lanes build the first. No default for publishing: it is outward facing.
2. What "live" means for a newcomer: merged by the lock with the project's health address green, when it has one (default); or a starter repository deployed to GitHub Pages from a template, which waits, being outward facing.
3. The model's login: a subscription, an API key, or both offered (default: both, the subscription first).
4. The newcomer's machine: Linux with Docker Engine only (default), or macOS with Docker Desktop too.
5. The real run of the proof: a developer and a fresh machine the owner finds (recommended), with a stand-in run as a second rehearsal. No default: it needs a person, accounts and a machine.
6. GitLab: against a fake in milestone 5 with the real trial the owner's (default), or after milestone 5.

**Tests first.** `25c15e1` committed `v2/test/milestone-5-plan.test.ts` alone. On `origin/v2` 5 of its 6 tests failed: C5 not done, no plan, no milestone 5 line in it, no waves, no lane sections. The em dash test passed with nothing to read. One change came with the plan. The waves check read every row that starts with a number, which matched the proof's table of steps, so it now reads the "Waves" section only. The tests check what stays true as lanes deliver: C5 and its test files, every milestone 5 line named in the plan, every lane of the waves with its own section, at most three lanes a wave, and the four headings of each lane. They do not check the `planned` status, which the first lane to deliver changes.

**Checks** (on `origin/v2` at `c3de885`, which had not moved when this was written). `npm run typecheck` passes. `npm test`: 2486 Node tests, 2377 pass, 109 skipped, 0 fail, and 359 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused (the v2 files, and the lines added since `origin/v2`; run without a private-term list, `CLEARED_REPO` unset). The guard does not read `docs/v2/`, so the plan, the matrix and this entry were also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object, no Claude Code login read, no Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, `git fetch` and GitHub (the issue and the pull request), no port but the tests' own ephemeral loopback ones, no tunnel, no secret.

- Pull request: 405, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-plan`.

## 2026-10-25: the forge becomes a contract, with GitHub as its first adapter, and nothing GitHub sees changes (the author's choices, lane `v2-j5-forge`, M10, P247, issue #408)

**The need.** Issue #408, section 6 of [milestone-5-plan.md](milestone-5-plan.md) (decision 10, matrix M10). The service called `gh` from four files: publish (`workspace/publish.ts`), the release card's checks and the repair's failures (`flow/effects.ts`), the Close of a pull request (`flow/pr-close.ts`) and the approval's head (`approval/service.ts`). The lane puts a contract between those files and the forge, with GitHub as its first adapter, the same `gh` calls and no change of behaviour, and `listRepositories()` for the assistant's forge and workspace steps. The brief pointed at sections 9 and 10 of `milestone-2-plan.md`, which has eight, as earlier lanes noted. The conventions followed are those of section 3.1 of the milestone 5 plan: the lane edits its own files, `src/api/types.ts` and `main.ts` untouched.

**The branch.** The brief asked for `v2/j5-forge`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-forge`, as `v2-j5-plan` did.

**Decision.**
1. **The contract** (`src/forge/contract.ts`) has the calls Cleared makes today: list the repositories the credential reaches, read one, find the open pull request of a branch, open one (never a draft), read and replace its body, read its state and branch, read its head commit, sum up its checks (pending, passed, failed), name its failed checks with the end of their logs, and close it with a comment. Decision 10's "comment" is the Close's comment: it is the only comment Cleared writes on a pull request, and GitHub takes both in one call. A separate comment call waits for a caller. The lock's merge stays on `gh` (section 6.3), as does `scripts/proof-base.ts`, which belongs to the proof runs and not to the service.
2. **The GitHub adapter** (`src/forge/github.ts`) makes the same `gh` calls, with the same arguments in the same order, in the same folder and environment. Each call keeps its call site's timeout and output cap: publish's none and 64 MB, the Close's 30 s and 4 MB, the checks' 15 s with exit 8 read as an answer, the failures' 30 s and 16 MB, the approval's head 15 s. A repository that is not owner/name, or a pull request number that is not a positive integer, is refused before any call, so neither can reach `gh` as a flag. A body goes to `gh` as a file of mode 600 in a private folder, removed after the call. A failure is a `ForgeError` that names the call and keeps the end of what `gh` said. Publish turns it into a `PublishError`, whose message now names the subcommand: "gh pr list failed" where it said "gh pr failed".
3. **`listRepositories()`** reads `user/repos`, or `installation/repositories` when the token is an app installation's (its `ghs_` prefix, the only part of it read). It reads page by page, with `--jq` writing each repository as one line of JSON. Repositories come sorted by name, at most 1000, each with its clone address, its default branch, and whether it is private or archived. No caller yet: `v2-j5-connect` (wave 2) is the first.
4. **The `forge` key.** A service's `forge` in the workspace file is `github`, or absent, which means GitHub (`forgeKindOf`). Any other value is refused with a message that names the forges Cleared has. The parsed service carries the key only when the file names it, so a file without it parses exactly as before: two existing tests compare whole services, and they are unchanged. `GET /api/workspace` does not show it, since milestone 5 leaves `src/api/types.ts` as it is. GitLab's lane adds `gitlab` to `FORGE_KINDS`.
5. **The approval's head** goes through the GitHub adapter with no repository. It runs in the v1 checkout that `CLEARED_REPO` names, with the ambient environment, as before. That fallback is not per service today, so it stays on GitHub whatever the workspace says.
6. **`checksOf`** moves to the GitHub adapter, since the buckets are `gh`'s. `flow/effects.ts` exports it from there, so the test that reads it is unchanged.

**Words.** No string a person reads in the app is added or changed. The errors are the service's log, in English like its other errors, and the Close's comment on GitHub is the same text as before.

**Noticed, not changed.** `flow/engine.ts` asks for a release's failed checks without its service. On a workspace of several services, the repair of a single release would read the first service's repository. Fixing it changes behaviour, which this lane does not do. It is named here and in the pull request for a later lane.

**Tests first.** `e794ffc` committed the tests alone: an in-memory fake forge, a fake `gh` over the same world, the contract's cases as one function (`test/forge/contract-cases.ts`, which GitLab's adapter reuses over its own fake), the command lines, the four call sites and the `forge` key. On the code before, none of the four files could load what it tests (no `src/forge/`). Three changes came with the code. The fake `gh` passed an unknown pull request state through as no state, so that case could not see the adapter's error, and it now passes the state as given. An error's pattern was matched against `ForgeError: ...` and no longer expects the message at the start. The `forge` key's case now expects no key on a service whose file does not name it (decision 4).

**The real run** (2026-10-25 18:27:26 to 18:27:36 UTC, the example repository `cleared-example-guestbook` of the organisation this repository lives in, with the `gh` login of this server, its token never read or printed, a scratch clone deleted after the run). One commit adding `FORGE-CHECK.md` on the branch `cleared/FORGE-20261025T1827`, published by `publish()`, which went through the guard of the repository and the adapter: pull request 29 opened, then reused by a second publish. Through the adapter: its state `open` and branch, its head commit the one pushed, its checks `pending` (none reported yet, three seconds after the push), no failed check, the repository read, and `listRepositories()` filtered to the two example repositories before anything was printed. Then the Close: `closed`, a second Close `already_closed`, and the state `closed`. The branch stays on the example repository, since branches are never deleted. The pull request quotes the lines, with the organisation replaced by `<org>`.

**Checks** (at `34f835e`, on `origin/v2` at `e4ffb72`, which had not moved). `npm run typecheck` passes. `npm test`: 2523 Node tests, 2414 pass, 109 skipped, 0 fail, and 359 Vitest tests pass (before the lane: 2486, 2377, 109 and 0). `npm run guard -- --base origin/v2`: nothing refused (the v2 files, and the lines added since `origin/v2`; run without a private-term list, `CLEARED_REPO` unset). Its first run refused two token-shaped words in `test/forge/github.test.ts`, which are now built from parts as in `test/mcp/support.ts`. The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none. Section 6 of the plan now names P247, because `test/milestone-5-plan.test.ts` wants every milestone 5 line of the matrix named in the plan.

**Resources.** No Docker object, no Claude Code login read, no Slack, Cursor or Codex account, no network beyond `npm ci` of the lock file, `git fetch` and GitHub (the issue, the example repository's clone, push and pull request 29, the pull request of this lane). No port but the tests' own ephemeral loopback ones, no tunnel, no secret printed.

- Pull request: 409, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-forge`.

## 2026-10-25: the one command, a labelled Compose project on the host's loopback (the author's choices, lane `v2-j5-compose`, D14, B6.5, P248, issue #406)

**The need.** Issue #406, section 4 of [milestone-5-plan.md](milestone-5-plan.md): D14 and B6.5 ask for one server, Docker Compose and a one-command install that is part of the product. Every Docker object labelled `cleared.dev=v2`, never ports 80, 443, 8787, 8788 or 8790 to 8793, no image published, nothing on a real server. As earlier lanes noted, the brief's section 6 and sections 9 and 10 of `milestone-2-plan.md` are not in the repository. The plan stands in for the first, and sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md) for the conventions.

**The branch.** The brief asked for `v2/j5-compose`. Git refuses that name beside the local branch `v2`, so the lane runs on `v2-j5-compose`, B4.1's form, as `v2-j5-plan` did.

**Decision.**
1. **Nothing is published; the three containers share the host's network and bind `127.0.0.1` only.** This changes the plan's decision 3, "only the app is published, on `127.0.0.1`". The app finds the service at `http://127.0.0.1:<CLEARED_V2_PORT>` and refuses any address of its own but loopback (`app/src/config.ts`). A port published from a bridge network reaches the container's interface, never its loopback. So publishing would have meant opening the app to every address of its container and teaching it the service's name, in a file no lane owns, against B3.2. On the host's network the service's list of host addresses, which the egress refuses, is the host's own, as by hand. The three listeners (service, app, previews) are each checked, not only the app's. The file declares no network and no named volume, so Compose makes nothing the label could miss.
2. **The one command is `docker compose -f v2/compose.yaml run --rm install`.** This changes the plan's decision 4, `up -d`, which can neither check a port before it starts nor print the address. `install` is a service of the file in the profile `install`, on the host's network, with the socket, the clone read only at `/opt/cleared/clone` and the state folder. It runs `src/cli/install.ts`, which calls `docker compose --project-name <name> --project-directory <clone>/v2 --file <clone>/v2/compose.yaml up -d service app broker` with the variables it was given. `-p` and `COMPOSE_PROJECT_NAME` both reach it (checked with `docker compose config`). The person needs Docker and git only.
3. **The order.** The settings first (ports neither reserved nor repeated, an absolute state path with no colon or space), before Docker is asked anything. Then Docker and Compose. Then what of the project runs (`docker ps` filtered on the label and `com.docker.compose.project`). When the service, the app and the broker all run, nothing else happens but the address. Then the clone's owner, never root. Then the ports through `lib/ports.ts`, except those of a container of the project that already runs. Then the state folder: made for the owner, mode 700, or refused when it is another account's or others may write in it. Then the session and egress images, built when missing under the tags `src/container/session-runtime.ts` names, and `up -d`. Then the app's first answer, within 3 minutes, and the service's last log line that names `/setup`. That line is the hook for the setup assistant's code (decision 5 of the plan, lane `v2-j5-assistant`): whatever that lane writes on such a line is shown as it is. Exit 0, 64 for a setting refused, 69 when Docker does not answer, 1 otherwise.
4. **The state folder** defaults to `/var/lib/cleared-v2`, outside any home and outside the clone, where `git clean -fdx` would wipe the ledger and the keys. It is mounted at its own path in every container. When it is missing, Docker makes it, empty and root's, to mount it in the install, and the install gives it to the clone's owner. A refusal cannot remove that empty mount point from inside the container: the command says so, and the next run takes it as it is.
5. **Each role runs as the state folder's owner, never root.** The image's entrypoint (`images/cleared/entrypoint.ts`) starts as root and takes the owner's uid and gid. It adds the socket's group for the service alone, then loads the role's program in the same process. A missing folder, one of root's, or one others may write stops the role (exit 78) with the install's command. `HOME` is a folder of the state folder: no home of the machine is mounted, so no login file of the owner's can reach a container. The install alone stays root, to give the folder away. `init: true` reaps the lock's child processes.
6. **The broker runs under the service's account, with `[security] allow_shared_uid`.** This closes the two unknowns of section 4.6 and changes the plan's decision 2 ("under its own user, sharing only its socket's volume"). `serve/release-broker.ts` accepts its own uid, the agent account's and the human account's (`getent` names, which a container does not have). It requires the state folder and the socket's parent to be its own, and it reads the ledger and the review records there. Under another user it would refuse the service. The risk `allow_shared_uid` names, an agent under the same uid calling the socket, does not exist: agents run in session containers that mount neither the socket nor the ledger (decision 7 of milestone 1). Its identity at the forge is the service's: `forgeGhEnv` uses the ambient `gh` credential, here what `gh` finds under the state folder's `HOME`, unless a GitHub App is configured. Until `CLEARED_V2_PROJECT_DIR` names a checkout with `.cleared/agents.conf`, the broker says so and idles. It is restarted once the project is connected.
7. **The image.** It is built from `node:24`, the one on this server, Debian bookworm. Bookworm's `docker.io` is 20.10, which Docker 29 refuses, and its `gh` 2.23 has no `gh pr checks --json`; the first two real runs failed on these packages. So the Docker CLI (29.8.1), Compose (5.5.1) and buildx (0.37.1) come from Docker's apt repository, as on this server, its key checked against the fingerprint `9DC858229FC7DD38854AE2D88D81803C0EBFCD88` before apt trusts it. `gh` 2.101.0 comes from its release's `.deb`, checked against the SHA-256 the release publishes for amd64 and arm64: GitHub's apt repository keeps only the latest version, and its 2022 signing key expired on 2026-09-05. Buildx makes Compose build with BuildKit inside the install. Without it, the third run used the classic builder, whose intermediate containers carry no label. `Dockerfile.dockerignore` keeps the history, the clone's dependencies, any `.env`, ledgers, keys, tests and documents out of the build.
8. **`cleared <command>`** (`src/cli/cleared.ts`) runs `src/cli/<command>.ts` with its arguments and its exit code. A name is lower-case words and dashes, never a path. With no command or `help` it lists the commands; an unknown one also, with exit 64. In the image it is the entrypoint's `cleared` role, run as the owner: `docker compose exec` would run it as root.
9. **Words.** `src/cli/messages/install.{en,fr}.json` and `cleared.{en,fr}.json`, over the shell's units of time, in `CLEARED_V2_APP_LANGUAGE`, French by default as the app. Durations go through `app/web/lib/time.ts` ("33s", "1 min"); numbers go in as text, since the translator groups digits ("18,792"). No key says "token", "secret", "key" or "pass".

**Questions for the owner** (defaults applied, all inside this repository):
1. Decision 1 above, nothing published and the host's network (applied), or a bridge network with the app published, which needs the app to listen on its container's address and to find the service by name.
2. The state folder's default: `/var/lib/cleared-v2` (applied), or a folder of the owner's home (`~/.local/state/cleared-v2`), which Docker would make as root, parents included, when it is missing.
3. The broker's project: `CLEARED_V2_PROJECT_DIR`, read when the broker starts (applied), or the settings file of the assistant (decision 6 of the plan), read again while it waits, once that lane names its keys.

**Tests first.** `fd99795` committed the four test files before any code. On `origin/v2` none could load what it tests: no `compose.yaml`, `install.ts`, `entrypoint.ts` or `cleared.ts`. Changes to those tests came with the code. Two are changes of expectation from the real runs: the image's packages (Docker's own and `gh`'s release `.deb` with their pinned versions, fingerprint and checksums, then buildx, where the first version asked for Debian's `docker-cli` and `docker-compose`), and `init: true` on the three containers. The others are words: the shell's durations ("33s" in English, "33 s" with a non-breaking space in French, "3 min" likewise), the French quotes of the dispatcher's refusal, which keep their non-breaking spaces, the state folder's refusal, which says "Other accounts may write", and the catalog test, which also reads the keys the code passes through `refuse`, `InstallError` and `EntryError`.

**The real runs** (2026-10-25, 18:35 to 18:45 UTC, on this server, project `cleared-v2-j5try`, ports 18791, 18792 and 18794, free by `ss -ltn` before each run, the state folder in the session's scratch folder, `CLEARED_V2_APP_LANGUAGE=en`; the labelled images, containers, networks and volumes listed before). Runs 1 and 2 failed in the image's package step (decision 7) and made nothing. Run 3 built the three images, started the three containers and said "Cleared answers on http://127.0.0.1:18792/ (answered in 1 min)", 2 min 12 s from the command, but its inner builds used the classic builder. Run 4, after the three containers and three images of run 3 were removed by label: "answered in 33s", 1 min 48 s from the command to the end, no intermediate container, though neither run started from an empty build cache. Each role ran as uid 1000, the clone's owner, and only the service had the socket's group (990). Each container had the label, the host's network and no published port. The three listeners were on `127.0.0.1` only, `/health` answered `{"status":"ok"}` and the app `303` to its sign-in. The broker said it waits for a project. A second run took 0.8 s, said "Cleared already runs (cleared-v2-j5try) on http://127.0.0.1:18792/: nothing was changed." and recreated no container; in French, the same words. A second project asking for 18792 was refused, "CLEARED_V2_APP_PORT is 18792, and 127.0.0.1:18792 is already in use on this machine. ... Nothing was written.", and said the empty folder Docker had made for the mount, which was then removed. Afterwards the containers and images of the runs were removed by the label and the project's, and the labelled images, containers, networks and volumes matched the lists made before. How long the images take on a machine with no cache stays the proof's. The egress's isolated gateway mode under Compose was not run: `doctor docker` binds `127.0.0.1:8791`, which this lane may not, so that unknown of the plan's section 21 stays open for `v2-j5-doctor` or the rehearsal.

**Checks** (at `bfef897`, the merge of `origin/v2` at `3026f55`, pull request 409 merged meanwhile). `npm run typecheck` passes. `npm test`: 2558 Node tests, 2449 pass, 109 skipped, 0 fail, and 359 Vitest tests pass. `npm run guard -- --base origin/v2`: nothing refused (841 v2 files, and the lines added since `origin/v2`; run without a private-term list, `CLEARED_REPO` unset). The guard does not read `docs/v2/`, so the matrix, the plan and this entry were also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** Docker on this server. The containers and images the runs made carried `cleared.dev=v2` and were removed by that label and the project's afterwards, with three exceptions said plainly. Run 3's inner builds used the classic builder, whose intermediate containers carried no label and which Docker removed at once (buildx since). Runs 1 and 2 failed in the package step and left no container or image. The build cache of the builds stays on the server: it is no labelled object, and pruning it would touch other builds. The base image `node:24` was read by the builds, not pulled. No Claude Code login read, no home mounted, no Slack, Cursor or Codex account. Network: `npm ci`, Debian's and Docker's apt repositories, GitHub's release of `gh` and its key, `git fetch` and GitHub for the issue and the pull request. Ports 18791, 18792 and 18794 on `127.0.0.1` during the runs, the tests' own ephemeral loopback ones, no tunnel, no secret.

- Pull request: 410, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-compose`.

## 2026-10-25: the one-command install builds on the machine, nothing published (the owner's decision of 19:33, question 1 of milestone 5, lane `v2-j5-compose`, D14, P248, issue #406)

**Decision.** By the owner, 2026-10-25 19:33, relayed by the lead: the one-command install is git clone, then docker compose up, with the images built locally on the machine; nothing is published to any registry.

**What it settles.** Question 1 of [milestone-5-plan.md](milestone-5-plan.md) section 19 is answered (a). Options (b), images and a Compose file on the organisation's registry, and (c), a published installer image, are not taken. The plan's sections 18, 19 and 20, `v2/README.md` and matrix lines D14 and P248 now say so. D14 goes from `partial` to `done`: what it waited for was this question.

**What pull request 410 does about it.** `v2/compose.yaml` builds every image it names from the clone: Cleared's own `cleared-v2:local` through the `install` entry, and the session and egress images through their build-only entries. The three running containers have `pull_policy: never`, so Compose never pulls Cleared's image from a registry. No image name in the file names a registry or a namespace. `docker compose config --images` lists `cleared-v2:local`, `cleared-v2-session:2.1.306` and `cleared-v2-egress:1` only. A new case of `test/install/compose.test.ts` keeps it so, and also keeps each of the three Dockerfiles on `FROM node:24` alone. That base is the one image a build reads from outside: Docker Hub's `node:24`, pulled when the machine does not have it. The README says so.

**Said to the lead.** The decision's words are "docker compose up". The command this branch ships after `git clone` is `docker compose -f v2/compose.yaml run --rm install`, a Compose command that checks Docker, the ports and the state folder, then runs `docker compose up -d` itself (the lane's log entry of today, decision 2). A bare `docker compose -f v2/compose.yaml up -d` on a fresh machine stops at the missing `cleared-v2:local` and pulls nothing. If the owner wants the bare `up` to be the command, that is a change of `compose.yaml` and the entrypoint for a next commit or lane, not made here.

- Pull request: 410, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-compose`.

## 2026-10-25: the browser setup assistant: a setup code at first start, the owner's account, GitHub and Claude Code checked on the spot, a stub for each later step (the author's choices, lane `v2-j5-assistant`, B6.5, P249, issue #407)

**The need.** Issue #407, section 5 of [milestone-5-plan.md](milestone-5-plan.md) (matrix B6.5): a newcomer today reads `v2/README.md`, sets variables, runs `npm run setup` and `npm run user` and commits a public key. The lane makes the first start of decision 5 (a setup code, `/setup` alone until the owner exists), the settings file of decision 6, the steps' registry of decision 9 with a stub per step of the proof's section 1, the records of each step (the person's time and the machine's), and fills three steps: the owner's account, the forge credential and the model login (decision 7). French and English, accessible, fakes only. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-assistant`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-assistant`, as `v2-j5-plan` and `v2-j5-forge` did.

**Decision.**
1. **The setup code** (`src/setup/code.ts`). On a ledger with no user, the setup module's start makes eight characters from 32 that cannot be misread (no 0, O, 1 or I), in two groups, keeps only their SHA-256 and their end (24 hours) in `v2_setup_code`, and prints one line, `cleared-v2: setup code ABCD-EFGH, valid until <time>: ...`, which `SETUP_CODE_LINE` reads for the one command (lane `v2-j5-compose`). A restart makes a new code and the old one stops. The app's `POST /setup/owner` checks the code, the empty ledger and the end, inserts the user and spends the code in one `BEGIN IMMEDIATE` transaction, so two posts at once make one owner (a test sends two). The code is dead once any account exists, even one made by `npm run user`. Wrong codes go through the sign-in form's throttle (five in 15 minutes, then 429 with `retry-after`), and the post needs the sign-in form's origin checks.
2. **The gate is `app/main.ts`'s** (`AppOptions.setup`), checked at each request: while the ledger has no account, every page and `/login` send to `/setup`, and the page's own files, catalogs and theme script are served as before. An app made by a test with no user still sends to `/login`, so no earlier test changed.
3. **The owner step.** The app makes the account (the name and password rules of `users.ts`, and a name other than the service account's, as `npm run setup` refuses), signs the owner in, makes the approval key as `npm run setup` does (the writing moved to `src/setup/approval-key.ts`, which `src/cli/setup.ts` now calls, its test unchanged), and names the owner in the settings (`CLEARED_V2_OWNER_ID`, which `approval/conf.ts` now reads when the project's file has no `owner_id`). The page shows the public half as the line `human_public_key = ...` and where it goes, `[tracker]` of the project's `.cleared/agents.conf`; never the private key. A key already on the machine is kept and its public half shown.
4. **The settings file** (`src/setup/settings.ts`): `<state>/settings.conf`, mode 600, in the format of agents.conf, with two sections, since Cleared's settings are environment variables: `[env]` gives a variable its value, `[env_files]` gives it the content of a file of mode 600, so no credential is a line of it. Only `CLEARED_*` variables and `GH_TOKEN` may be set, so the broker's `CLEARED_V2_PROJECT_DIR` (question 3 of lane `v2-j5-compose`) can be one line of `[env]`. `src/setup/load.ts` is the first import of `src/main.ts` and `app/main.ts`, so the file applies before any module reads a setting; a variable the environment set wins, then and every later time the file is read again (the setup module reads it before each request, so what the app wrote reaches the service). A credential file that is a link, another account's, readable by others or empty is not applied, and the log names the variable.
5. **The forge step** (`src/setup/steps/forge.ts`) checks a GitHub credential on its own, as section 17 says (`listRepositories()` of lane `v2-j5-forge` merged meanwhile; lane `v2-j5-gitlab` moves the step onto the contract): one read of `GET /user/repos?per_page=100`, the credential in the authorization header only, 15 s at most. GitHub's 401 and 403 are said apart, no answer is "unreachable", and a credential that reaches no repository is refused. One that passes is written to `<state>/forge-github.token`, named as `GH_TOKEN`'s file, and set in the service at once. The answer gives the number of repositories, whether there are more, and five names; no answer, settings line or log holds the value. A `GH_TOKEN` or `GITHUB_TOKEN` the environment gives is shown as such and not replaced from the browser. The API address is GitHub's, or one on loopback for a test (`CLEARED_V2_FORGE_GITHUB_API`).
6. **The rights of a fine-grained credential** (the plan's unknown of section 5.6), listed on the step from the `gh` calls of section 6 and the lock's merge, and checked against GitHub's page "Permissions required for fine-grained personal access tokens": Metadata read, Contents read and write, Pull requests read and write, Commit statuses read; Workflows read and write only for a ticket that changes `.github/workflows/`, Issues read and write only for the GitHub Issues mirror. GitHub's page lists no Checks permission for these credentials, so whether `gh pr checks` reads check runs with one is left to the rehearsal or the real run; the step says a classic credential with the `repo` scope works too.
7. **The model step** (`src/setup/steps/model.ts`) takes what `claude setup-token` prints (one line, `sk-ant-oat01-…` today; only a paste with a space, one too short and an API key are refused, so a change of its prefix does not lock a newcomer out), writes it to `<state>/claude.token`, where the Claude Code adapter already reads it, names it as `CLEARED_CLAUDE_CREDENTIALS` and sets that in the service. Its terminal is a shell in a throwaway container of the session image (`src/setup/container.ts`): a fresh id, labelled `cleared.dev=v2` and `cleared.role=setup`, no mount, no credential in its environment, every capability dropped, no new privileges, 512 MB, one CPU and 128 processes, Docker's default network (the command signs in on the web), an hour at most, removed by label and name when the terminal closes. It goes through the web terminal's manager with no journal and no first line, one at a time, the owner's only, and through the app on the loopback address only, as a session's terminal (`TERMINAL_PATH` now names both). The session terminal's stream became `streamTerminal`, shared, and a terminal program may replace its first line (`intro`); the session's behaviour is unchanged.
8. **The registry** (`src/setup/steps.ts`, `src/setup/step.ts`): a step declares whether it is filled, whether it may be skipped, its tables, its routes under `/api/setup/<its id>` and, if its state is not only its record, when it is done. The owner, forge and model cannot be skipped. `workspace`, `environment`, `secrets`, `checks` and `first-ticket` are stubs that can be skipped, each with its file, its screen and its catalog pair under the names the later lanes own. `src/setup/summary.ts` is not made: it is lane `v2-j5-first-ticket`'s.
9. **The records** (`src/setup/records.ts`): when a step was shown (the first time counts), done or skipped, and the machine's time on it (the forge's check, the terminal's start). The person's time is the time from shown to done or skipped less the machine's, never below zero. `GET /api/setup` answers every step with its state and times and the totals.
10. **Modules.** `setup` filled, `run` and `secrets` stubs, in `MODULE_NAMES` and `src/main.ts` (twelve modules); the three tests that list the modules name them.
11. **The screens** (`app/web/screens/setup/`): a page of its own at `/setup` and `/setup/<step>`, drawn by its own chunk (`main.tsx` imports it on that page only), with its own catalogs (`setup` and `setup-<step>`, read by the catalog tests). A progress line names every step with its state and time in words beside its mark, the current one marked `aria-current="step"`; Back, Skip where a step allows it, Continue once it is done; the address follows the step, so the browser's Back goes back a step; the last page says the time taken, the person's and the machine's. Times as `app/web/lib/time.ts` says them, dates as "25 October", "25 octobre". The web terminal's component takes another root and a shell only for this step.
12. **Words.** No catalog key says "token", "secret", "key" or "pass", which the guard reads with its value as an assigned secret (P246 found it first): the owner's password is `owner_phrase`, its refusal `phrase`, the secrets step's prefix `test_values` (`stepKey`), the approval key "the approval signature". The guard's first strict run refused `setup_step_secrets`, the secrets step's two keys, `owner_error_password` and a constant named `NEW_TOKEN`; all were renamed before the pull request.

**Questions for the owner** (defaults applied):
1. An API key for the model: not offered (applied), since the Claude Code adapter reads a subscription's token only and unsets `ANTHROPIC_API_KEY` in its sessions; question 3 of the plan's default ("both") needs the adapter to read a key first, a lane of its own. Or offer it now and leave it unused, which this lane did not do.
2. The terminal's network: Docker's default network (applied), since `claude setup-token` signs in on the web; or the session's egress with an allow list for Anthropic's sign-in addresses, which the proof's real run can measure.
3. The public key still goes into the project's `.cleared/agents.conf` by a commit the owner makes (applied, as the plan's section 5.2 says); the first ticket's lane could propose that line as its first change instead.

**Open: the running service sees the new key at its next start.** The approval module builds its environment once, when the service starts (`approvalEnvironment` in `approval/service.ts`, called by the module's `provide`): it loads the signing key and reads the owner then. On a fresh install the service starts before the owner exists, so until it restarts, an approval is refused with "no approval signing key", although the owner step made the key and named the owner. Nothing here restarts the service. Proof step 9 needs it: lane `v2-j5-first-ticket` (or `v2-j5-compose`, with a restart the one command owns) closes it, by building the approval's environment when it is first needed, or reading it again when the settings change.

**Not done here.** The forge step's real check against the example repository (plan section 5.5) was not run: the issue says fakes only, so the step is proven against a fake GitHub on loopback, and the real check is the rehearsal's or the real run's. A real `claude setup-token` in the terminal stays the proof's (section 5.6).

**Tests first.** `6b5ba28` committed the tests alone, with the module lists and the catalog test taught the new modules and catalogs. On it, 13 of 25 failed: the twelve new test files could not load what they test (no `src/setup/`, no setup module, no setup catalogs), and the two module-list tests found nine modules. Changes that came with the code: the fake container of `test/setup/model.test.ts` fired its exit inside its end, which no process does, and now fires it after; the screens' time cases expect the shell's own units ("2 min" with a no-break space, "40s" in English); `visibleText` gives a list, which the cases now join. The owner's short password is refused as `phrase`, not `password` (decision 12), and its case says so. After the review, `test/setup/owner-conf.test.ts` was added for the owner `approval/conf.ts` now reads from the settings, the model step's check was loosened as decision 7 says, and the phone's progress line keeps each step's state for assistive technology (it was hidden with `display: none`). Four existing tests changed with the code: the bundles test lets the setup screen reach xterm by a dynamic import, as the session screen does, and still no other screen; the i18n audit reads the setup catalogs, gives the setup screen's files the shell's catalog, the assistant's and every step's, and names why fourteen French strings equal the English ones (GitHub's own names of the permissions and accesses, GitHub and Claude Code, the command, Shell, and a template whose only word is "machine"); the copy test made the forge's "no repository" sentence one sentence; the tokens test made the code block's font a family, a size and a line height.

**Captures** (`docs/v2/setup-assistant/`): the forge step at 1440, 1280, 768 and 390 px, light and dark, in English; the model step with its terminal open in French; the last page. Taken by `app/test/setup/setup-browser.test.ts` with `CLEARED_V2_CAPTURES`, on loopback ports the kernel picked.

**Checks** (after the review's changes, on the merge of `origin/v2` at `c7de110`, pull requests 409 and 410 merged). `npm run typecheck` passes. `npm test`: 2614 Node tests, 2503 pass, 111 skipped, 0 fail, and 366 Vitest tests pass (on `origin/v2` at `e4ffb72`, before the lane: 2486 Node tests and 359 Vitest tests). `app/test/setup/setup-browser.test.ts` with `CLEARED_V2_PLAYWRIGHT` set: both languages pass, axe finding nothing. The whole suite with `CLEARED_V2_PLAYWRIGHT` set, before the merge: 2537 pass, 2 skipped, 1 fail, `app/test/notify/browser.test.ts` (the button is never offered in this server's headless Chrome), which fails the same way on `origin/v2` at `e4ffb72` without this lane. `npm run guard -- --base origin/v2`: nothing refused (decision 12). The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object (the container is proven against the fake docker CLI), no Claude Code login read, no GitHub, Slack, Cursor or Codex account used, no network beyond `npm ci` of the lock file, `git fetch`, GitHub's documentation page and GitHub for the issue and the pull request. No port but the tests' own ephemeral loopback ones, no tunnel, no secret.

- Pull request: 412, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-assistant`.

## 2026-10-25: the VAPID key test with a leading zero byte signs with fixed scalars, no random draw (the author's choices, lane `v2-j5-vapid-flaky`, P250, issue #411)

**The need.** Issue #411: the test "a VAPID key whose private scalar starts with a zero byte is kept on 32 bytes and still signs" (`test/notify.test.ts`, at the repository's root, run by the `checks` workflow) failed once in CI on pull request 410 and passed on the rerun. Make it deterministic with a fixed key. The same brief asked for question 1 of [milestone-5-plan.md](milestone-5-plan.md) section 19 to be marked as the owner's decision of 2026-10-25 at 19:33, option (a), images built on the machine, nothing published, and for no file under `v2/src/setup`, `v2/src/modules` or `v2/app/web/screens/setup` to be touched. As earlier lanes noted, the brief's section 6 and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md).

**The branch.** The brief asked for `v2/j5-vapid-flaky`. Git refuses that name beside the local branch `v2`, so the lane runs on `v2-j5-vapid-flaky`, B4.1's form.

**The cause, from the CI's log.** The first attempt of run 40223470582 (workflow `checks`, at `edee589`) says `Node drops the leading zero: the case is exercised` and `30 !== 31`, at `test/notify.test.ts:87`. The test made its scalar from a zero byte and 31 random bytes, then expected Node's `getPrivateKey()` to give 31 bytes back. When the first random byte was a zero too, about once in 256 draws, Node dropped both zeros and gave 30. The product was right: `scalar()` in `lib/notify/adapters/webpush.ts` pads any length back to 32 bytes. The test's own check of its setup was what failed.

**Decision.**
1. **Two fixed scalars, no draw.** The case runs on a zero byte then 31 bytes of `0x42`, and on two zero bytes then 30 bytes of `0x42`. Both are valid P-256 scalars, below the group's order. The loop that drew again on a refused scalar and the `randomBytes` import it alone used are gone. The two-zero case is the one the CI drew.
2. **The setup check names the length it expects**, 31 or 32 minus the zeros. Each key is kept on 32 bytes and signs, kept long or kept short as an earlier version did, checked with the public key as before.
3. **No change to `lib/`.** Nothing in the product was wrong.
4. **Question 1 of the plan: no edit.** At `origin/v2` `c7de110`, section 19 already says "Answered by the owner on 2026-10-25 at 19:33, relayed by the lead: (a)", the images built on the machine and nothing published to any registry, and sections 18 and 20 say the same. Commit `edee589` of pull request 410 wrote it, with its own entry above. Nothing is left to mark.
5. **The plan names P250.** `v2/test/milestone-5-plan.test.ts` wants every milestone 5 line of the matrix named in the plan, so section 17 gets one sentence after its waves: this lane runs outside them and edits no file of theirs.

**Tests first.** The old assertion, run in a scratch script against the two fixed scalars: one zero passes; two zeros fail with the CI's own words, `Node drops the leading zero: the case is exercised`, `30 !== 31`. `4584893` holds the new test, the only change of code in this lane.

**Checks** (Node 24.21.0, at `origin/v2` `c7de110`). The case alone, 300 runs one after another: 300 pass, 0 fail. The `checks` workflow's steps: `tsc -p .` with the types of `v2/` passes; `node --no-warnings --test --test-timeout=120000 test/*.test.ts`: 405 tests, 403 pass, 2 skipped, 0 fail. In `v2/`, `npm test` with the plan's sentence: 2559 Node tests, 2450 pass, 109 skipped, 0 fail, and 359 Vitest tests pass. `npm run guard -- --base origin/v2` in `v2/`: nothing refused (841 v2 files, and the lines added since `origin/v2`; run without a private-term list, `CLEARED_REPO` unset). The guard does not read `docs/v2/`, so the matrix line and this entry were searched for the owner's name and the first piloted project's: none.

**The merge of 412** (lane `v2-j5-assistant`, issue #407, at `origin/v2` `282907e`). 412 took the id P249 for the setup assistant, so this lane's line is P250: ids are never reused. The matrix keeps P249, then P250; the log keeps 412's entry, then this one; the plan's section 17 names P250. 412 changes no file under the root's `test/` or `lib/`, and section 19 still says question 1 answered (a). After the merge: `tsc -p .` and the root's `test/*.test.ts` as the `checks` workflow runs them, 405 tests, 403 pass, 2 skipped, 0 fail; in `v2/`, `npm run typecheck` passes and `npm test` runs 2614 Node tests, 2503 pass, 111 skipped, 0 fail, and 366 Vitest tests pass; the guard, below.

**Resources.** No Docker object, no port, no Claude Code login read, no Slack, Cursor or Codex account. Network: `npm ci` of `v2/`'s lock file, `git fetch`, and GitHub for the issue, the CI's log and the pull request. No tunnel, no secret.

- Pull request: 413, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-vapid-flaky`.

## 2026-10-25: `cleared doctor` says whether an install is ready, read only, and the assistant's checks step shows it (the author's choices, lane `v2-j5-doctor`, B6.5, B4.6, P251, issue #415)

**The need.** Issue #415, section 7 of [milestone-5-plan.md](milestone-5-plan.md) (matrix B6.5, B4.6): `scripts/doctor.ts` was written for the lanes, builds images and starts a session by default, and speaks English. B6.5 asks for `cleared doctor` as a product command, and step 8 of the proof asks the assistant to show its checks, each green or red with what to do. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan ("one doctor, sections as files").

**The branch.** The brief asked for `v2/j5-doctor`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-doctor`, B4.1's form, as the other milestone 5 lanes did.

**Decision.**
1. **A section is a file.** `src/doctor/section.ts` names the shape: a name (the file's), whether it runs by default, a title and a run in a language, which answers lines, each with a stable id, a level (passed, failed, a notice, not run), its text and, for a failure, what to do. `src/doctor/sections.ts` loads every file of `src/doctor/sections/`; a file named as one of `scripts/doctor.ts`'s own sections, or whose section is named apart from the file, is refused, so no file hides another. `scripts/doctor.ts` runs a section file when it is named, or when it runs with no name and the section says so; its lines print as `mirror`'s (`PASS`, `FAIL`, `NOTE`, `NOT RUN`), what to do indented under them, and a failure counts in its exit code. The diff to `scripts/doctor.ts` is the loader and its header alone.
2. **The ready section** (`src/doctor/ready.ts`, `src/doctor/sections/ready.ts`) is read only: Docker is asked its version and lists filtered on `cleared.dev=v2` through `Docker` (so the label rule holds), nothing is built, made, started or removed; GitHub is read twice (`GET /user`, then `GET /repos/{repo}` for each GitHub repository of the workspace); git reads each checkout's `origin` and `refs/remotes/origin/<base>` and fetches nothing (`projectCheckout`, which clones and fetches, is not called); no session, no model call. Twelve checks, in this order: `docker`, `labels`, `images`, `pool`, `state`, `disk`, `settings`, `credentials`, `model`, `forge`, `repository`, `checkout`. When Docker does not answer, the three that need it are not run, and when its lists ignore the label filter, the images and the pool are not run either, since their lists would name what is not Cleared's; likewise the disk and the settings without a state folder, and the repositories without a token GitHub accepts or without a workspace.
3. **The model login is looked at, never opened.** Where the Claude Code adapter reads it (`claudeCodeRuntime(env).loginFile`: `CLEARED_CLAUDE_CREDENTIALS`, else `claude.token` in `CLEARED_V2_STATE_DIR`): its kind, owner, mode and size from `stat`. A test makes the file mode 000 and the check still passes, which it could not if the file were read. The files the settings name for a variable (`[env_files]`) are judged the same way, by `lstat`, as `readCredential` accepts them, so no value is ever in the doctor's memory but the forge token, which travels in the authorization header only and is scrubbed from every line before it leaves.
4. **Thresholds.** Two free subnets (one session's two networks, as `doctor pool` says). The state folder's disk fails under 5 GB and is a notice under 20 GB: the session image alone is several gigabytes, and each ticket has its checkout. The state folder fails when another account owns it or may write in it (the install's own rule, `src/cli/install.ts`); readable by others is a notice, since the install makes it 700.
5. **No workspace yet is a notice**, said once by the checkout line; the repository line waits for it. The workspace step is a stub until lane `v2-j5-connect` fills it, and a newcomer who skipped it is not stopped by the checks.
6. **`cleared doctor`** (`src/cli/doctor.ts`) applies the settings file first (`setup/load.ts`, the import before any other), as the service does, so a token the assistant saved is seen. With no argument or `ready`, the ready section, each line marked in words (`ok`, `failed`, `note`, `not run`; `ok`, `échec`, `à noter`, `non vérifié`), what to do under it, then how many failed; exit 0 when none failed, 1 otherwise, 64 for an argument it does not know. `cleared doctor --full [args]` runs `scripts/doctor.ts` with the rest and ends with its code. `CLEARED_V2_DOCTOR_SECTIONS` names another folder of sections, for the tests, as `CLEARED_V2_CLI_DIR` does for the commands.
7. **The checks step** (`src/setup/steps/checks.ts`, filled): `POST /api/setup/checks { language }` runs the ready section in the page's language (another language, or none, is the app's), counts the run as the machine's time, and marks the step done when no line failed. Docker and the disk are reached through probes, the machine's by default and fakes in the tests (`checksStep(probes)`); GitHub through the setup module's own `fetch`. The step may be skipped, as the stubs before it can be. The answer's shape is `src/doctor/types.ts`'s, as section 3.1 asks.
8. **The screen** (`Checks.tsx`, `checks.css`, a file of its own beside the assistant's `setup.css`): the summary first, in a live region; each line with its level in words in its own column and a bar of the level's colour, so colour is never the only sign; what to do under a failure or a notice, never under a passed line; Check again; the same command for a terminal. It runs once when the step opens, not again when the assistant reloads its view.
9. **Words.** `src/doctor/messages/ready.{en,fr}.json` and `doctor.{en,fr}.json` for the section and the command, `app/messages/setup-checks.{en,fr}.json` for the screen. French with a no-break space before `:` and a narrow one before `;`, as the app's catalogs. No catalog key says "token", "secret", "key" or "pass" (P246, P249); the values say "token" and "jeton", as the forge step does. Sizes as a person reads them ("6.5 GB", "6,5 Go"), the time limit as the shell says it ("15s", "15 s").
10. **The assistant's browser test** (`app/test/setup/setup-browser.test.ts`, lane `v2-j5-assistant`'s, not a file of this lane: an exception to section 3.1, forced, since with the step filled that test waited for a stub forever, or reached the machine's Docker) skipped `checks` as a stub; it now waits for the step's lines and skips it. Lane `v2-j5-connect` may change the same loop when it fills the workspace step. Both browser tests put a fake `docker` program on `PATH` (`test/doctor/fake-docker-cli.ts`: it answers the ready section's reads only and refuses any other command or a list without the label filter), so neither reaches Docker; the checks browser test has its own fake GitHub (`test/doctor/fake-github.ts`) for the two extra reads.

**Questions for the owner** (defaults applied):
1. A missing session or egress image: a failure (applied), since no session starts without them; or a notice, since a session builds what it needs at its start today.
2. The disk thresholds, 5 GB to fail and 20 GB for a notice (applied), until lane `v2-j5-images` and the proof measure what the images and a ticket take.
3. `node scripts/doctor.ts` with no section now also runs ready, after docker and pool (applied: ready says `byDefault`); or ready only when named, so the lanes' default run stays exactly as it was.

**Tests first.** `4924312` committed the tests alone: `test/doctor/ready.test.ts`, `test/doctor/sections.test.ts`, `test/doctor/checks-step.test.ts` and `test/cli/doctor.test.ts`, with the fakes of `test/doctor/support.ts`. Run again on `4924312` in a scratch worktree before the pull request: 9 of 9 failed, the three doctor files because they could not load what they test (no `src/doctor/`), and the command's six cases because `cleared doctor` was not a command (exit 64). Changes that came with the code: the files the settings name got a check id of their own, `credentials`, since one `settings` line per file broke the cases that ask for one line; with no workspace the repository line is "not run" and the checkout line alone says it, since the captures showed the same sentence twice; the "not run" lines say what they wait for, since "Not checked: ..." repeated the level's own word; the screen's summary has a class of its own and is in the strong weight, since it read as a footnote; the forge step's fake GitHub answers `/user/repos` only, so the assistant's browser test now counts that read alone; after the review, the images and the pool wait for a label filter that holds (the case adds an unlabelled image and network, and no line names them), and the screen gives the command that works on a Compose install (`docker compose -f v2/compose.yaml run --rm --no-deps service cleared doctor`, the form `v2/README.md` names), since `cleared` is on the image's `PATH`, not the host's.

**The real run** (2026-10-25 19:45:20 to 19:45:29 UTC, this server, Docker 29.8.1). A scratch state folder of mode 700 in the session's scratch folder; a placeholder file as the Claude Code login, never the owner's; the `gh` login's token written by `gh auth token` into a file of mode 600 there, never printed, and deleted after the run; a settings file naming it; a clone of the example repository `cleared-example-guestbook` of the organisation this repository lives in; the environment emptied but for those settings. In French and in English: ten checks passed (Docker, its label filter with three labelled containers, seventeen free subnets, the state folder, the settings file and the token's file, the login, GitHub accepting the token, the example repository with the right to push, its checkout with `origin/main`), the disk a notice (6.5 GB free), and one failure: neither `cleared-v2-session:2.1.306` nor `cleared-v2-egress:1` is built on this server, with the install command under it; exit 1. Without the settings file: the settings a notice, the token a failure ("No GitHub token"), the repository not run; exit 1. The token appears 0 times in the three outputs (`grep -c -F`). `ss -ltn` counted 27 listening sockets before and 26 after; the doctor listens on nothing. The pull request quotes the lines, the scratch folder replaced by `<scratch>` and the organisation by `<org>`.

**Checks** (before the merge of `origin/v2` at `4ec9ab5`, which brought pull request 413, a test file only). `npm run typecheck` passes. `npm test`: 2645 Node tests, 2532 pass, 113 skipped, 0 fail, and 369 Vitest tests pass. The two browser tests with `CLEARED_V2_PLAYWRIGHT` set (`app/test/setup/checks-browser.test.ts`, `app/test/setup/setup-browser.test.ts`): both languages pass, axe finding nothing. `npm run guard -- --base origin/v2`: nothing refused. The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object made or removed: the real run asked `docker version` and lists filtered on `cleared.dev=v2`; every test reached a fake docker. No Claude Code login read, no Slack, Cursor or Codex account. Network: `npm ci` of the lock file, `git fetch`, the clone of the example repository, and GitHub (two reads for the real run, the issue and the pull request). No port but the tests' own ephemeral loopback ones, no tunnel; the scratch file that held the `gh` login's token was deleted after the real run.

- Pull request: 417, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-doctor`.

## 2026-10-25: `cleared run`, a command and an API, with a person's API tokens that never approve (the author's choices, lane `v2-j5-run`, C18, P253, issue #416)

**The need.** Issue #416, section 8 of [milestone-5-plan.md](milestone-5-plan.md) (matrix C18): a ticket made and started from a terminal or a script, without the app. API tokens made, listed and revoked in the app, used as `authorization: Bearer`; `POST /api/run` and `GET /api/run/:id` through the chat's ticket path (P212); `cleared run "<task>" [--service <id>] [--wait]`. Decision 11 of the plan: a token is a person's, kept as a SHA-256 hash, revocable, and never approves a release, answers a permission or reaches the setup or the settings. French and English, fakes only. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-run`. Git refuses that name beside the local branch `v2`, so the lane runs on `v2-j5-run`, as the other milestone 5 lanes do.

**Decision.**
1. **The tokens** (`src/run/tokens.ts`). A value is `clr_` and 32 random bytes in base64url; the prefix tells a person or a scanner what it is. The ledger keeps its SHA-256 alone, in `api_tokens`, with the person, a name of 1 to 60 characters, the moment it was made, its last use and, once revoked, the moment it was. A value is looked up by its hash, so the value itself is never compared. A person holds 20 live tokens at most and revokes their own only; a revoked row stays, and never finds its person again.
2. **Two kinds of routes, two credentials, never mixed** (`src/run/routes.ts`). `POST /api/run` and `GET /api/run/:id` read `authorization: Bearer` and nothing else: no proof, so the app does not reach them. No other route of the service takes an API token (`POST /mcp` reads that header for its own local token, P216, and refuses any other), so a token reaches nothing else: no approval, no permission or question, no setup, no settings, no other token. `test/run/rights.test.ts` assembles the twelve modules as `src/main.ts` does and sends a valid token, as a Bearer and in the proof's header, to every route they declare: only the two run routes take it, every other answers 401, and the chat's command, off without its secret, 404. The token routes, `GET` and `POST /api/tokens` and `POST /api/tokens/:id/revoke`, are the app's: the proof, then a person the service knows. The app's proxy forwards no `authorization` header (`REQUEST_HEADERS` in `app/src/proxy.ts`; `app/test/proxy.test.ts` already checks that a Bearer sent by a browser does not reach the service), and no route of the app reads one, `/setup` included. The scheme `Bearer` is read in any case, as RFC 7235 says. A token that is not a live one is 401 with `www-authenticate: Bearer`; a live one whose person is gone is 403.
3. **The chat's path.** A run is a batch of one on the flow module's batches' runner, as the chat's command is, so it waits for the Consumption screen's lanes and the week stop and says which holds it. The runner is the flow module's own: a second one over the same tables could start a queued ticket twice, so `batchesOf` is exported from `src/modules/flow.ts` (one word and a comment), and the run module calls it. A batch's ticket named no service; the runner's `create` now takes the run's service as an option (`src/flow/batch.ts`), checked by the run module against the workspace first, and `POST /api/batches` is unchanged. These two files are outside the lane's list of section 8.4, and so is `app/web/styles/app.css`, which gets the panel's rules (decision 7); no lane of wave 2 lists them.
4. **The run's body.** A title (1 to 200 characters), a description (20 000 at most), a service of the workspace and a template of P214 (`bug`, `review`, `ci`, `question`, giving the ticket its `type:` label); anything else is refused before a ticket exists. The ticket is labelled `run`, as the chat's are `chat`, and made as the token's person.
5. **The run's state** (`src/run/runs.ts`). `run_launches` keeps, per ticket, its batch, its person, the token's id and what the flow said: the session at `ticket_started`, the pull request at `release_requested`, then approved, landed or put back; a later start leaves what the last one reached behind. The batch starts the ticket inside `create`, before the run's row exists, so the flow's events of a ticket with no row are held in memory (the last 20) and written when the row is made. `GET /api/run/:id` answers `queued` (with the batch's hold), `starting`, `working`, `approval`, `approved`, `live`, `put_back` or `failed` (with the note), the session, the pull request, the app's address of the ticket (its session's page, else the Tower, as the chat links it) and the moments it was made, started, put up for approval and went live. A ticket made otherwise is not a run: 404.
6. **The command** (`src/cli/run.ts`, `npm run run`). The task's first line is the title, cut at a word past 200 characters, and the whole task the description when it says more. The token comes from the file `CLEARED_V2_API_TOKEN_FILE` names, refused when it is a link, empty, or readable by another account (`chmod 600` is said), else from `CLEARED_V2_API_TOKEN`; never from an argument, which `ps` and the shell's history would show. It is in no output. The service is the one `CLEARED_V2_HOST` and `CLEARED_V2_PORT` name, as the service reads them. With `--wait`, the state is read every five seconds and each step is printed once: what holds it, the session's address, the pull request's, then the time taken (`app/web/lib/time.ts`, "0s", "4 min", "1 h 05"); it stops at the approval, which stays in the app. Exit 0 made, or waiting for its approval or past it; 1 refused or put back; 64 a usage or an unreadable token; 69 a service that does not answer; 77 a refused token.
7. **The panel** (`app/web/shell/Access.tsx`, `access.ts`). The person's menu has API access, which opens a dialog: what a token can and cannot do, the person's tokens with the day each was made and its last use ("Made on 25 October · Used 2 min ago") and Revoke, and a name field with Make a token. A token just made shows its value once in a field, with Copy, the warning that it is shown once, and the command that uses it. Esc closes it and gives the focus back to the menu's button. Its words are `access_*` keys of the shell's catalogs; no key says token, secret, key or pass (decision 12 of lane `v2-j5-assistant`).

**Questions for the owner** (defaults applied):
1. A token that expires: none (applied), as the plan says; a person revokes it. Or an end date picked at its making, which the table can take later.
2. Who revokes: its person only (applied). Or the owner too, for an account that left; an account removed already makes its tokens refused (403).
3. The matrix id. Pull requests 417 (`v2-j5-doctor`) and 418 (`v2-j5-connect`) of the same wave both name P251, so this lane took P253 to leave P251 and P252 to them. Whoever merges renumbers if the order differs; ids are never reused.

**Not done here.** The `cleared run` section of the README and `docs/run.md` are lane `v2-j5-docs`'s (section 15). A real session is the proof's: the runs here are on the fake harness.

**Tests first.** `050ce4b` committed the tests alone: run on it, the four new Node test files failed to load what they test (no `src/run/`, no `src/cli/run.ts`), and the panel's two test files import a panel that did not exist yet. Changes that came with the code: the sidebar test reads the menu's source, since its content is drawn only when it opens (the browser test opens it); the French case of the panel's body looks for its lead, the title being the dialog's; one list of headers got its type.

**Captures** (`docs/v2/run-access/`): the panel with a token just made at 1440, 1280, 768 and 390 px, light and dark, in English, and at 1440 in French, taken by `app/test/shell/access-browser.test.ts` with `CLEARED_V2_CAPTURES`. The value shown is one of the test's own ledger, in memory, gone with it.

**Checks** (at `origin/v2` `4ec9ab5`). `npm run typecheck` passes. `npm test`: 2642 Node tests, 2529 pass, 113 skipped, 0 fail, and 374 Vitest tests pass (on `origin/v2` before the lane: 2614 Node tests and 366 Vitest tests). `app/test/shell/access-browser.test.ts` with `CLEARED_V2_PLAYWRIGHT` set: both languages pass, axe finding nothing in light or dark. `npm run guard -- --base origin/v2`: nothing refused, after the tests' commit and at the end. The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object, no port but the tests' own ephemeral loopback ones, no Claude Code login read, no GitHub, Slack, Cursor or Codex account used. Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issue and the pull request. No tunnel, no secret.

- Pull request: 419, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-run`.

## 2026-10-25: connecting a workspace from the assistant: the repositories picked and cloned, the links proposed, only the ticked lines written (the author's choices, lane `v2-j5-connect`, M10, P252, issue #414)

**The need.** Issue #414, section 9 of [milestone-5-plan.md](milestone-5-plan.md) (matrix M10, decision 15). Today a workspace of several services is a file a person writes by hand (`CLEARED_V2_WORKSPACE`, `examples/workspace.conf`). The lane fills the assistant's workspace step, which the Services screen also opens:
- the repositories the forge credential reaches, one or several picked;
- for a monorepo, its folders proposed as folder services;
- each repository cloned, the service map (P245) run on the clones, and the links proposed with the file and line that suggested each;
- the workspace file written from what the person ticked, and nothing before.

French and English, accessible, fakes only. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository. The conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-connect`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-connect`, as the other milestone 5 lanes did.

**Decision.**
1. **The list** comes through the forge contract: `listRepositories()` of the GitHub adapter (P247), the first caller, as section 17 says. It runs `gh` with the `GH_TOKEN` the forge step set.
   - Archived repositories are left out and counted.
   - With no credential, the step says "connect GitHub first" and asks nothing of `gh`.
   - A list that fails is "unreachable". `gh`'s words go to the service's log, never to the browser.
   - No clone address reaches the browser.
2. **What the browser sends is names.** It sends names of repositories on that list, at most 10, and names and ids of the proposal's lines. The service lists again before each proposal and each write, and every address cloned is the forge's, so no address typed in a browser is ever cloned (a `file://` path included).
3. **The clones** go to `<state>/repositories/<owner>/<name>`, through `projectCheckout` (cloned when absent, fetched when present; a folder holding another repository is refused and left as it is).
   - Each clone's git environment names `gh auth git-credential` as GitHub's credential helper, the line `gh auth setup-git` writes. `gh` reads `GH_TOKEN` itself, so the value is in no URL and no git setting.
   - Nothing else in the Compose image gives git the credential: `lib/forge.ts` adds a helper in app mode only.
   - Checked on this server with a dummy value and an empty `gh` configuration, nothing sent over the network: `gh auth git-credential get` for `github.com` answers one password line with `GH_TOKEN` set and none without it. The output was counted, never printed. A clone of a real private repository through it is the rehearsal's.
4. **The guess** (`src/workspace/guess.ts`) reads the base branch from git's objects, as the map does, never the working tree. It reads the paths, plus the few files `wantedFiles` names.
   - **Folders.** A monorepo's folders come from its `package.json` workspaces (or `pnpm-workspace.yaml`): a folder, or a folder's children with `/*`, each with a manifest of its own. An entry that leaves the repository is not read. Without workspaces, two top folders or more with a manifest of their own count (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml` and the like), never `test`, `docs`, `examples`, `scripts` or the like.
   - **Layout.** A monorepo is proposed as its folders, with the whole repository as the other choice of a pair of radio buttons.
   - **Contracts.** A contract is a file under a known name (`openapi`, `swagger`, then `asyncapi` as events, `.yaml`, `.yml` or `.json`) at a known place of the service (its root, `contract/`, `contracts/`, `api/`, `openapi/`, `spec/`, `docs/`). It is read by the fakes' reader before it is proposed, and a file it cannot read is not proposed.
   - **Names.** A service is named after its folder or its repository. A name already taken becomes `<repository>-<folder>` or `<owner>-<repository>`, then gets a number.
5. **The links.** The map is built with the proposed contracts and no declared `consumes`. Each call it finds becomes a proposed `consumes` line with its operations and places. The map only reads a call against the other service's contract, so a contract file must be found for its callers' links to be.
   - Events and shared databases are not proposed: the train reads `consumes` alone (question 3).
   - The proposal records the clone and read as the machine's time.
6. **Nothing is ticked for the person.** The services are kept unless unticked. Each contract line and each link starts unticked: decision 15 says the person ticks what is right (question 1).
7. **The write** (`confirm`) works in this order:
   - It makes the proposal again from the clones, without fetching, so it reads what the person saw.
   - It refuses a tick the proposal does not hold, a link to a service left out, and a contract line of a service with none (`changed`).
   - It renders the file, and `parseWorkspace` reads it back as the service would. A cycle of ticked links is refused as `cycle`, before anything is written.
   - It makes the folder services' checkouts.
   - It writes `<state>/workspace.conf` (mode 600, beside its name and renamed into place).
   - It names that file as `CLEARED_V2_WORKSPACE` in the settings and sets it in the process.
   - **The workspace's id** is `CLEARED_V2_PROJECT` when set (a different id would stop the service at its start), else an earlier file's id, so the rows of a first connect stay in the workspace, else the first service's name.
   - **Hand-written keys** of an earlier file (`health_url`, `run`, `sensitivity`, `broker_*`, `forge`) are kept for a service of the same name.
   - **`dir`** is written for every service, since the flow's default folder (`CLEARED_V2_STATE_DIR`) and the settings' state folder (`CLEARED_STATE_DIR`) are not always the same.
8. **One checkout per folder service** (question 2). A repository service's checkout is its clone. Each folder service gets a clone of its own at `<state>/services/<name>/checkout`, made from the forge's address with the repository's clone as a reference (`--reference-if-able`, `--dissociate`). Two services never share a checkout, which the flow fetches on its own.
9. **The environment wins.** When the environment sets `CLEARED_V2_WORKSPACE`, the step says so and refuses a proposal or a write (409), as the forge step does for `GH_TOKEN`. One proposal or write runs at a time (409 `busy`), since two would fetch into the same folders.
10. **The screen** (`Workspace.tsx`, its own sheet `workspace.css`):
    - one box per repository, a field to narrow the list past eight, private ones tagged;
    - the proposal in groups: the layout of each monorepo, the services, the contracts found and the calls found, each call with "found at src/filter.ts, line 38";
    - Write the workspace, then the result and "Cleared uses it from its next start";
    - an earlier connect said with its day, and Connect again.

    Once there is a proposal, the clone button steps back to an outlined "Propose again", so the page has one ink button.
11. **The Services screen.** The lane adds a Connect link (`/setup/workspace`), drawn as the outlined button beside Refresh. It is also shown with the reason when no map can be read, which is what a server with no workspace shows (`ServicesFailed`). A person who is not the owner reaches the assistant's own "the setup is the owner's".
12. **Route shapes** are in `src/workspace/types.ts` (section 3.1), read by the step and the screen.

**Questions for the owner** (defaults applied):
1. The proposed links and contracts start unticked (applied), so each line written is one the person ticked. Or they start ticked, a click less for a newcomer, at the cost of lines written that no one looked at.
2. A folder service gets a checkout of its own (applied). Or the folder services of one repository share its clone, which saves disk but lets two fetches of the flow meet in one folder.
3. Only calls are proposed as `consumes` (applied). An events listener and a shared database stay what the map shows, since the train's landing order reads `consumes` alone.

**Open: the running service reads the workspace at its start (issue #420).** The flow's settings, the workspace included, are read once, when the service starts (`loadFlowConfig` in `flow/config.ts`), as the approval key is (P249's open point). A workspace the step writes is used from the service's next start, which the screen says. Proof step 9 needs it: lane `v2-j5-first-ticket` (or `v2-j5-compose`, with a restart the one command owns) closes it, with the approval key.

**Open: the flow's own fetches of a private repository (issue #421).** The step's clones give git the credential through `gh` (decision 3). The flow's later fetches (`projectCheckout` from `flow/effects.ts` and `modules/lead.ts`) take git's environment from `lib/forge.ts`. Without a GitHub App, that environment names no helper that reads `GH_TOKEN`, and the Compose image runs no `gh auth setup-git`, so a fetch of a private repository there would be refused. Not changed here: those files are not this lane's. The rehearsal (lane `v2-j5-proof`) shows it, and the lane that owns `lib/forge.ts` or the image closes it, for instance with the same helper line.

**Not done here.**
- **No real run.** The plan's real run (section 9.5: listing and cloning the two example repositories with the `gh` login's credential) was not done, because the brief says fakes only. The step is proven against a fake `gh` on PATH over temporary bare repositories made from `examples/`. The real list and clone is the rehearsal's or the real run's.
- **Out of scope.** The setup session per service (C4) stays section 13's.

**Tests first.** `4c9010a3` committed the tests alone, with `src/workspace/types.ts` (the shapes the tests name). On it:
- `test/workspace/guess.test.ts` and `test/workspace/connect.test.ts` could not load what they test;
- the six new component cases failed;
- the assistant's stub case was moved from the workspace step to the environment step's stub;
- the assistant's browser test gained a fake `gh` (its workspace page now lists through `gh` once the forge step is done) and waits for the filled step.

After the review, the screen had sent a repository kept whole after it was no longer picked, which the service refuses. The proposal and the write now send only the repositories they name, and the layout's radio buttons follow the choice at once. The browser test takes that path: a monorepo kept whole, then unpicked, then the two examples. Changes that came with the code: the i18n audit names `setup-workspace.workspace_services` ("Services") among the words French writes as English does, and French puts a no-break space before `:` and `?`, as the services catalog does.

**Captures** (`docs/v2/workspace-connect/`): the proposal of the two examples, at 1440, 1280, 768 and 390 px, light and dark, in English, and at 1440 in French. Taken by `app/test/setup/workspace-browser.test.ts` with `CLEARED_V2_CAPTURES`, on loopback ports the kernel picked.

**Checks.**
Run on the merge of `origin/v2` at `4ec9ab52`, with pull request 413 merged.
- `npm run typecheck` passes.
- `npm test` with `CLEARED_V2_PLAYWRIGHT` set: 2642 Node tests, 2639 pass, 2 skipped and 1 fails, `app/test/notify/browser.test.ts`. It fails the same way on a clean checkout of `origin/v2` at `4ec9ab52` without this lane, run here: the notification button is never offered in this server's headless Chrome, as P249's entry says.
- 372 Vitest tests pass.
- The assistant's two browser tests (`setup-browser`, `workspace-browser`) pass in both languages, axe finding nothing.
- An earlier run, before the merge and without browsers: 2642 Node tests, 2527 pass, 113 skipped and 2 failed: `test/wording.test.ts` (a placeholder `{items}` reads as a duration in milliseconds, so it became `{operations}`) and `app/test/polish/copy.test.ts` (the empty list of calls said two sentences, so the second became a note of its own).
- `npm run guard -- --base origin/v2`: nothing refused.
- The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.**
- No Docker object, no Claude Code login read.
- No GitHub, Slack, Cursor or Codex account used.
- Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issue and the pull request, nothing else.
- Ports: only the tests' own ephemeral loopback ones. No tunnel, no secret.

**The merge of 417** (lane `v2-j5-doctor`, issue #415, at `origin/v2` `c463e52`). 417 took the id P251 for the doctor's ready section, so this lane's line is P252: the matrix, section 9 of the plan and this entry say so. The assistant's browser test now waits for both filled steps: the workspace step's list and the checks step's lines.

**The merge of 419** (lane `v2-j5-run`, issue #416, at `origin/v2` `9e37404`). 419 keeps P253, so this lane's P252 stands; both log entries and matrix lines are kept.

**The review of 418** (at `2de3d6b`, blocking). The file's guard read each line once joined, for `\r` and NUL only. A `\n` inside one value went through, so a folder of a repository named with a line break, which git allows, could add a section to `workspace.conf`. Two fixes:
- `renderWorkspace` now checks every value on its own for `\r`, `\n` and NUL before it is written, and refuses as `invalid`. That covers the id, the workspace's name, each service's name, repository, address, base, path, dir, consumes, contract path and the keys kept by hand.
- The guess never proposes a folder whose name holds a control character, whether a top folder or a workspaces entry.

Tests first (`65ed443d`): a render case per value, a guess case, and a repository with such a folder whose file gets no extra section. The two open points above became issues #420 and #421.

- Pull request: 418, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-connect`.

## 2026-10-25: prepared images per service, chosen at a session's start, built after connect and after a merge that changes them (the author's choices, lane `v2-j5-images`, C15, P254, issue #422)

**The need.** Issue #422, section 10 of [milestone-5-plan.md](milestone-5-plan.md) (matrix C15, decision 13): an image ready in seconds. Per service, `cleared-v2-prep-<service>:<hash>`, built after the service is connected and after each merge that changes what the hash covers, with the project's dependencies installed. A session starts on the ready image, or tells its ticket it waits for one. The two newest per service are kept. The assistant's environment step shows the build and its time, and a doctor section `images` says each image and measures a session's start on one. French and English, fakes in the tests. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-images`. Git refuses that name beside the branch `v2`, locally and on the remote, so the lane runs on `v2-j5-images`, as the other milestone 5 lanes do.

**Where it started.** Section 2 of the plan says each session builds or pulls what its devcontainer names at its start. At `origin/v2` `3c27792` nothing did: no code called `readDevcontainer` or `sessionImage`, and the three adapters gave `startSession` the runtime's one image, so every session ran Cleared's session image whatever the project declared. This lane is what first reads a project's `.devcontainer` for a session.

**Decision.**
1. **The hash** (`src/container/prepared.ts`, `readInputs`). It is read from git's objects at `refs/remotes/origin/<base>` of the service's checkout, as the service map reads it, never the working tree. It covers:
   - the devcontainer file, the service's folder's, else the repository's;
   - the Dockerfile that file builds, when it builds one;
   - the lock files at the service's root (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`, `poetry.lock`, `Pipfile.lock`, `uv.lock`, `go.sum`, `Cargo.lock`, `Gemfile.lock`, `composer.lock`);
   - the install command;
   - the image it starts from, so a new Claude Code version in Cleared's session image builds again;
   - a recipe number, for a change of this file that changes what a build makes.

   A manifest (`package.json` and the like) is copied for the install but not hashed: a version or a script changes no dependency, and a dependency changes the lock file. The hash is 16 hexadecimal characters of a SHA-256. A folder service reads its own folder: the folders beside it change nothing.
2. **The install command** is `install_command` in the `[session]` section of the service's `.cleared/agents.conf` (its folder's, else the repository's), read at the base branch. No such key existed. It is one simple command, read as the policy reads a session's (`parseCommand`); a list, a pipe, a redirection or an expansion is refused with the reason. Without it nothing is installed ahead (question 1).
3. **What a build makes.** The image starts from Cleared's session image when the project has no `.devcontainer`, or from the image its `.devcontainer` names. `cleared-v2-session` under any tag means this install's session image: the guestbook's devcontainer names `cleared-v2-session:latest`, a tag nothing builds, which a `FROM` would look for on Docker Hub. A `.devcontainer` that builds a Dockerfile has it built first, as `<tag>-devcontainer`, from the base branch's files, labelled like the image. Then Cleared's own Dockerfile (`preparedDockerfile`), every word of it checked:
   - `FROM` that image;
   - the manifests and lock files copied to `/opt/cleared/prepared`;
   - the install command run there in exec form, with no shell;
   - `/node_modules` linked to `/opt/cleared/prepared/node_modules`;
   - `WORKDIR /workspace`.

   The session's checkout is mounted over `/workspace`, which hides anything an image puts there, so the dependencies live outside it. Node's resolution and npm's scripts look in `/node_modules` once `/workspace` has none. This was checked on this server, without Docker, on a folder laid out the same way: from a project with no `node_modules`, `npm run` found the linked package's command, and both `import` and `require` reached it. The build reaches the network (the registry), and runs only what the base branch holds, which a person approved and the lock merged, as a sibling's base layer does.
4. **One build per service at a time** (`ensure`). A second caller (the step, the merge hook, a session's start) waits for the running build, then finds the image ready. Each build is recorded in `<state>/prepared/<service>.json` (mode 600): the service's checkout, its base and folder, the last ready image's hash, tag, time and build time, and the last build's hash, start and first line of failure. A session's start reads the hash again from the checkout that record names. The build's folder is a temporary one, removed after.
5. **The two newest.** After a build, the images labelled with the service whose name is exactly `cleared-v2-prep-<service>:...` are grouped by hash, and the images of the two newest hashes are kept, with their `-devcontainer` layers; the others are removed by tag. An image of another service whose name starts the same (`api-v2` beside `api`), an image of that name without the label, and an image with the service's label under another name are left alone.
6. **The session's start** (`session-runtime.ts`).
   - An image the adapter's runtime names wins. Only the Claude Code adapter passes the service: the Codex and Cursor adapters are unchanged, so their sessions never start on a prepared image, which is built from Cleared's session image and holds neither program.
   - A service with no record runs Cleared's image, as before.
   - Otherwise the ready image for the hash read now is used, and nothing is built.
   - When there is none, the session waits for the build. The Claude Code adapter emits `cleared.prepared_image` with `state: waiting` on the session, so the ticket's events say it, and the session starts on the new image.
   - A build that fails, or already failed for that hash, leaves Cleared's image with the reason (`build_failed`), and the start does not build again until the person fixes it (question 2).

   The choice is made before any object of the session exists. `StartedSession.image` says which image ran, why, and how long it waited. The event comes before the session's `RUN_STARTED`, and on a resume between two runs; nothing reads the stored order as AG-UI does, since the app sends the session screen snapshots (`app/web/copilot/agent.ts`), and a stored session already holds several runs.
7. **After a merge** (`flow/runtime.ts`, `preparedAfterMerge`). The engine's `release_merged` event fetches each service that has a record (the one a train's merge names, else all), as the lead module fetches for the map, then calls `ensure`, which builds nothing when the hash did not move. A failure is one line of the service's log.
8. **The environment step** (`src/setup/steps/environment.ts`, `Environment.tsx`):
   - each service of the workspace with its `.devcontainer` (none, an image, a Dockerfile), its install command, and its image ready, stale, building, failed or not built, in words beside the coloured bar;
   - a ready image with its tag, its build time and its age ("built in 3 min, 2h ago"), and a failed one with its first line and what to do;
   - an image a `.devcontainer` names that is not Cleared's session image is named, with what a session needs in it: Node 24, Claude Code and Cleared's runner. Until now such a project ran Cleared's image, and its devcontainer was not read; from this lane on its sessions start on that image (question 4);
   - Build answers 202 at once and builds one service after the other; the page reads the view every 2 seconds while one runs, with Build disabled;
   - the builds count as the machine's time, and the step is done when every image is ready. No workspace yet is said, with no Build;
   - reading the view asks Docker nothing.
9. **The doctor's `images` section** (`src/doctor/sections/images.ts`, not run by default since it starts a container):
   - each service's image, ready with its age and its build time, or not built, stale, being built, missing from Docker or failed, each with what to do;
   - then one session started on the newest ready image through `startSession`, labelled as every session is (networks, egress proxy, container), running one line of Node that prints `ready` when the image holds Cleared's runner (`/opt/cleared/runner/main.ts`) and `no runner` otherwise, a failure with what to do, with an empty file mounted where the login goes, timed from the call to its first line;
   - its workdir, its empty login and its allow list are under the state folder (`<state>/doctor/images-<id>`, removed after): inside Compose the service's `/tmp` is not the host's, and Docker mounts a host path, so only the state folder, mounted at the same path, works there (plan, decision 1). The builds' folders stay in `/tmp`, since `docker build` sends its context from the client;
   - a pass under 10 seconds, a notice above, a failure with what to do, and everything it made removed by label.

   The measure covers the start of the networks, the proxy and the container, not the flow's checkout and briefing before it.
10. **Files outside the lane's list of section 10.4**, none of them a wave 3 lane's (`v2-j5-gitlab` lists the forge's files):
    - `src/container/docker.ts`: a build takes extra labels (checked, never `cleared.dev` or `cleared.session`), images are listed by one more label with their build time;
    - `src/container/types.ts`, new: the step's shapes (section 3.1);
    - `src/session/adapters/claude-code.ts`: the service passed, and the wait said;
    - `src/session/events.ts`: the name `cleared.prepared_image`;
    - `src/flow/runtime.ts`: the merge hook;
    - the step's catalogs, its sheet `environment.css`, and the doctor's catalogs `src/doctor/messages/images.{en,fr}.json`.

**Questions for the owner** (defaults applied):
1. A project that declares no install command: nothing is installed ahead (applied), as the plan says ("when it has one"). Or Cleared infers `npm ci` from a `package-lock.json` (and the like for pnpm and yarn), a project's sessions then faster without a line of settings. The guestbook declares none today, so its prepared image holds no dependency until it does.
2. A build that failed for a hash is not tried again at each session's start (applied): the session runs Cleared's image at once, and the step and the doctor say the failure. Or each start tries again, and waits minutes each time it fails.
3. The real run on this server (below): left to the rehearsal (applied). Or the orchestrator builds the session and egress images here, labelled, and runs `node scripts/doctor.ts images` on the guestbook with `install_command = npm ci`.
4. A `.devcontainer` that names another image than Cleared's: its sessions start on it, built ahead (applied), as the README has said since milestone 1 ("a project image must carry what the runner needs"); the step names the image and what it needs, and the doctor's measure fails when the runner is missing. Or such an image is used only once a check of the runner passes in it, and Cleared's image otherwise, which a later lane can add to the build.

**Not done here.**
- **The real run.** The plan proves C15 also by the `images` section's real run, quoted with its times. This server holds no session or egress image (a labelled list found the guestbook's and the filter API's only), and building them pulls `node:24`, an unlabelled object, where the brief prefers no Docker at all. So no Docker command ran here beyond that list. The measured time, and so the 10-second target, wait for the rehearsal (lane `v2-j5-proof`) or question 3. C15 and P254 stay `partial` until then.
- **The session screen** does not draw `cleared.prepared_image` yet. The cleaner lets it through and the session's event log keeps it; a line on the timeline is a later lane's.
- **Out of scope.** A shared cache or a registry; the devcontainer specification beyond `image` and `build`. A `build.context` larger than the Dockerfile's folder is copied whole, but only the Dockerfile is in the hash, as decision 13 says, so a file it copies that changes does not build again. The setup session for a service whose image cannot be built is lane `v2-j5-env-setup`'s (section 13), on this step.
- **Documentation.** `install_command` is a new key of `[session]`. Its line in `examples/guestbook/.cleared/agents.conf` and in the README is lane `v2-j5-docs`'s (section 15); neither file is this lane's.

**Tests first.** `af73a458` committed the tests alone, with `src/container/types.ts` (the step's shapes they name). On it:
- `test/container/prepared.test.ts`, `test/doctor/images.test.ts` and `test/setup/environment.test.ts` could not load what they test;
- the three new session-runtime cases failed;
- the three cases of the screen failed.

The assistant's stub cases moved from the environment step to the secrets step.

Changes that came with the code:
- the test of a base image's place in the hash compares a project with no Dockerfile, whose image is Cleared's;
- the full suite found three more. The list of custom names now holds the new one. A catalog key ending in `_none` read as an empty state, which must be one sentence, so it became `environment_no_devcontainer`. The doctor test split French lines on a plain space, where French writes a no-break space before `:`.

**Captures** (`docs/v2/prepared-images/`): the step with two services ready, at 1440, 1280, 768 and 390 px, light and dark, in English, and at 1440 in French, taken by `app/test/setup/environment-browser.test.ts` with `CLEARED_V2_CAPTURES`, against a fake `docker` program that builds after a pause.

**Checks.** At `28a2e61f`, on `origin/v2` `3c27792`.
- `npm run typecheck` passes.
- `npm test`: 2730 Node tests, 2611 pass, 119 skipped (the browser tests, without `CLEARED_V2_PLAYWRIGHT`), 0 fail; 386 Vitest tests pass.
- Every browser test of `app/test/` with `CLEARED_V2_PLAYWRIGHT` set: 115, 114 pass. The one that fails is `app/test/notify/browser.test.ts`, which fails the same way without this lane: the notification button is never offered in this server's headless Chrome, as P249's entry says.
- The setup's three browser tests (`environment-browser`, `setup-browser`, `checks-browser`) pass with `CLEARED_V2_PLAYWRIGHT` set, in both languages, axe finding nothing.
- `npm run guard -- --base origin/v2`: nothing refused.
- The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.**
- Docker: one list of images filtered on `cleared.dev=v2`, nothing else. No image built, no container started.
- No Claude Code login read. No GitHub, Slack, Cursor or Codex account used.
- Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issue and the pull request.
- Ports: only the tests' own ephemeral loopback ones (`ss -ltn` read first). No tunnel, no secret.

- Pull request: 427, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-images`.
## 2026-10-25: GitLab, the second forge: the adapter over its REST API, the lock's merge for a GitLab service, the forge step's choice and a doctor section (the author's choices, lane `v2-j5-gitlab`, M10, P255, issue #423)

**The need.** Issue #423, section 11 of [milestone-5-plan.md](milestone-5-plan.md) (matrix M10, decision 10). Section 6 made the forge a contract with GitHub as its first adapter. This lane adds GitLab:
- the adapter, over GitLab's REST API, a token from a file, the address configurable for a self-managed GitLab;
- the lock's merge for a GitLab service, with the checks the GitHub path makes;
- the assistant's forge step offering GitLab;
- a doctor section `gitlab`, run only when named.

French and English, accessible, against a fake GitLab only. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-gitlab`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-gitlab`, as the other milestone 5 lanes did.

**Decision.**
1. **One client, in `lib/gitlab.ts`.** The v2 adapter and the v1 lock both use it. It sits in the root `lib/` because the lock's tests copy `lib/` into their sandbox, and the root type check leaves `v2/` out; v2 already imports from `lib/`.
   - The token goes in the `PRIVATE-TOKEN` header only: never in an address, an error or a log. Errors carry GitLab's status and at most 200 characters of its `message`.
   - Every request is sent with `redirect: 'error'`, so the header never follows an answer to another host.
   - The address is https on any host, or http on loopback only (the tests). A trailing slash is dropped and a path kept, for a GitLab served under one. A user, a query or a fragment is refused. gitlab.com by default.
   - The token's file must be absolute, a plain file of this account, mode 600, one word. A link is refused (`O_NOFOLLOW`).
   - A project path is `group/name` or `group/subgroup/name`, checked before any call and sent as one encoded segment.
2. **The adapter** (`v2/src/forge/gitlab.ts`), `forge = gitlab` in the workspace file:
   - It reads `CLEARED_V2_GITLAB_URL` and `CLEARED_V2_GITLAB_TOKEN_FILE`. The settings write both under `[env]`, not `[env_files]`, so the token stays in its file and no variable holds it.
   - **The listing** is the token's own projects (`membership=true`), never every public project of gitlab.com. It goes page by page, at most 1000, sorted by path. A project with no branch yet is left out. An internal project counts as private.
   - **The numbers.** A pull request of the contract is a merge request's `iid`. A merge request is opened with `remove_source_branch: false`.
   - **The checks** are the commit statuses of the merge request's head (GitLab's jobs and external statuses alike), summed up as GitHub's: one failed or cancelled fails them; one running, or none, keeps them pending. A failure GitLab allows (`allow_failure`) does not fail them. A manual job not run counts as skipped.
   - **The repair's logs.** The failed statuses' job logs are read by id (`/jobs/:id/trace`), for the first five. The last 256 KB is kept, then `logTail` cuts it. An external status has no job, so no log, and its name stays.
   - **The close** posts the comment as a note, then closes. The branch is kept.
   - **No repository given.** The head is read on the project that the checkout's `origin` names on this GitLab. Another host is refused.
3. **The contract's cases, one fixture change.** In `contract-cases.ts`, the five pull requests of the checks case now each have a head of their own. Checks belong to a commit: the fake GitLab keeps statuses by commit, as GitLab does, and refuses two pull requests on one head with different checks. The fake forge and the GitHub adapter pass unchanged.
4. **The lock.** A service whose `agents.conf` says `[forge] adapter = gitlab`, with `gitlab_url`, `gitlab_project` and `gitlab_token_file`, is put live by `merge-pr.ts` through GitLab. The choice comes from the lock's own settings, never from the broker's client.
   - The settings are checked before anything is read, and refused (exit 6) with the key named: an address in clear, a token file that is not absolute, inside the checkout or readable by others, no project, or a GitHub App key beside `adapter = gitlab`. `lib/forge.ts` accepts `adapter = gitlab` (no GitHub App, git's ambient credential) and refuses the App's keys with it.
   - **The checks.** The merge request and its head's statuses are read in gh's words (`OPEN`, `isDraft`, `SUCCESS`, `PENDING`, `NEUTRAL` for an allowed failure). The checks that follow are the GitHub path's, unchanged and in the same order:
     - open and not a draft, to the base;
     - nothing running, nothing failed, one at least that passed;
     - the branch holds the base, and its head is the one GitLab names;
     - reviewed at this version;
     - the agreement.
   - **The host** is free when no pipeline of the project runs or waits, and the base's last commit is ten minutes old with no container settling, as for GitHub.
   - **The merge** is `PUT …/merge` with `sha`, the commit that was checked (GitLab refuses it if the branch moved), and `should_remove_source_branch: false`.
   - **GitLab silent** (no answer, or a 5xx) is "not now" (exit 3, or 5 from the queue), as GitHub down is. Its 4xx is "could not be read" (exit 1).
   - **The agreement.** `ask-validation.ts` reads the merge request's state and head from GitLab, so the version the user is shown, and the one `merge-pr.ts` then holds the merge to, is the head GitLab names. Without it, a GitLab service could never pass the agreement: the ask read the head through gh.
   - **gh is never called.** Other merge requests shown on the ticket are asked of GitLab through a reader `shownLeft` now takes. `lib/release.ts start` reads the merged merge request from GitLab (its merge commit and when) before the watch starts.
   - **`release-request.ts` is unchanged**, though the plan lists it as this lane's file. It is only the broker's socket client, and which forge a merge goes through comes from the lock's own settings, never from the client.
5. **The forge step.**
   - **The screen.** It offers GitHub and GitLab as two radio buttons of one labelled group. GitHub comes first, and stays chosen until a GitLab token is saved alone.
   - **The GitLab fields.** The address, gitlab.com by default. The api scope and the Developer role (Maintainer to merge into a protected branch), with what each is for. A link to the page that makes the token on that GitLab, its name and scope filled in.
   - **The check goes through the contract:** the adapter's listing. Then the token's own page (`/personal_access_tokens/self`) must hold the scope `api`. An older GitLab without that page is checked by the listing alone.
   - **Refusals:** `address`, `refused` (401), `forbidden` (403), `scope`, `empty`, `unreachable`, and `environment` when the environment names the token file.
   - **What is written.** The token goes to `<state>/forge-gitlab.token` (mode 600). The settings name it with the address. Both are set in the process at once, with no restart.
6. **GitHub's check stays its direct read.** The plan says the step goes through the contract for both forges; for GitHub, it does not. The GitHub adapter is `gh`, and the step's direct read of one page (`GET /user/repos`) is what tells 401 from 403 and needs no `gh` before the forge is connected. Moving it would change GitHub's behaviour for no gain the plan names, which section 6 asked not to do. The step's service tests and the assistant's browser tests pass unchanged. What changed on GitHub's side is words: the step's title ("Connect GitHub or GitLab"), its intro, now shared by both forges, with GitHub's own sentence under its choice, and the progress line's label, "Forge" where it said "GitHub".
7. **The doctor section `gitlab`** is run only when named (`node scripts/doctor.ts gitlab`, `cleared doctor gitlab`), as `mirror`, and is read only. It says, in order:
   - the address;
   - the token's file, looked at as the adapter reads it and never printed;
   - the account GitLab accepts, with 401, 403 and no answer in 15 s said apart;
   - the api scope, a notice when GitLab cannot say;
   - each GitLab service's project, with the role the token holds there (Developer at least, the role named in GitLab's words in both languages).

   Not set up, it is one notice.

**Questions for the owner** (defaults applied):
1. The listing leaves out a project with no commit yet (applied), since there is no branch to work on. Or list it, and let the workspace step refuse it.
2. A manual job not run counts as skipped (applied), so a manual deploy job does not hold the merge. Or wait for it, which holds every merge of a project with such a job until someone runs it.

**Open.**
- **#424.** The assistant's later steps on GitLab: the workspace step lists and clones through GitHub, the ready section checks GitHub's token, and `headOnForge` reads GitHub. Those files are other lanes'.
- **#425.** git's credential for a GitLab service's fetches and pushes, the sibling of #421.
- **#426.** Three project shapes are not taken yet:
  - a nested group in the workspace file, whose `repository` is `owner/name`;
  - a fast-forward merge method, which gives the watch no merge commit;
  - merged results pipelines, whose statuses are not on the head.

**Not done here.**
- **No real GitLab.** The plan's section 11.5 makes GitLab for real the owner's trial (question 6). Every call here goes to a fake GitLab on loopback (`test/forge/fakes/gitlab.ts`, `node:http` only, so the root lock tests use it too). The lock's tests merge for real on the sandbox's git remote, so the watch starts on a real merge commit.
- **Out of scope.** GitLab issues as a mirror. Forges other than GitHub and GitLab.

**Tests first.** `ef0dcb64` committed the tests alone. On it:
- the adapter's file, the contract's GitLab cases, the step's, the doctor's and the screen's could not load what they test;
- the workspace file still refused `forge = gitlab`, and `lib/forge.ts` still refused `adapter = gitlab`;
- the lock's six GitLab cases failed, run on that commit in a scratch worktree: `merge-pr.ts` stopped on `unknown [forge] adapter "gitlab"`, then could not read pull request #7.

The two agreement cases came later, from a second read of the lock's path: with `ask-validation.ts` as it was, the ask stopped on "pull request #7 could not be read", seen by running the new case on the old file.

**Files outside the lane's list**, each for GitLab's path, GitHub's left as it was:
- `lib/forge.ts`: `adapter = gitlab` accepted, with no GitHub App key.
- `lib/release.ts`: the watch reads the merged merge request from GitLab.
- `lib/script.ts`: `shownLeft` takes a reader of a pull request's state.
- `ask-validation.ts`: the shown head read from GitLab.
- `lib/gitlab.ts`: new, the client (decision 1).
- `agents.example.conf`: the lock's GitLab keys, as comments.
- `v2/app/messages/setup.{en,fr}.json`: the step's label.
- `v2/app/web/test/i18n-audit.test.tsx`: GitHub, GitLab and `api` written alike in both languages.
- `v2/test/forge/contract-cases.ts` (decision 3), `v2/test/forge/workspace-config.test.ts` and `test/forge.test.ts`: GitLab accepted where it was refused.

**Captures.**
- `docs/v2/gitlab/`: the GitLab choice at 1440, 1280, 768 and 390 px, light and dark, in English, and the saved step at 1440 in French. Taken by `app/test/setup/forge-gitlab-browser.test.ts` with `CLEARED_V2_CAPTURES`.
- `docs/v2/setup-assistant/forge-*.png`: taken again by `setup-browser.test.ts`, since the forge step now opens on the choice.

**Checks.** Run on this branch at `origin/v2` `3c27792d`.
- `npm run typecheck` passes, and so does the root type check (`v2/node_modules/.bin/tsc -p .`).
- `npm test` with `CLEARED_V2_PLAYWRIGHT` set: 2738 Node tests, 2735 pass, 2 skipped, 1 fails, `app/test/notify/browser.test.ts`. It fails the same way on a clean checkout of `origin/v2` at `3c27792d` without this lane, run here, as P252's entry says.
- 388 Vitest tests pass.
- After the agreement's fix: the forge, setup and doctor tests (69) and the lock's eight GitLab cases pass.
- The root suite (`node --test test/*.test.ts`, as the `checks` workflow runs it): 413 tests, 411 pass, 2 skipped.
- The browser tests of the assistant (`setup-browser`, `workspace-browser`, `checks-browser`) and the new `forge-gitlab-browser` pass in both languages, axe finding nothing.
- An earlier run found three i18n audit failures: a literal `api` in the screen, a type the audit read as text, and the two forge names written alike. They are fixed as listed above.
- `npm run guard -- --base origin/v2`: nothing refused. A first run refused four lines: a constant named after a token that holds a setting's name, a test address with a user and a password, and two test values. The constant was renamed and the test values are built at run time.
- The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.**
- No Docker object, no real GitLab or GitHub account, no Claude Code login read.
- No Slack, Cursor or Codex account used.
- Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issues and the pull request, nothing else.
- Ports: only the tests' own ephemeral loopback ones. No tunnel, no secret.

**The merge of 427** (lane `v2-j5-images`, issue #422, at `origin/v2` `996bde5`). 427 took the id P254 for the prepared images, so this lane's line is P255: the matrix, section 11 of the plan and this entry say so. Both log entries and matrix lines are kept.

**CI of 428** (run 40242142761, the `checks` workflow). Two of the lock's GitLab cases failed: the tooling merge and the agreement merge. The cause was in the test, not the lock. The fake GitLab's merge clones the sandbox's bare remote, and on the runner `git init --bare` names its HEAD after `init.defaultBranch` (`master`). The clone was then empty, and `git merge` refused ("Non-fast-forward commit does not make sense into an empty head"). This server's git defaults to `main`, which hid it. The clone now names `--branch main`. Checked with `init.defaultBranch=master` set through `GIT_CONFIG_*`: without the fix, the same two cases fail with the same error; with it, the eight cases pass. The root suite then passed: 413 tests, 411 pass, 2 skipped.

- Pull request: 428, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-gitlab`.

## 2026-10-27: the assistant's first ticket, followed to live, the setup's summary, and four fixes from the end-to-end test of 26 October (the author's choices, lane `v2-j5-first-ticket`, B6.5, B6.5p, P256, issue #433; issues #429 to #432)

**The need.** Section 14 of [milestone-5-plan.md](milestone-5-plan.md) (matrix B6.5, B6.5p steps 9 and 10): the assistant's last step, a first ticket that changes one visible line of the project, proposed with its service, moved to Todo in one click and followed to live; and the summary of each step's time, the person's and the machine's, with the total. Two open points were left to this lane: the workspace the assistant writes (#420) and the approval key it makes (P249) were used only from the service's next start. With it, four bugs found by the end-to-end test of 26 October, one commit each: #429, #430, #431 and #432. French and English, accessible, fakes only, nothing on a real server. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-first-ticket`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-first-ticket`, as the other milestone 5 lanes did.

**Decision: the four fixes.**
1. **#429, the app's proof.** The service made it with an exclusive create, then wrote it: an app starting a second later read an empty file, logged "not 64 hex characters" and kept no proof until a restart. The proof is now written in a file of its own, then linked to its name (a link fails if the name exists, so two processes starting at once agree, as `setup/approval-key.ts` already does for the key). The issue asked for a rename; a rename replaces a proof another process already read, which would give a 401 for good. The app reads the proof when a request needs it (`proofReader`): until it is whole, the browser gets 503 `service_starting` and the service is not asked; a 401 from the service makes the next request read it again. `app/main.ts` no longer stops on a proof that is not ready. The lanes' MCP token, made by the same function, gains the same.
2. **#430, `cleared doctor` and Docker.** The entrypoint's `cleared` role dropped root with the owner's group only. It now keeps the socket's group, as the service does. Only the service's container mounts the socket, so the app's and the broker's never find one (D10 holds).
3. **#431, before the forge.** The service answers 503 until a workspace exists. The Tower and the Inbox now say "Cleared runs no ticket yet: the setup is not finished" and link to `/setup`, not an error; a refusal keeps the service's `{ error }`, so the app's own `service_starting` still reads as a service that is starting; the Inbox clears its failure once a later read succeeds. **The language:** the app follows the person's choice, then the browser's languages, then `CLEARED_V2_APP_LANGUAGE` (the owner's request of 2026-10-23, 08:40), which is why a headless browser in en-US got English on an install in French while the commands spoke French. That order stays. What was missing is a way to choose before the owner's account and its menu exist: the setup page now has the menu's language choice, which writes the same cookie.
4. **#432, the public key.** Step 1 said to add `human_public_key` to the project's `.cleared/agents.conf` and commit it, before any repository was linked (step 4), against section 1's rule that no step needs a hand-edited file. The service now checks the owner's signed rows with the public half of the key it holds when the project's file names none; a key the file names still wins. The step says there is nothing to add to the repository, and keeps the line in a closed fold "for a release lock set up by hand". Putting the line in the first ticket's own pull request was not taken: a key arriving in the pull request being approved must never check that approval.

**Decision: the lane.**
5. **The ticket's text** is in the step's file (`src/setup/steps/first-ticket.ts`), in English and in French, in the person's language as a team's content is: one line at the end of `README.md` at the root of the service's repository ("This project takes its changes through Cleared: an author, a reviewer, and the owner's approval."), a README made if there is none, nothing else changed. No `type:` label: the tracker's types are bug, review, ci and question.
6. **Proposed, then one click.** A ticket is created in Todo and the flow starts it, so "proposed" is the step's page: the ticket as it will be written and the repository it targets (a list when the workspace has several). The click makes the ticket as the owner and starts it, as the Tower's form does. One first ticket: its row is taken before the ticket is made, so two clicks make one (`exists`); before a workspace exists the step says so and links to the workspace step (`no_workspace`); a store that cannot sign yet answers `unsigned`.
7. **Followed to live.** The page reads the step every 5 seconds until the ticket is live or left the flow. Its stages come from the ticket store's state: Todo, the author, the review, the owner's approval (with the inbox's link: the approval is the inbox's, as for any ticket), the merge and the release watch, live. Live is Done, which the engine sets once the watch ends healthy or unwatched (question 2 of the plan, default (a)); a roll-back that put it back in Todo is said.
8. **The step's times.** The step is done at the moment the ticket went Done, read from its history, not when a page looked (`SetupRecords.done` takes that moment, never before the step was shown). The machine's time is Todo to the first approval asked (the sessions) plus the approval to Done (the lock and the watch); the rest, reading the proposal and approving, is the person's.
9. **The summary** (`src/setup/summary.ts`): each step's time, the person's and the machine's, the totals, the steps skipped, whether all are done and whether the whole held in the hour. `setupView` takes its totals from it. It is drawn as a table with a caption, by the step once live and by the assistant's last page; durations as `lasted` says them ("12 min", "40 s"), no milliseconds.
10. **No restart for the workspace (#420).** The runtime reads the flow's settings again at each request while it has none, and builds the engine at the first request that finds them; a workspace that is named but wrong is said once. It tells whoever waits (`whenEngine`): the flow module then starts the idle watchdog (B3.11), the batches and the chat's replies, which it started only with an engine present at start. A listener from a start that a stop ended does nothing.
11. **No restart for the approval key (P249's open point).** The approval's key and owner are read at each need until both exist, then kept: the ticket store and the writer take them from a function, and the multi-service paths read the environment's `conf` and `signer` through getters.
12. **For the tests**, the setup module takes its steps as an option (the registry's by default), so the browser test gives the first-ticket step an engine on the flow's fake harness.

**Questions for the owner** (defaults applied):
1. **The release lock's key (#432).** The v1 lock (`merge-pr.ts`, run by the broker) still reads `human_public_key` from the project's `.cleared/agents.conf` only. (a) The lock reads the key the service holds when the file names none, as the service now does: the trust moves from a reviewed line of the repository to the state folder, which the service's account alone can write and which already holds the private half. (b) The workspace step opens a configuration pull request adding the line, which the owner merges on the forge. (c) Unchanged: a lock set up by hand reads the line the step keeps folded. Default applied: (c), since (a) changes what the lock trusts. Recommended: (a), as the private half beside it already lets that account sign.
2. **The app's language (#431).** (a) The person's choice, then the browser, then the install's setting, as the owner asked on 2026-10-23 (applied), with the choice now on the setup page. (b) The install's setting before the browser when the install named one. Default: (a).

**Open.**
- **#420** stays open for what still reads the workspace at start only: the lead's knowledge, the GitHub and Linear mirrors, and the workspace record of the tickets module.
- **#437** (opened here, read in the code, not run): the Tower creates a ticket with the app's project name, which a Compose install leaves empty, so the service refuses it after the assistant. The first ticket goes through the step, not that route.
- **#438** (opened here, read in the code, not run): the Compose broker idles until `CLEARED_V2_PROJECT_DIR` names a checkout, and the assistant gives it none, so the real step 10 waits for a lock that does not run.
- The watchdog's start with an engine built later is proven through `whenEngine` (`test/flow/runtime-later.test.ts`), not through the flow module itself, which uses the process's runtime.

**Not done here.** No real first ticket: the plan keeps it for the proof (B6.5p); the step is proven on the flow's fake harness, to the approval, and its live through the ticket store's move to Done. No Compose run: #429 and #430 are proven by their tests, not on a Docker install.

**Tests first.** Each fix's commit holds its test and its code; each test was run on the code before it:
- #429: `test/modules/users.test.ts`, with the old `readOrCreateProof`, "nothing at the path while the proof is written" failed (a reader at the moment of the write found an empty file), deterministically: the test reads the path from inside `writeSync`, no race. The reader's case failed on a stand-in that read the file each time.
- #430: `test/install/entrypoint.test.ts` failed: the cleared role got `[1000]`. The case that said "the socket's group for the service only" changed with the code.
- #431: `app/web/test/setup-pending.test.tsx` could not load what it tests (no `setup-pending.tsx`, no `LanguageChoice`).
- #432: `test/approval/environment.test.ts`, the owner's row read as `other`; `app/web/test/setup/setup.test.tsx`, the owner step's case, which said "to commit to the project", changed with the code.

The lane's tests were committed alone (`7db961f3`). On it: `test/setup/first-ticket.test.ts` could not load (no `summary.ts`, no step), `test/flow/runtime-later.test.ts` failed both cases (no `whenEngine`), the key case of `test/approval/environment.test.ts` failed (`canSign` stayed false), and the 5 cases of `app/web/test/setup/first-ticket.test.tsx` failed (the stub drew none of it). Changed with the code: `test/flow/runtime-later.test.ts` gave its store the inbox's table and its fake release a result; `app/test/shell/tokens.test.ts` found a `font-weight: normal` in the new sheet; the i18n audit names "Todo" (the board's state) and "Total" as written alike in French; the three setup browser tests wait for the key's line in its fold, and the assistant's walk meets the filled first-ticket step.

**Files outside the lane's list**, each for the four fixes or the two open points: `src/modules/users.ts`, `app/main.ts`, `app/src/proxy.ts`, `app/src/preview.ts` (#429); `images/cleared/entrypoint.ts` (#430); `app/web/lib/api.ts`, `app/web/lib/screen.ts`, `app/web/lib/setup-pending.tsx`, `app/web/screens/tower/Tower.tsx`, `app/web/screens/inbox/Inbox.tsx`, `app/messages/shell.{en,fr}.json`, `app/web/screens/setup/Setup.tsx` and `setup.css` (#431, and the summary on the last page); `src/approval/service.ts`, `src/setup/approval-key.ts`, `app/web/screens/setup/steps/Owner.tsx`, `app/messages/setup-owner.{en,fr}.json` (#432); `src/flow/runtime.ts`, `src/modules/flow.ts` (#420); `src/tickets/local-store.ts`, `src/approval/writer.ts` (the key read at each need); `src/setup/records.ts`, `src/setup/types.ts`, `src/modules/setup.ts` (the step's moment, its shapes, the totals, the steps option).

**Captures** (`docs/v2/first-ticket/`): the proposal and live, at 1440, 1280, 768 and 390 px, light and dark, in English, and at 1440 in French. Taken by `app/test/setup/first-ticket-browser.test.ts` with `CLEARED_V2_CAPTURES`; the times read 0 s there, the flow's clock being the test's.

**Checks**, on this branch at `origin/v2` `eb81a2ed`:
- `npm run typecheck` passes.
- `npm test`: 2781 Node tests, 2658 pass, 123 skipped, 0 fail; 400 Vitest tests pass.
- The six setup browser tests (`setup`, `checks`, `forge-gitlab`, `workspace`, `environment`, `first-ticket`) pass in both languages, axe finding nothing, with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME` naming this server's headless Chrome (the installed playwright-core asks a build this server does not hold).
- `npm test` with `CLEARED_V2_PLAYWRIGHT` set (every browser test): 2781 Node tests, 2776 pass, 2 skipped, 3 fail, none of them this lane's. Run alone, each the same on this branch and on a clean checkout of `origin/v2` at `eb81a2ed`: `app/test/notify/browser.test.ts` fails on both (the button is never offered in this server's headless Chrome, as P249's and P255's entries say); the real-Chromium case of `test/flow/proof-capture.test.ts` fails on both (its after page and video say `failed`); `app/test/foundation/budget-browser.test.ts` passes on both, its p95 over 100 ms (134.7 ms) only under the whole run's load.
- `npm run guard -- --base origin/v2`: nothing refused. The guard does not read `docs/v2/`, and ran without the private-term list, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object, no real GitHub, GitLab, Slack, Cursor or Codex account, no Claude Code login read. Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issues and the pull request. Ports: only the tests' own ephemeral loopback ones. No tunnel, no secret.

- Pull request: 440, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-first-ticket`.

## 2026-10-27: test secrets in the app, sealed at rest, given to an author's and a reviewer's session only, and cleaned from what Cleared writes (the author's choices, lane `v2-j5-secrets`, C16, P257, issue #434)

**The need.** Issue #434, section 12 of [milestone-5-plan.md](milestone-5-plan.md) (matrix C16, decision 12). A project whose tests need a key, a sandbox account or a mail test server, has no place for it but its own files. This lane adds:
- a service's test secrets, set, replaced and removed in the app by a signed-in person, each change in the ledger with its name, who and when, never its value;
- the values encrypted at rest under `<state>/secrets.key`, so a ledger copied without the key reads nothing;
- the values given to the sessions' tests, and removed from everything Cleared writes;
- a Test secrets panel on the Services screen and the assistant's secrets step, which show names and dates, never a value.

French and English, accessible, fake values only, made at run time. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-secrets`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-secrets`, as the other milestone 5 lanes did.

**Decision.**
1. **The store** (`src/secrets/store.ts`), two tables of the secrets module:
   - `test_secrets`: one row a service and a name, the value sealed, who set it and when;
   - `test_secret_changes`: each set, replace and remove, with the name, who and when.

   The values the key opens are read once at start and kept in memory. The cleaner reads that list at each text it cleans, so it never reads the ledger or decrypts on that path. One store a ledger (`src/secrets/live.ts`): the Services screen, the assistant's step, the cleaner and the session runtime all see a value the moment it is set.
2. **The key** (`src/secrets/key.ts`). `<state>/secrets.key`, 32 random bytes, mode 600, made at the first value (`O_EXCL`, never through a link), never before: reading needs none.
   - A link, a file of another account, one the group or others can read, or one of another size is refused. Nothing is sealed or opened with it, the service's log says why, and the screens say the key file is refused.
   - AES-256-GCM, a fresh 12-byte nonce at each write, the service and the name as associated data: a sealed value moved to another row does not open.
   - A ledger copied without its key lists its names as unreadable, gives no session a value, and a value set again there is sealed under the new key.
3. **What a name and a value may be.**
   - A name is an environment variable's: a capital, then capitals, digits and `_`, 64 characters at most.
   - A name is never one the container needs as it is: the proxies, `HOME`, `PATH`, the certificates, `DATABASE_URL` (what postgres gives), and every name under `CLEARED_`, `CLAUDE_`, `ANTHROPIC_`, `CODEX_`, `OPENAI_`, `CURSOR_`, `NODE_`, `NPM_CONFIG_`, `LD_`, `GIT_`, `SSH_`, `DOCKER_`, `EGRESS_` and `FAKE_`. The rule is in `src/container/services.ts`, beside the test services' own variables, and the runtime applies it again.
   - A value is one line, 8 to 4096 characters, with no control character and no space at either end (a paste mistake). The cleaner does not look for a value under 8 characters, which would remove ordinary words, so such a value is refused rather than kept and missed.
   - 50 values a service at most.
4. **Who gets the values.**
   - An author's and a reviewer's session container gets its own service's values.
   - Each real sibling gets its own service's: it runs the project's code for the tests.
   - Nothing else does: a fake (it answers from a contract), the egress, postgres (its environment is fixed, as milestone 1 decided), a reader, the lead, and a session that names no service.
   - Each of the three adapters (Claude Code, Codex, Cursor) now names its session's service and role to the runtime.
   - A name the container already sets stays the container's: the values are added under the runtime's own variables, never over them.
5. **Never on a command line.** `docker create --env NAME=value` puts the value in the process list, where any account of the machine reads it. The runtime gives the values as `privateEnv`: `--env NAME` on the command line, the value in the docker client's own environment, where the CLI reads it. `src/container/docker.ts` carries it, and its runner hands the client that environment over its own.
6. **The cleaner's list.**
   - `secretValues(env)` (`src/session/clean.ts`) now adds every value the service held since it started, a replaced or removed one too. A session started before the change still holds the old value.
   - Every call site that reads `secretValues` at each text is reached without being edited: the session's events, the flow's comments and notes, the lead, the reader, the knowledge module, the human terminal.
   - One did not: the lanes' MCP server's redactor (`src/mcp/redact.ts`) read the list once, when the flow module was made, before the secrets module had its store. It reads it at each text now, and `test/mcp/redact.test.ts` fails without that change.
7. **Pull requests.** The body was never cleaned by `cleanText`, and the guard does not know the values. `src/workspace/publish.ts`:
   - refuses a branch whose commits or commit messages hold a value, as the guard refuses one: nothing is pushed, and the refusal names no value;
   - sends the body without any value the session's report names.

   The title comes from the commit messages, already checked, so it needs nothing of its own.
8. **The routes.**
   - `GET`, `POST` and `POST …/remove` under `/api/test-values`, for the Services screen: the app's proof, then a person the service knows, never the flow's own identities.
   - The same under `/api/setup/secrets` for the owner, through the setup module's guard, with `POST /api/setup/secrets/done`, which needs one value saved.
   - A refusal is a code the screens say in words. No answer, error or log line carries a value, and the tests read every answer for one.
9. **The screens.**
   - One panel (`app/web/screens/services/TestValues.tsx`), on the Services screen under the map (shown also when the map cannot be read) and in the assistant's step, so both say the same.
   - Each service with its values by name, "Set on 25 October by alex", an unreadable one said with what to do, a service gone from the workspace listed apart so its values can be removed.
   - The form: the service when there are several, the name, and the value in a password field, emptied once saved.
   - The words say test values only, since the session's agent can read them, and that a change reaches the next session that starts.
   - The step's catalog keys are `test_values_*`, as the assistant lane chose: the guard reads a key with "secret" in it as an assigned secret. The Services catalog repeats the shared keys, and a test keeps both copies equal.
   - The panel's service groups carry `data-test-values-service`, not `data-service`, which the map's buttons already use.

**Questions for the owner** (defaults applied):
1. A reader's session gets no value (applied): it reads code and runs no test. Or give it its service's values too.
2. Postgres and the other declared test services get none (applied): the plan says "the test services", but their environment is fixed and they run no project code; the real siblings do, and they get them. Or give them to every declared service too.
3. Any signed-in person may set, replace and remove a value on the Services screen (applied), as section 12 says; only the owner in the assistant. Or the owner alone on both.

**Open.**
- **A restart forgets old values.** The cleaner's list is the values the service held since it started. A value replaced before a restart is no longer removed, if a session container started before that restart still holds it. A hash of each old value would keep it, but a hash of a short value can be guessed; nothing is kept on disk but the sealed current values.
- **Docker shows them.** `docker inspect` of a session container shows its environment to an account in the `docker` group, which already has root's reach on the host (the README says so).

**Not done here.**
- No Docker object was made: the tests' fake `docker` records each command line and the environment it was given. Docker's `--env NAME` form, which reads the value from the client's environment, is the CLI's documented one.
- No real secret anywhere, no real account. Out of scope, as section 12.3 says: production secrets, a vault or a cloud secret manager, secrets per ticket.

**Tests first.** `88f47cf9` committed the tests alone. On it:
- the store's, the routes', the cleaner's, the runtime's and the publish tests could not load `src/secrets/`;
- the services tests could not import `testVariables`;
- the two new docker cases failed: no `privateEnv`, and the runner did not pass its environment on;
- the step's screen test failed on its stub (no value listed, no Done), and the panel's test could not load `TestValues.tsx`.

The publish case that refuses a branch holding a value came after, from a second read of `publish.ts`: the guard reads the commits, but not for these values.

**Files outside the lane's list**, each for the values' path, nothing else changed:
- `src/container/docker.ts` (decision 5);
- `src/session/adapters/claude-code.ts`, `codex.ts` and `cursor.ts`: the service and the role, one line each (decision 4);
- `src/workspace/publish.ts` (decision 7);
- `src/mcp/redact.ts` (decision 6);
- tests: `test/container/docker.test.ts`, `test/workspace/publish.test.ts`, `test/mcp/redact.test.ts`, and three that took the secrets step for a stub or "Service" for an untranslated word: `app/test/setup/setup-browser.test.ts`, `app/web/test/setup/setup.test.tsx`, `app/web/test/i18n-audit.test.tsx`. Lane `v2-j5-first-ticket` edited the first two as well; they were joined at the merge of 440;
- `app/web/screens/services/Services.tsx`, `services.css` and `app/messages/services.{en,fr}.json`: the panel mounted and its words;
- `app/fixtures/source.ts`: the panel's routes on the fixtures, names and dates only, a value read and dropped.

**Captures.** `docs/v2/test-secrets/`:
- the step at 1440, 1280, 768 and 390 px, light and dark, in English, and at 1440 in French, by `app/test/setup/secrets-browser.test.ts`;
- the panel at the same widths, light and dark, in English, and in French, dark, by `app/test/services/test-values-browser.test.ts`.

Both run with `CLEARED_V2_CAPTURES`.

**Checks.** Run on this branch at `origin/v2` `eb81a2ed`.
- `npm run typecheck` passes.
- `npm test`, with `CLEARED_V2_PLAYWRIGHT` set and the browser tests on this server's Google Chrome (`CLEARED_V2_CHROME`: the Chromium build that `playwright-core` names is not installed here, and every browser test failed at its launch without it): 2805 Node tests, 2801 pass, 2 skipped, 2 fail. Neither is this lane's:
  - `test/flow/proof-capture.test.ts`, the real browser's capture: its after page and its video fail. It fails the same way on a clean checkout of `origin/v2` at `eb81a2ed`, run here on the same Chrome.
  - `app/test/foundation/budget-browser.test.ts`, the screen-switch budget: 106.9 ms at p95 under the whole suite's load, over its 100. Alone it passes on both trees (22.4 to 25.8 ms here, 23.6 to 29.4 ms on `origin/v2`). With the test's own load, `CLEARED_V2_BUDGET_SLOWDOWN=4`, it fails on both (139.6 and 144.3 ms here, 108.5 and 140.7 ms on `origin/v2`). The Services screen is not one of its five.
- 399 Vitest tests pass.
- The first full run found three tests that still took the secrets step for a stub (the assistant's walk in the browser, the stub test of `setup.test.tsx`) or found "Service" written alike in French and English (`i18n-audit.test.tsx`). The walk now expects the step's no-workspace line, the stub test renders the stub itself, and the two keys are on the audit's list of shared words.
- The panel's browser test leaves the shell's search and account buttons out of axe's label-in-name rule, as `app/test/a11y-browser.test.ts` does and says why; the rest of the page is checked whole.
- `npm run guard -- --base origin/v2`: nothing refused. A first run refused four lines of a test, a message id of ten digits read as a phone number; the id is letters now.
- The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.**
- No Docker object, no real account, no Claude Code login read.
- No Slack, Cursor or Codex account used.
- Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issue and the pull request, nothing else.
- Ports: only the tests' own ephemeral loopback ones. No tunnel, no secret.

**The merge of 440** (lane `v2-j5-first-ticket`, issue #433, at `origin/v2` `012f5481`). 440 took the id P256, so this lane's line is P257: the matrix, section 12 of the plan and this entry say so. Two tests both lanes edited were joined: the assistant's browser walk now meets every later step filled, each saying it has no workspace yet, and the i18n audit's list of shared words holds both lanes' additions.

- Pull request: 441, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-secrets`.

## 2026-10-27: the setup session: a ticket of the Environment template, its branch built and checked before the review, its image built after the merge, proposed by the assistant (the author's choices, lane `v2-j5-env-setup`, C4, M10, P258, issue #435)

**The need.** Issue #435, section 13 of [milestone-5-plan.md](milestone-5-plan.md) (matrix C4, and M10's setup sessions; decision 14). A repository with no `.devcontainer` runs on Cleared's session image, where its tests may not run. The lane adds:
- a ticket template "Prepare the environment", whose author writes the `.devcontainer`;
- before the reviewer, the branch's image built with section 10's builder and the declared check run in it, a failure sent back to the author with its output cleaned and cut;
- the prepared image built again after the merge;
- the proposal, by the assistant's environment step and its workspace step, for a service with no `.devcontainer` or whose check fails in its image.

French and English, with fakes for Docker and the harness, and one real run on this server. As earlier lanes noted, the brief's section 6 (`PROMPT.md`) and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-env-setup`. Git refuses that name while a local branch `v2` exists, so the lane runs on `v2-j5-env-setup`, as the other milestone 5 lanes did.

**Decision.**
1. **The template is a sixth kind of ticket, `environment`** (`type:environment`), in the tower's bar beside Bug, Review, CI and Question, and in `cleared run --template`. Its body says what Cleared reads of a `.devcontainer` (`image`, or `build.dockerfile`), that a Dockerfile starts from Cleared's session image, that the dependencies install with `[session] install_command`, and that features and lifecycle commands are not read. The harness pick counts it as `other`: its wins say nothing of a harness, and `api/types.ts` is not a milestone 5 lane's to edit.
2. **When the check runs.** In `#authorDone`, after the fast lane's reading and before the ticket moves to review: after the first author turn, and after each turn that answers a reviewer, so no reviewer ever reads a branch whose image does not build. A ticket of another template makes no Docker call.
3. **What is built.** The image the branch would give the service once merged: the builder reads the branch's commit (fetched into the service's checkout as a step's branch is) instead of the base, for the `.devcontainer`, its Dockerfile, the lock files and the install command, since the session writes them. The check itself, `[session] test_command` (else `npm test`), and the test services are read from the base, as the fast lane reads its settings: the branch cannot change what judges it.
   - `readInputs` takes `at`, `exportBase` takes `commit`, and the build's middle is `buildPrepared`, which `PreparedImages` calls as before.
   - The check's images are tagged `cleared-v2-check-<service>:<hash>` and labelled with a session id of the check's own, never `cleared.service` or `cleared.prepared`: the prepared images' cleanup cannot count one, and the check removes them with its container and network, whatever happens.
4. **How the check runs.** In a container of that image, the branch's tree mounted at `/workspace` from under the state folder (which a Compose install mounts at the host's path), no capability, the session's limits, `sleep` as its program. Its declared test services (`[session] services`) run first on an internal network of the check's, the isolated gateway as a session's, and are waited for until ready (60 seconds); the check is on that network only, with their variables. With no service, it has no network at all.
5. **The branch's Dockerfile builds with Docker's default network**, as a prepared image's does. Installing a system package is what a setup session's Dockerfile is for, and with `--network none` it could not. It is unreviewed code on the host's builder, with no secret, no mount and the label; question 1 asks the owner.
6. **What goes back.** The result is a comment on the ticket, in English as every comment the flow writes, cleaned by the service's cleaner, its output the last 15 lines, each cut at 300 characters, a code fence in it defused. Durations read "34 s", "2 min 10 s", "1 h 05". A failed build keeps the build's last lines: a `DockerError` now carries the last 40 lines of what the command wrote, since BuildKit's first line only says which builder ran. A failure resumes the same author with the result and what to change; the third failure puts the ticket back in Todo (`env_check_failed`, question 2), and so does a check that cannot run (Docker down, a test service never ready). The rounds are rows of `env_checks`, kept across a restart.
7. **No check declared**: the image building is the whole check, and the comment says so (section 13.3).
8. **After the merge.** `preparedAfterMerge` builds again the image of a service that has one. `environmentAfterMerge` builds the first one of a service that has none, which a setup session of a newly connected service needs.
9. **The environment step.** After a Build, each ready image runs its service's declared check, as above but on the base's tree, unless it already passed on that image; the result is `<state>/prepared/<service>.check.json` (mode 600). Each service then says its check, and a setup session is proposed for a service with no `.devcontainer`, whose image did not build, or whose check failed. Start makes the ticket, in the person's language from the tower's catalog, and starts it as the owner, as the tower's Create does. One open session per service: a second Start answers the open ticket.
   - The running flow reads the workspace at its start (issue #420): a service connected since is refused with `restart`, and no running flow with `no_flow`; the screen says to restart Cleared and offers no Start.
   - The summary no longer says "every image is ready" in green when a check failed in one.
10. **The workspace step** says which connected services have no `.devcontainer`, with a link to the environment step. It reads the base of each checkout; nothing else changes there.

**Questions for the owner** (defaults applied):
1. The branch's Dockerfile builds with Docker's default network, before any review (applied), so a setup session can install a system package. Or build it with no network, which keeps unreviewed code off the network and makes most setup sessions impossible.
2. Three failed checks put the ticket back in Todo (applied). Or more rounds, each an author session's tokens and time.

**The real run** (this server, 2026-10-27 from 11:42:48 to 11:42:58, Docker 29.8.1, every object labelled `cleared.dev=v2`). A copy of the guestbook without its `.devcontainer` as a bare repository and the service's checkout, in a scratch folder; two branches written by the author of the lane in place of a session, each fetched as the flow fetches one, then `checkBranch` with the real Docker through Cleared's wrapper. The base declares `npm test` and `postgres:16`. Both Dockerfiles start `FROM cleared-v2:local`, Cleared's own image (Node 24, root) built by the compose lane's run, since this server has no session image: the template's `cleared-v2-session`, whose user is `node`, was not exercised, nor a non-root user writing `/workspace`.
- `LOCAL-1`, a Dockerfile installing a package that does not exist: `build_failed` in 1 s, the comment holding Docker's own last lines, down to `E: Unable to locate package cleared-no-such-package`.
- `LOCAL-2`, a Dockerfile and `install_command = npm ci`: `passed`, "the branch's image built in 1 s from the Dockerfile its .devcontainer names, and `npm test` passed in it in 3 s" (9 s in all, the Postgres start included; the dependencies' layer was cached by the earlier tries of the day).
- Before and after, the same labelled containers, images and networks: nothing the check made was left. `ss -ltn` before and after: the same listeners, but for one loopback port that another process of the machine held between the two readings and had closed seconds later; the run's own process had ended, and nothing it starts publishes a port.

The first tries found two defects, fixed here with a test each: the check's container exited at once on an image whose ENTRYPOINT is a program (it now has `sleep` as its own), and the guestbook's tests failed on the database the check did not give them (it now runs the declared test services).

**Not done here.**
- **No real author session.** This server has no session image (as section 10.6 found), and the author's login would be the service's own token. C4 and P258 stay `partial` until the rehearsal (section 16) runs one setup session to its merge.
- **The browser test does not press Start**: the assistant's browser harness runs no flow. The route is proven by the service's tests, the screen's start by its markup in both languages.
- **#436.** A check the service's stop interrupts leaves its labelled objects, under a session id no ledger row knows; `doctor docker` reports them.
- **A ticket in steps or with variants is not checked.** The check sits on the path of a ticket of one service and one author, which is what the assistant starts; a setup ticket a person splits into steps or runs as variants goes to its review as before.

**Tests first.** `b784a362` committed the tests alone. Run on that commit, in a scratch copy:
- `test/flow/env-setup.test.ts` and `test/setup/environment.test.ts` cannot load `src/flow/env-setup.ts`;
- the templates case fails (four templates), the connect case finds no `devcontainer` field, and seven of the screens' cases fail (no check line, no proposal, no Environment template);
- the harness pick's new case passes there too: it guards that the new template stays `other`.

**Verification.**
- `npm run typecheck` in `v2/`: clean.
- `npm test` in `v2/`: 2784 node tests, 2662 pass, 0 fail, 122 skipped; 396 vitest tests pass.
- The root suite (`node --test test/*.test.ts`): 413 tests, 411 pass, 2 skipped.
- The browser tests `environment-browser`, `workspace-browser`, `tower-templates-browser`, `setup-browser` and `checks-browser` pass in both languages, axe finding nothing.
- `npm run guard -- --base origin/v2`: nothing refused. A first run refused two catalog lines, keys named `environment_check_passed`, which the guard reads as an assigned secret (as P246 found for "pass"); the key is `environment_check_green`.
- The race and the rounds per run, found at a second read: the set-aside case fails with the guard removed from the engine, and passes with it.

**The merge of 440 and 441** (lanes `v2-j5-first-ticket`, issue #433, and `v2-j5-secrets`, issue #434, at `origin/v2` `08484fea`). They took the ids P256 and P257, so this lane's line is P258: the matrix, section 13 of the plan and this entry say so. Both sides of the matrix and of this log are kept, theirs first, as they merged first.

- Pull request: 439, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-env-setup`.

## 2026-10-27: the README for v2, and a newcomer's pages: install, troubleshooting, `cleared run` and its API (the author's choices, lane `v2-j5-docs`, B6.5, P259, issue #442)

**The need.** Section 15 of [milestone-5-plan.md](milestone-5-plan.md) (matrix B6.5): the root `README.md` still described v1 (systemd, Tailscale, Orca terminals) and sent the reader to `v2/README.md` to start anything. The lane writes the README and the pages a newcomer follows: `docs/install.md`, `docs/troubleshooting.md` and `docs/run.md`, with `v2/README.md` pointing to them, proven by `test/docs.test.ts`. English pages, no em dash, nothing on a real server. As earlier lanes noted, `PROMPT.md` and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**Decisions.**
1. **Quoted from the code, never paraphrased.** `docs/troubleshooting.md` quotes each line of the ready section that is not green as `src/doctor/messages/ready.en.json` writes it, placeholders included, under the check that prints it (the twelve ids of `READY_CHECKS`; the `workspace_*` lines are the `checkout` check's), with what to do as the doctor says it and a line of why where it helps. The test reads the catalog, so a line added to the doctor without a word in the page fails it. Notices are there too: a person asks about them as much as about failures. The install's refusals are quoted in `docs/install.md` the same way, from `src/cli/messages/install.en.json`.
2. **The assistant's steps** are the registry's (`src/setup/steps.ts`), in its order, under the names the assistant shows (`app/messages/setup.en.json`), each with a capture from the assistant's own browser tests. The owner step had none: one was taken (`docs/v2/setup-assistant/owner-1440-light.png`, 1440 px, light, English) with a scratch script on the same fakes as `app/test/setup/setup-browser.test.ts` (a scratch ledger, a fake container, this server's headless Chrome), the code on it a scratch service's. The Claude Code step shows the French capture, the only one there is, and says so.
3. **Updating** is `docker compose -f v2/compose.yaml down`, `git pull`, then the install with `--build`. Read from `src/cli/install.ts`: run while Cleared runs, the install changes nothing, and `run --rm install` alone does not build an image that exists. The page says this path is derived and not yet run; the plan keeps upgrading in place out of scope (section 4.3).
4. **Removing everything** lists the four kinds the Docker wrapper labels (`create`, `build`, `network create`, `volume create` in `src/container/docker.ts`), each by `--filter label=cleared.dev=v2`, after `down`, and says what the label cannot tell apart: a second install on the machine goes too. The state folder is removed last, by hand, said irreversible, with what it holds.
5. **SSH from elsewhere** forwards the app's port and the previews' (8794): `app/src/preview.ts` serves the Browser tab's previews from their own loopback origin, which the browser loads directly.
6. **What a Compose install cannot do yet is said where the newcomer meets it**: the first ticket's step and the troubleshooting page name #438 (no project for the release lock), with #420, #421, #436 and #437 listed once, in troubleshooting. The README's status says the proof (B6.5p) has not been run.
7. **The Compose forms** of `cleared doctor` and `cleared run` (`docker compose -f v2/compose.yaml run --rm --no-deps service cleared ...`) are the ones the Checks step and `v2/README.md` name. `cleared run`'s form needs its token file under the state folder, the only folder of the machine that container sees; the page says it is not yet run.
8. **The templates `cleared run` takes** are listed from `TICKET_TEMPLATES`, which the command checks: `bug`, `review`, `ci`, `question` and `environment`. Its usage line in `src/cli/messages/run.{en,fr}.json` still lists four, since the Environment template (P258) came after; not this lane's file.
9. **The v1 pages** of `docs/` (concepts, configuration, security, the app, trackers, notifications, heartbeat, memory, roadmap) are named in the README as written for v1 and kept; rewriting them is not section 15's.
10. **The wording test over the new catalogs.** `test/wording.test.ts` already walks every catalog of `app/` and `src/`, the milestone 5 ones included, and passes unchanged. `test/docs.test.ts` applies its prose rules (no em dash, no dash used as a pause, no emoji, no filler) to the four pages outside their code, where a shell line may hold a `!` or a `--`.

**Files beyond section 15.4**: `docs/v2/setup-assistant/owner-1440-light.png` (decision 2), section 15.6 of the plan (`test/milestone-5-plan.test.ts` asks every milestone 5 line of the matrix to be named there), the matrix and this log.

**Tests first.** `9062aee8` committed `test/docs.test.ts` alone. On it, 8 of the 12 cases failed: the pages did not exist, the README had no section "What it needs", and `v2/README.md` linked none of them. The 4 cases that were there passed.

**Checks**, on this branch at `origin/v2` `ceb1589f`:
- `npm run typecheck` passes.
- `npm test`: 2851 Node tests, 2716 pass, 135 skipped, 0 fail; 413 Vitest tests pass. A first run failed one case, `test/milestone-5-plan.test.ts` (P259 not named in the plan), fixed by section 15.6.
- `test/docs.test.ts`: 12 of 12 pass; `test/wording.test.ts`: 2 of 2.
- `npm run guard -- --base origin/v2`: nothing refused. A first run refused a line of `docs/run.md`, an `export` of `CLEARED_V2_API_TOKEN_FILE` read as an assigned secret; the page names the variable in prose. The guard reads `v2/` and the v2 workflow only, not `docs/` or the root README, and runs without the private-term list; the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object, no real GitHub, GitLab, Slack, Cursor or Codex account, no Claude Code login read, no doctor run. Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issue and the pull request. Ports: the capture's scratch service and app, and the tests', on ephemeral loopback ports. No tunnel, no secret.

- Pull request: 444, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-docs`.

## 2026-10-27: the proof's rehearsal, the one command then the assistant in a browser to a first ticket live, on fakes at the edges, and the real run's sheet (the author's choices, lane `v2-j5-proof`, B6.5p, P260, issue #443)

**The need.** Section 16 of [milestone-5-plan.md](milestone-5-plan.md) (matrix B6.5p): `v2/scripts/proof-j5.ts`, the rehearsal of section 1's ten steps on this server, under a scratch Compose project name and a free port, every Docker object labelled `cleared.dev=v2`: the one command, then Playwright through the assistant with a fake GitHub and the fake harness to the first ticket's approval and a fake live, each step's time, the report as `proof-report.ts` writes the others, everything removed by the label at the end; and `docs/v2/proof-j5.md`, the real run's sheet. Proven by `test/scripts/proof-j5.test.ts` and the rehearsal's run. The real run is out of scope (question 5). As earlier lanes noted, `PROMPT.md` and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the brief's milestone 5 paragraph was read from the orchestrator's copy, and the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** `v2-j5-proof`, from `origin/v2` at `ceb1589f`.

**Decision.**
1. **The one command as the README gives it.** `docker compose -f v2/compose.yaml run --rm install`, with `COMPOSE_PROJECT_NAME` set to `cleared-v2-proof-<8 hex>` and the three ports chosen by `freePort` of `proof-rehearsal.ts` (9700 to 9799, free in `ss -ltn`, never a reserved one). The language is the run's (`--language en|fr`).
2. **The image built just before, and timed apart.** The image copies the clone (`COPY . .`), and the install builds it only when the tag is missing, so a machine that holds an older `cleared-v2:local` would rehearse old code. The rehearsal runs `docker compose build install` first. Step 1's machine time is the build plus the command, the build said in the note. On this server the build reuses the layers Docker keeps in its cache, so neither is a fresh machine's time.
3. **Another install's image is kept under a second name.** Under Docker's containerd image store, an image whose only tag moves to another is gone as an image, even while containers run on it. The rehearsal gives the image the shared tag names a second labelled name, `cleared-v2-proof-keep:<8 hex>`, before its build, removes its own build at the end, puts the tag back, then removes the second name. This was found the hard way: see "What the first run did" below.
4. **The fakes reach the service through one recreate.** `install.ts` calls Compose with `v2/compose.yaml` alone, `gh` in the image is found on its `PATH`, and the settings file takes `CLEARED_*` and `GH_TOKEN` only. So after the command the rehearsal recreates the service once, with an override file of its own folder that adds environment variables and that folder's mount at its own path, for the service only: no port, no other service, `v2/compose.yaml` unchanged. The service prints a new setup code at that start, which the rehearsal reads from its log. The command's own setup line is checked in its output.
5. **The fakes, at the edges only.** A fake GitHub on an ephemeral loopback port (`CLEARED_V2_FORGE_GITHUB_API`) answers the forge step and the doctor: the account, its repository with the right to push, 401 to any other credential. A `gh` stand-in on the service's `PATH`, this file run by the image's node, answers `gh api` for the repository list and one repository, and hands the pull requests to the milestone 2 stand-in of `proof-rehearsal.ts`. A bare copy of the example guestbook is the remote. The fake harness (`CLEARED_V2_ADAPTER=fake`) plays an author that proposes a session plan of high confidence, then adds the first ticket's line after the README's last one at its Go, and a reviewer that passes it. No cost is reported by a fake, so no money reaches a page. The milestone 2 stand-in lock (`startBroker`), on a Unix socket of the rehearsal's folder (`CLEARED_RELEASE_SOCKET`), merges into the bare copy and writes the release watch's rows. The assistant, the inbox, the flow, the approval and the doctor are Cleared's own, in its containers.
6. **The browser does what the assistant shows.** Headless Chrome through `playwright-core` (`CLEARED_V2_PLAYWRIGHT`, `CLEARED_V2_CHROME`), with the selectors of the setup browser tests. The test secrets are skipped. The checks step goes on when no line failed, else the failing lines are reported and the step is skipped. The session plan's Go and the approval are given in the inbox, as a person gives them.
7. **The times.** Steps 2 to 8 and the first-ticket step's whole come from the assistant's records (`GET /api/setup`, through the app). The rehearsal's clock splits steps 9 and 10 at the approval and says the waits for the Go and the approval, the approval's grace to undo included. The total is the command's time plus the records', said against the hour. Durations as `duration()` of `proof-report.ts` says them ("1 min 05 s", "1 h 05"), no millisecond. Money only from a real source: none here.
8. **The report** is markdown, written outside the repository (`--report`, else the temporary folder), with the steps, the totals, the commands typed and files edited after the one command (none, by construction), what did not pass, what the rehearsal replaced, and the cleanup. It is a developer's record in English, as `proof-report.ts`'s are. No string a person reads in the product is added, so no catalog changes.
9. **The cleanup.** It removes each object with the label that belongs to the scratch project, or that is new since the start and of no Compose project: the prepared image, a network the service made. It never removes another project's object, one that was there before, or one without the label. Each kind is listed with the label's filter. Containers, then networks, then images, then volumes, each removed by id, never `prune`. Then the tag goes back, and the rehearsal's folder is removed. It counts what is left by the same filter.
10. **The real run's sheet** (`docs/v2/proof-j5.md`): the machine and the accounts, what the newcomer is given (the repository's address, nothing else), what the observer records (the assistant's table, the command's time, the README's reading time, every command and hand edit, every question, the screen only with the newcomer's agreement and never committed), what counts as a pass (under 60 minutes from the repository's page to live, no command after the one command, no hand edit, live as question 2 (a) says, each step done or skipped where it may be), what is known to stop it, and how to remove the run.

**What the rehearsal found** (each outside this lane's files, so each is an issue, and the rehearsal works around it with a stand-in its report names):
- **#445: the release cannot be requested on an install by the assistant.** The approval of a single service reads the verdict phrase from `CLEARED_CONF` or `<CLEARED_REPO>/.cleared/agents.conf`, once at its start, and the pull request's head through `CLEARED_REPO`. Such an install sets neither. The first ticket went back to Todo after its review, first with "[merge] verdict is not set", then, with `CLEARED_CONF` given, with "the version (commit) the review read is not known for #101". The rehearsal gives the service both. Without this fix, step 9 cannot pass on a real install.
- **#446: the session plan's Go is not shown by the first-ticket step.** The first ticket's author is held until its plan has a Go (decision 22 of milestone 2): the owner's in the inbox, or the delay's after 10 minutes for a plan of high confidence only. The step shows "the author" all that time and links to the inbox only at the approval. The rehearsal gives the Go in the inbox, and its report lists the gap under what did not pass.
- **#438, already open:** the Compose broker idles without a project, so the rehearsal's lock is a stand-in and step 10 under Compose is not proven.

**What the first run did** (11:47 UTC, run 1 of 8). Its build moved the tag `cleared-v2:local` off the image the Compose project `cleared-v2-e2e` was built from (the end-to-end test of 26 October). Under the containerd store that image ceased to be an image at that moment. Its three containers still run on their snapshots. The cleanup then removed the rehearsal's own build, and nothing could give the tag back. The tag `cleared-v2:local` is now absent on this server, so that project's next `run --rm install` builds its image again from its own clone. It was not rebuilt here: an image from this branch under that tag would silently replace that project's code. Decision 3 is meant to keep it from happening again. It is proven by the cleanup plan's test only, not yet on a real run: runs 2 to 8 found no tag to keep and left none, and a tag was not made again to try it, since that project's next install would then pick up this branch's image.

**Not done here.**
- No real run (question 5), no real GitHub, Claude Code, Slack, Cursor or Codex account.
- **The hour's split for a fresh machine** (section 21 of the plan) stays open: the build cache makes this server's build and command fast (1 min 25 s and 9 s in the last run), and the session and egress images were built from cached layers too.
- **`doctor images`' 10-second measure** (C15, P254) was not run: the rehearsal's sessions are the fake harness's and start no session container. C15 and P254 keep their `partial`.
- **The setup session (C4, P258)** was not rehearsed: the example guestbook has a `.devcontainer`, so the environment step builds its prepared image (8 to 9 s here) and proposes no setup ticket. C4 and P258 keep their `partial`.
- The person's times are a script's: Playwright reads nothing.

**Files outside the lane's list:** section 16.6 of [milestone-5-plan.md](milestone-5-plan.md), since the plan's test reads each milestone 5 line there, as the other lanes' delivered sections do; the matrix and this log, as the brief asks.

**Tests first.** `5167fd20` committed `test/scripts/proof-j5.test.ts` alone. On it the file could not load (no `scripts/proof-j5.ts`). Changed with the code, each for a finding of a run: the cleanup's plan takes the second name of the kept image (run 1); the fake author proposes a session plan, and the times split the Go apart (run 1's "The session ended without finishing its turn" at the plan gate); the override carries `CLEARED_CONF` and `CLEARED_REPO` (runs 3 to 5, #445).

**Checks**, on this branch with `origin/v2` at `3abb30f7` merged (pull request 444):
- `npm run typecheck` in `v2/`: clean.
- `npm test` in `v2/`: 2866 node tests, 2731 pass, 0 fail, 135 skipped; 413 vitest tests pass. Before the merge, `test/milestone-5-plan.test.ts` failed on P260 until section 16.6 named it.
- `node --test test/scripts/proof-j5.test.ts`: 15 tests pass.
- The rehearsal, runs 7 (English) and 8 (French): the ten steps done or skipped as the sheet allows, total 3 min 39 s and 3 min 33 s, under the hour; 7 objects removed by the label, 0 left; the labelled containers, images and networks after each run the same as before it; no port of 9700 to 9799 left listening. Runs 1 to 6 stopped at step 9 on the findings above, each cleaned up the same way. The reports are quoted in the pull request, with the folders replaced.
- `npm run guard -- --base origin/v2`: nothing refused. The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** Docker, on objects labelled `cleared.dev=v2`: the scratch projects' containers, the images they built (`cleared-v2:local`, the session and egress images, the prepared image), and the tag of decision 3. Beyond the label: one listing of every image of the machine and one `docker info` while reading the server, at the start, and the builds' base image `node:24`, which carries no label and stays. Ports: three of 9700 to 9799 and one ephemeral port for the fake GitHub, all on `127.0.0.1`, and the tests' own ephemeral loopback ones. No tunnel, no secret, no Claude Code login read. Network: `npm ci`, the image builds (Docker's and npm's mirrors), `git fetch`, and GitHub for the issues and the pull request.

- Pull request: 447, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-proof`.

## 2026-10-27: the rehearsal's three findings fixed: the Compose broker finds its project, the release is requested after the assistant, the first-ticket step shows the plan's Go (the author's choices, lane `v2-j5-proof-fixes`, B6.5, B6.5p, P261, issues #438, #445, #446)

**The need.** The proof's rehearsal (P260, pull request 447) listed three gaps that stop a real run, each outside its files: #438, the Compose broker gets no project from the assistant; #445, the release cannot be requested on an install by the assistant; #446, the first-ticket step does not say the session plan waits for its Go. One commit per issue, a test for each, French and English, fakes only, nothing on a real server, no deploy. As earlier lanes noted, `PROMPT.md` and sections 9 and 10 of `milestone-2-plan.md` are not in the repository; the conventions followed are those of section 3.1 of the milestone 5 plan.

**The branch.** The brief asked for `v2/j5-proof-fixes`. Git refuses that name while a branch `v2` exists, so the lane runs on `v2-j5-proof-fixes`, from `origin/v2` at `d89fd11d`, as the other milestone 5 lanes did.

**Decision.**
1. **#438: the broker looks for its project while it waits.** The issue offered two ways: the broker reads what the assistant wrote, or the workspace step restarts the broker. Restarting would give the service a Compose gesture it does not have today, so the broker role of `images/cleared/entrypoint.ts` looks again every 5 seconds. Its project is the checkout `CLEARED_V2_PROJECT_DIR` names, as before (a hand-made project wins), else the service of the workspace whose lock is the default one (no `broker_socket`, no `broker_state`), the workspace being the one the environment or `<state>/settings.conf` names. That checkout needs its `.cleared/agents.conf`, as before. A workspace the service would refuse locks nothing, and a service with a broker of its own is that broker's. One container serves one lock: a workspace of several services needs a broker per service (decision 21 of milestone 2), which the Compose file does not run, and that is unchanged.
2. **What the broker is given when it starts.** The settings file, applied as the service and the app apply it, under the environment: `GH_TOKEN` among them, since `merge-pr.ts` and the broker's head check call `gh`. A project found in the workspace is served on the state folder's socket, whatever its `agents.conf` says of `[security] socket_path`, because the service asks that socket when no `CLEARED_CONF` names another (`approval/broker.ts`). The log says which checkout it locks. The waiting line no longer says to restart the broker.
3. **#445: the flow passes what it knows.** The issue suggested reading the verdict from the service's checkout at need and the head through the forge contract. The one-service path already holds both at the moment it records: the head it has just published, and the `[merge] verdict` of the service's settings it judged the review by. It now passes them, as the train path does (`engine.ts`, `recordReview` with `commit` and `verdictPhrase`), and `ReviewRecord` has the two optional fields that `review.ts` already expected. No forge call is added. The phrase of a file the environment names (`CLEARED_CONF`, or `CLEARED_REPO`'s project) still wins, since the v1 lock reads that one, so a hand-made install behaves as before. `resolveHead` stays the fallback of a record without a head.
4. **#446: option (a).** The step's stage is `plan` while a `session_plan` item of the ticket waits in the inbox: it says the plan waits for the person's Go, and links to that item (`/inbox#<id>`, the form the inbox opens). The author's gesture of the flow is kept for every ticket, so option (b) (the first ticket started with its Go given) was not taken. The stage is drawn on the author's row of the list: a stage "plan" of its own would come back after "author" once the Go is given, or stay shown when the author tools are off, since `authorTools` decides whether an author plans. The proposal's note now says the plan's Go comes first, then the review and the approval. The delay's Go is not named in the step: its minutes are a service's setting, and a plan of medium or low confidence never gets it.

**Tests first.** Each fix's commit holds its test and its code; each test was run on the code before it:
- #446: `test/setup/first-ticket.test.ts`, "the plan waits for the owner's Go", failed with `'working' !== 'plan'`; `app/web/test/setup/first-ticket.test.tsx`, its two new cases failed (a missing key, then the proposal's note without the Go).
- #445: `test/approval/environment.test.ts`, "with no CLEARED_CONF nor CLEARED_REPO", failed with `[merge] verdict is not set`; `test/flow/engine.test.ts`, the whole ticket's case, failed on the record without `commit` and `verdictPhrase`.
- #438: `test/install/entrypoint.test.ts`, both new cases failed: the lookup found no project in the workspace, and the broker role said to restart it. The role's test runs the entrypoint as a command, as the state folder's owner, writes the workspace while it waits, and sees it start on the state folder's socket, a Unix socket of the test's own folder. Its checkout is a `git init` folder, since the v1 broker reads a git checkout, as the assistant's clone is.
- A fourth commit puts a no-break space before the colon in the new French line, as the catalog writes it; `test/install/install.test.ts` caught the same in the command line's catalog before the #438 commit.

**Files outside the issues' own.** `src/modules/registry.ts` (the record's two fields), `docs/install.md`, `docs/troubleshooting.md` and `docs/v2/proof-j5.md` (the gaps they listed), section 16.7 of [milestone-5-plan.md](milestone-5-plan.md) (the plan's test reads each milestone 5 line there), the matrix and this log.

**Captures.** The first-ticket step's proposal, in `docs/v2/first-ticket/`, taken again by `app/test/setup/first-ticket-browser.test.ts` with `CLEARED_V2_CAPTURES`, since its note changed. The live captures changed only by their rendering and were kept.

**Not done here.**
- **No Compose run and no rehearsal.** The broker on a real install, and the release request after the assistant, are proven by tests. `scripts/proof-j5.ts` is unchanged: its next run can drop `CLEARED_CONF` and `CLEARED_REPO` from its override, and follow the step's link to the plan. Three of its report's strings are now stale and were not edited without a run: the stand-in for #445 ("without them the release cannot be requested"), the lock's ("the Compose broker idles"), and the line about #446 under what did not pass. Its stand-in lock stays until the lock's key is settled.
- **The lock's key** (question 1 of lane `v2-j5-first-ticket`, default (c) applied): the v1 lock still reads `human_public_key` from the project's `agents.conf` only, so on a Compose install an approved first ticket is not merged until that line is in the repository. `docs/troubleshooting.md` and `docs/install.md` now name this gap instead of #438.

**Checks**, on this branch at `origin/v2` `d89fd11d`:
- `npm run typecheck` in `v2/`: clean.
- `npm test` in `v2/`: 2871 Node tests, 2736 pass, 135 skipped, 0 fail; 415 Vitest tests pass.
- `app/test/setup/first-ticket-browser.test.ts` with `CLEARED_V2_PLAYWRIGHT` and `CLEARED_V2_CHROME` naming this server's headless Chrome: 2 pass, in both languages, axe finding nothing. The other setup browser tests were not run: their screens are unchanged.
- `npm run guard -- --base origin/v2`: nothing refused. The guard does not read `docs/v2/`, so the lane's diff was also searched for the owner's name, the organisation's and the first piloted project's: none.

**Resources.** No Docker object, no real GitHub, GitLab, Slack, Cursor or Codex account, no Claude Code login read. Network: `npm ci` of the lock file, `git fetch`, and GitHub for the issues and the pull request. Ports: only the tests' own ephemeral loopback ones; the broker's test listens on a Unix socket of its own folder. No tunnel, no secret.

- Pull request: 448, against `v2`.
- Author: Opus 5.5 (claude-opus-5-5), lane `v2-j5-proof-fixes`.

