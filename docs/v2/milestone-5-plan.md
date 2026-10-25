# Cleared v2: milestone 5 plan

Written on 2026-10-25 by the author of issue #404 (Opus 5.5), before any code of milestone 5. The brief's section 6 for milestone 5 is not in this repository; its content is taken from the matrix lines that repeat it ([requirements-matrix.md](requirements-matrix.md)): D14 (one server, Docker Compose, a one-command install, the installer part of the product), B6.5 (the one-command install, the browser setup assistant, `cleared doctor`, the README and documentation) and B6.5p (the proof), with the milestone 5 items of the two complements: C4, C15, C16 and C18 from [complement-devin.md](complement-devin.md), M10 from [complement-multi-depots.md](complement-multi-depots.md). Other inputs: issue #404, the [decisions log](decisions-log.md) up to the entry of lane `v2-j4-mirror-doctor` (P246) and the ten ideas of 2026-10-25, and the code at `origin/v2` `c3de885`.

`milestone-2-plan.md` has no sections 9 and 10, as the lanes of milestones 3 and 4 noted; the conventions followed are those of sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md), adapted in section 3 below. This plan's branch is `v2-j5-plan`: `v2/j5-plan` cannot exist beside the local branch `v2`.

Milestone 5 runs as thirteen lanes, sections 4 to 16, in five waves (section 17). No matrix line `P` is added by this plan: each lane adds its own when it delivers, at the next free id.

## 1. The proof (B6.5p), as measured steps

A developer who does not know Cleared, on a fresh machine with Docker, installs it and takes a first ticket to live in under an hour, following the assistant only. After the one command, they type no command on the machine and edit no file by hand.

| Step | What the newcomer does or sees | Measured as |
| --- | --- | --- |
| 1 | Runs the one command (section 4, question 1). It checks the port, builds or pulls the images, starts Cleared and prints the address and a setup code | command start to the app's first answer |
| 2 | Opens the address, types the setup code, creates the owner account with a password | first page to signed in |
| 3 | Connects the forge: a GitHub token, checked on the spot | step shown to step done |
| 4 | Connects the model: a Claude Code token from `claude setup-token`, run in the assistant's own terminal, or an API key (question 3) | step shown to step done |
| 5 | Picks the repository, or several, from the list the token reaches; the links between them are proposed and confirmed | step shown to step done |
| 6 | The environment: the project's `.devcontainer` is found, or a setup session is proposed and run (C4); the prepared image is built (C15) | step shown to image ready, the build counted as the machine's time |
| 7 | Adds the test secrets the project's tests need (C16), or skips the step | step shown to step done |
| 8 | The checks: `cleared doctor`'s readiness section, each line green, or red with what to do | step shown to all green |
| 9 | Creates the first ticket from the assistant's template and moves it to Todo; watches the session, the review, approves in the inbox | ticket created to approval |
| 10 | The change goes live through the lock and the health watch (question 2) | approval to live |

Each step's time comes from the assistant's own records (section 5), split into the person's time and the machine's time, and the total is shown on the assistant's last page. The proof passes when the total is under 60 minutes and no step needed a command or a hand-edited file.

Two runs:

- **The rehearsal** (lane `v2-j5-proof`, section 16): on this server, every Docker object labelled `cleared.dev=v2`, the assistant driven by Playwright with fakes for GitHub and the harness, timed step by step. It proves the path, not the hour.
- **The real run**: a fresh Linux machine with Docker, a person who does not know Cleared, a real GitHub account and a real Claude subscription. It needs real accounts and a fresh machine, so it is the owner's (question 5).

## 2. Where milestone 5 starts

What exists at `c3de885`:

- **Settings are environment variables only** (`CLEARED_V2_*`, read in `src/config.ts`, `src/flow/config.ts`, `src/workspace/config.ts` and each module), with a workspace file named by `CLEARED_V2_WORKSPACE` for several services. Nothing writes them for the person.
- **Commands**: `npm run setup -- --owner <name>` makes the approval key and prints the public key to commit; `npm run user -- add <name>` adds a person; `npm run status`; `npm run import-v1`; `node scripts/doctor.ts` with the sections `docker`, `pool`, `claude-code`, `host-tools`, `lead`, `workspace`, `cursor`, `codex` and `mirror`, all in one file of 1234 lines.
- **Images** are built by hand (`images/session`, `images/egress`, `v2/README.md`, "The session image"). `src/container/devcontainer.ts` reads `image`, or `build.dockerfile` with its context, from a project's `.devcontainer/devcontainer.json`, and ignores every other key. Each session builds or pulls what it names at its start.
- **The model login** is a file: `CLEARED_CLAUDE_CREDENTIALS`, else `<state>/claude.token` (`src/session/adapters/claude-code.ts`), mounted read only into each session.
- **The forge is GitHub through `gh`**, called from `src/workspace/publish.ts`, `src/flow/effects.ts`, `src/flow/pr-close.ts`, `src/approval/service.ts` and v1's lock (`merge-pr.ts`, `release-request.ts`, `serve/release-broker.ts`).
- **The installer is v1's** `serve/install.ts`: systemd user units for the broker, the wake and the v1 app, served to the Tailscale network. There is no Compose file, no image of the service itself, no settings file and no first-run page.
- **What later lanes reuse**: the chat's route that makes a ticket from a signed request (P212, `src/flow/chat.ts`), the lanes' MCP server and its local token (P216, `src/mcp/lanes.ts`), the service map read at each base branch (P245, `src/map/`), the web terminal (O9), the ticket templates (P214), the doctor's `mirror` section as the model of a read-only check with French and English words (P246).

## 3. Decisions this plan takes

Each is taken here so that the lanes do not decide it again. A lane that finds one wrong says so in its log entry and its pull request.

1. **Linux with Docker Engine for milestone 5.** The service gives sibling containers host paths (each session's checkout, the login file, the egress allow list), so inside Compose its state folder is mounted at the same absolute path as on the host, and the egress relies on Docker Engine's isolated gateway mode (B5.4d). Docker Desktop on macOS or Windows runs containers in a virtual machine, where neither holds as written. Question 4 asks the owner whether the newcomer of the proof may be on a Mac.
2. **Compose, labelled.** One Compose project. Every service, network, volume and built image carries `cleared.dev=v2` (B3.1). Three running containers: `service` (the core, with the Docker socket: D10, the service alone talks to Docker), `app` (the web app, without the socket) and `broker` (the release lock, under its own user, sharing only its socket's volume with `service`). The session and egress images are build-only entries. The socket gives the `service` container root's reach on the host: the README says so, as it says it today for the account in the `docker` group.
3. **Ports.** Only the app is published, on `127.0.0.1` and `CLEARED_V2_APP_PORT` (8792 by default). The one command checks the port with `lib/ports.ts` before it writes or starts anything, as `serve/install.ts` does (#112): never 80, 443, 8787, 8788 or 8790, never a port in use. No tunnel. A person who reaches the machine from elsewhere uses their own SSH forward; the README says how.
4. **The one command needs Docker and git only.** It is written in Node and runs in a container (D11: no `curl | sh`, no bash). Until the owner answers question 1, the command is `docker compose -f v2/compose.yaml up -d` from a clone, which builds the images on the machine. Published images and a Compose file fetched from a registry wait for the owner: publishing is outward facing.
5. **A setup code on first start.** On a ledger with no user, the app answers only `/setup` and the service prints a one-time code to its log, which the one command shows. The code is shown once and stops working when the owner's account exists, or after 24 hours (a restart makes a new one). The address may be reachable by another account of the machine; the code proves the person at the browser is the one who ran the command.
6. **A settings file the assistant writes.** `<state>/settings.conf`, mode 600, in the format of `agents.conf`, read by the service and the app at start, under the environment: a variable that is set wins, so an install made by hand keeps working. Tokens are never in it: each is its own file of mode 600 in the state folder, named by the settings, written once by the assistant and never sent back to the browser. A screen shows "set on 25 October" and Replace, never the value.
7. **The model login from the assistant.** The assistant's model step offers a terminal (the web terminal of O9) in a throwaway container of the session image, with no checkout and no forge credential, where the person runs `claude setup-token`; they paste the token into the step's field. Nothing of that terminal is kept in the ledger. The newcomer installs nothing for it. An API key is the other choice (question 3).
8. **One `cleared` command.** `v2/src/cli/cleared.ts` runs `cleared <command>` as `src/cli/<command>.ts` when that file exists, so a lane adds a command by adding a file. In the image it is on the `PATH`; from a clone it is `node v2/src/cli/cleared.ts`. `doctor` (section 7) and `run` (section 8) are the commands milestone 5 adds.
9. **The assistant's steps are registered, one file each.** The assistant lane (section 5) creates the registry with a stub for each step of section 1, as milestone 1's module stubs: `v2/src/setup/steps/<step>.ts` for the service, `v2/app/web/screens/setup/steps/<Step>.tsx` for the screen, and a catalog pair `v2/app/messages/setup-<step>.{en,fr}.json` per step. A step lane fills its stub and never edits the registry or another step.
10. **The forge is a contract.** `v2/src/forge/contract.ts` names what Cleared asks of a forge: list the repositories the credential reaches, read one, open a pull request, read its head and its checks, comment, close, and the lock's merge. GitHub is its first adapter, wrapping today's `gh` calls with no change of behaviour; a service names its forge in the workspace file (`forge = github` by default). GitLab is the second (section 11).
11. **API tokens (C18) are a person's, and never approve.** Made in the app by a signed-in person, shown once, kept as a SHA-256 hash in the ledger, revocable. A token creates, starts and reads tickets as that person. It never approves a release (B5.9c), never answers a permission, never reaches `/setup` or the settings.
12. **Test secrets (C16) are encrypted at rest and reach the tests only.** Values are kept in the ledger, encrypted with AES-256-GCM under `<state>/secrets.key` (mode 600, made at first use): the ledger is copied (backups, `import-v1`, proof runs) and the key is not. A value is given to the test services and to the session's container as an environment variable, and the cleaner removes it from every event, comment, pull request body and receipt (B5.2b). The session's agent can read it, which is why the screen says test values only.
13. **Prepared images (C15).** Per service, `cleared-v2-prep-<service>:<hash>`, labelled `cleared.dev=v2` and `cleared.service=<service>`, where the hash covers the devcontainer file, its Dockerfile and the project's lock files at the base branch. Built after the service is connected and after each merge that changes one of them, with the dependencies installed by the project's declared install command when it has one. A session uses the ready image, or says it waits for one. The two newest per service are kept; older ones are removed by label and name only.
14. **The setup session (C4) is a ticket.** A ticket from a template whose author writes `.devcontainer/devcontainer.json`, with a Dockerfile for anything beyond an image (Cleared reads `image` and `build` only). Before the reviewer, the flow builds the image from the branch with C15's builder and runs the service's declared checks inside it. Then the usual review, approval and merge, after which the prepared image is built again.
15. **Links are proposed, never written alone (M10).** When several repositories are connected, the service map (P245) runs on the new checkouts. A call into another connected service's routes, or a contract file under a known name, becomes a proposed `consumes` or `contract` line. The person ticks what is right; only the ticked lines reach the workspace file.
16. **Words.** Every string a person reads is in French and English catalogs (B3.6), durations as a person reads them ("3 min", "1 h 05"), no figure in milliseconds. Money appears only when it comes from a real source (the agents' own report, as P243); otherwise tokens and time.

### 3.1 Conventions that keep lanes apart

- **One lane per file per wave.** Lanes of one wave never edit the same file. The waves table (section 17) lists each lane's files; a lane that finds it must edit another lane's file stops and asks.
- **Modules.** The assistant lane adds the stubs `v2/src/modules/{setup,run,secrets}.ts` to `src/main.ts` in wave 1. Later lanes fill their stub and never edit `main.ts`.
- **Route shapes.** Each new module keeps its request and answer types in its own `v2/src/<area>/types.ts`, imported by the app; `src/api/types.ts` is not edited by milestone 5 lanes.
- **One doctor, sections as files.** The doctor lane (section 7) makes `scripts/doctor.ts` also run the sections it finds in `v2/src/doctor/sections/`. Later lanes add a file there and never edit `doctor.ts`.
- **`v2/package.json`** and its lock file are edited by at most one lane per wave. No lane is expected to add a dependency; one that needs it says why in its pull request.
- **Real runs are labelled and quoted**, as in milestone 1: the `cleared.dev=v2` label on every Docker object, nothing bound outside `127.0.0.1`, `ss -ltn` first, the owner's Claude login never read, the raw lines pasted in the pull request with ids, paths and the organisation replaced.

## 4. The one command (`v2-j5-compose`)

Matrix: D14, B6.5. Wave 1. Effort L.

### 4.1 Context

Cleared v2 runs from a checkout with Node 24 and hand-built images, and v1's `serve/install.ts` installs systemd units that v2 does not use. D14 asks for one server, Docker Compose and one command, with the installer part of the product.

### 4.2 What exists at the end, and how it is proven

- `v2/compose.yaml`: the three containers and the build-only images of decision 2, every object labelled, the state folder mounted at its own path, the app published on `127.0.0.1` only.
- `v2/images/cleared/Dockerfile`: the image of `service`, `app` and `broker` (Node 24, git, `gh`, the Docker CLI, v2 and the kept v1 lock files), built from `node:24` as the session image is.
- `v2/src/cli/install.ts`, run by the one command: checks Docker, the port and the state folder, then starts the project and prints the address and the setup code; run again, it changes nothing that runs and prints the address.
- `v2/src/cli/cleared.ts`, the dispatcher of decision 8.
- Proven by `test/install/compose.test.ts` (the file parsed: every service, network, volume and image labelled; only the app published, on `127.0.0.1`; the socket mounted in `service` alone), `test/install/install.test.ts` (with a fake `docker`: the port refused before anything is written, a second run changes nothing), `test/cli/cleared.test.ts`, and one real run on this server under a scratch project name and a free port, quoted in the pull request, with every object it made removed by label afterwards.

### 4.3 Out of scope

Published images and a remote Compose file (question 1); Docker Desktop (question 4); TLS, a domain or a reverse proxy; upgrading an install in place, beyond running the command again.

### 4.4 Files this lane owns

`v2/compose.yaml`, `v2/images/cleared/`, `v2/src/cli/install.ts`, `v2/src/cli/cleared.ts`, `v2/test/install/`, `v2/test/cli/cleared.test.ts`, a section "Install with Docker Compose" in `v2/README.md`.

### 4.5 Real accounts and machines

None for the lane: its real run is on this server, labelled. The fresh machine is the proof's (section 16).

### 4.6 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| Which identity the `broker` container merges with: the forge token the assistant stores, or a credential of its own | this lane, with the lock's current code (`merge-pr.ts`, `serve/release-broker.ts`) |
| Whether `[security] allow_shared_uid` is still needed when the broker runs under its own user in its own container | this lane |
| How long the images take to build on a machine with no cache | this lane's real run, then the proof |

### 4.7 Delivered

Matrix line P248, pull request 410. Two decisions of section 3 changed, as the decisions log of 2026-10-25 says: nothing is published (decision 3), since the app finds the service on `127.0.0.1` and refuses any other address of its own, so the three containers share the host's network and bind `127.0.0.1` only; and the one command is `docker compose -f v2/compose.yaml run --rm install` (decision 4), since `up -d` cannot check the port first nor print the address. The broker runs under the service's account, not its own (decision 2), since the lock accepts the service's requests by its own uid.

## 5. The browser setup assistant (`v2-j5-assistant`)

Matrix: B6.5, and P249, the lane's own line, added when it delivered. Wave 1. Effort L.

### 5.1 Context

A newcomer today reads `v2/README.md`, sets the variables it lists, runs `npm run setup` and `npm run user`, and commits a public key. B6.5 asks for a setup assistant in the browser.

### 5.2 What exists at the end, and how it is proven

- The first start of decision 5: the setup code, `/setup` alone until the owner exists.
- `v2/src/setup/`: the settings file of decision 6, the steps' registry with a stub per step of section 1, and the records of each step (when it was shown, when it was done or skipped, the person's time and the machine's time).
- The steps this lane fills: the owner's account (the approval key made as `npm run setup` makes it, the public key shown with where it goes), the forge token (checked on the spot by reading the account's repositories, on its own: the forge contract of section 6 is made in the same wave, and section 11 moves the step onto it), and the model login (decision 7).
- `v2/app/web/screens/setup/`: one page per step, a progress line, each step's time, Back and Skip where a step allows it; French and English.
- Proven by `test/setup/*.test.ts` (the code, the settings file under the environment, a token never answered back, the steps' records), `app/web/test/setup/*.test.tsx`, a browser test in both languages (`app/test/setup/setup-browser.test.ts`), the catalogs' tests, and captures at the four widths, light and dark (B3.7, B4.5).

### 5.3 Out of scope

The workspace, environment, secrets, checks and first-ticket steps' contents (their lanes fill the stubs); several people at setup (one owner; others are added later in the app, as today).

### 5.4 Files this lane owns

`v2/src/setup/`, `v2/src/modules/{setup,run,secrets}.ts` (stubs; `setup.ts` filled), `v2/src/main.ts` (the three modules added, the settings file read before them), `v2/app/main.ts` (the settings file read, `/setup` alone before the owner exists), `v2/app/web/screens/setup/` (all steps as stubs, three filled), `v2/app/messages/setup*.{en,fr}.json`, the setup route in `v2/app/web/lib/routes.ts`, `v2/test/setup/`, `v2/app/test/setup/`, `v2/app/web/test/setup/`.

### 5.5 Real accounts and machines

The forge step's real check needs a GitHub token: the lane runs it once on the example repository with the `gh` login's token in a scratch file, as lane `v2-j4-mirror-doctor` did, deleted after the run. The model step's real `claude setup-token` needs the owner's subscription: the lane proves the terminal and the field with the fake harness, and the real token is the proof's.

### 5.6 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| Whether `claude setup-token` completes in the web terminal (it shows an address to open and waits for a code) | the proof's real run; the field to paste a token works without it |
| The rights a fine-grained GitHub token needs for everything Cleared does on a repository | this lane, listed on the step's page from the forge calls of section 6 |

## 6. The forge as an adapter, GitHub first (`v2-j5-forge`)

Matrix: M10 (the forge as an adapter per service), and P247, the lane's own line, added when it delivered. Wave 1. Effort M.

### 6.1 Context

M10 asks for the forge as an adapter per service, GitLab after GitHub. Today `gh` is called from four files of the service and from v1's lock.

### 6.2 What exists at the end, and how it is proven

- `v2/src/forge/contract.ts` (decision 10) and `v2/src/forge/github.ts`, the adapter over the same `gh` calls; those four files go through it; `forge` in the workspace file, `github` by default.
- `listRepositories()` for the assistant's forge and workspace steps.
- No change of behaviour: proven by the existing tests of publishing, checks, closing and approval, unchanged and green, and by `test/forge/github.test.ts` (each call's command line, with a fake `gh`) and `test/forge/contract.test.ts` (a fake forge passes the same cases, which section 11 reuses for GitLab).

### 6.3 Out of scope

GitLab (section 11); the lock's merge through the contract, which stays `gh` until section 11 needs it.

### 6.4 Files this lane owns

`v2/src/forge/`, the `gh` calls in `v2/src/workspace/publish.ts`, `v2/src/flow/effects.ts`, `v2/src/flow/pr-close.ts` and `v2/src/approval/service.ts`, the `forge` key in `v2/src/workspace/config.ts`, `v2/test/forge/`.

### 6.5 Real accounts and machines

None: the existing real runs on the example repository cover GitHub; the lane runs one publish there to show nothing changed.

## 7. `cleared doctor` (`v2-j5-doctor`)

Matrix: B6.5 (`cleared doctor`), B4.6. Wave 2. Effort M.

### 7.1 Context

`scripts/doctor.ts` was written for the lanes: by default it builds images and starts a session, and its words are English. B6.5 asks for `cleared doctor` as a product command, and the assistant needs its checks.

### 7.2 What exists at the end, and how it is proven

- A `ready` section, the default of `cleared doctor`: read only, no build, no session, no model call. Docker reachable and the label filter working; the images present; the state folder and its modes; the settings and the token files present (never printed); the forge token valid; the model token present; each service's checkout at its base; the address pool (P50); disk space. Each line passed, failed with what to do, or a notice, in French and English.
- `cleared doctor --full` runs the existing sections as today.
- `scripts/doctor.ts` also runs the files of `v2/src/doctor/sections/` (section 3.1).
- The assistant's checks step, filled from the `ready` section.
- Proven by `test/doctor/ready.test.ts` (each check against fakes, in both languages, no token in any line), `test/doctor/sections.test.ts`, `test/cli/doctor.test.ts` (exit codes), the step's browser test, and one real run on this server quoted in the pull request.

### 7.3 Out of scope

Repairing anything; a doctor page outside the assistant.

### 7.4 Files this lane owns

`v2/src/doctor/`, `v2/src/cli/doctor.ts`, the section loader in `v2/scripts/doctor.ts`, `v2/src/setup/steps/checks.ts`, `v2/app/web/screens/setup/steps/Checks.tsx`, `v2/app/messages/setup-checks.{en,fr}.json`, `v2/test/doctor/`, `v2/test/cli/doctor.test.ts`.

### 7.5 Real accounts and machines

None beyond this server and the `gh` login's token for the forge line, as in section 5.5.

### 7.6 Delivered

Matrix line P251, pull request 417. The ready section runs twelve checks, each line with a stable id that `docs/troubleshooting.md` (section 15) can name; the lane also added `v2/app/web/screens/setup/steps/checks.css`, `v2/app/web/test/setup/checks.test.tsx` and `v2/app/test/setup/checks-browser.test.ts`, and taught the assistant's browser test (`app/test/setup/setup-browser.test.ts`) that the checks step is no longer a stub. The real run found that this server has neither session image built, which the section says as a failure with the command that builds them.

## 8. `cleared run`, as a command and an API (`v2-j5-run`)

Matrix: C18, and P253, the lane's own line, added when it delivered. Wave 2. Effort M.

### 8.1 Context

C18 asks for `cleared run` as a command and an API: a ticket made and started from a terminal or a script, without the app.

### 8.2 What exists at the end, and how it is proven

- API tokens (decision 11): made, listed and revoked in the app (a panel of the person's menu), used as `authorization: Bearer`.
- `POST /api/run` (a service, a title, a description, a template; it answers the ticket's id and address) and `GET /api/run/:id` (its state, its pull request, its times), through the same ticket path as the chat (P212).
- `cleared run "<task>" [--service <id>] [--wait]`: prints the ticket's address; with `--wait`, follows the ticket and prints each state, the pull request's address and the time taken, and stops at the approval, which stays in the app.
- Proven by `test/run/*.test.ts` (a token's rights: a run made, an approval refused, a revoked token refused, the hash only in the ledger), `test/cli/run.test.ts` (against the service on loopback), the panel's component and browser tests in both languages.

### 8.3 Out of scope

Approving or merging from the command; a token per project or with narrower rights.

### 8.4 Files this lane owns

`v2/src/run/`, `v2/src/modules/run.ts`, `v2/src/cli/run.ts`, the token panel under `v2/app/web/shell/` and its catalog keys in `v2/app/messages/shell.{en,fr}.json`, `v2/package.json` (a `run` script), `v2/test/run/`, `v2/test/cli/run.test.ts`, its app tests.

### 8.5 Real accounts and machines

None: tickets run on the fake harness; a real session is the proof's.

### 8.6 Delivered

Matrix line P253, pull request 419 (issue #416). Three choices of the author, as the decisions log of 2026-10-25 says. The token routes are `/api/tokens`, beside `/api/run`, and the panel reaches them through the app's proxy, which never forwards an `authorization` header; `POST /api/run` and `GET /api/run/:id` read that header with an API token, and no other route takes one. The panel's rules are in `app/web/styles/app.css`. A run reaches the flow module's batches' runner through `batchesOf`, exported from `src/modules/flow.ts`, and the runner's `create` takes the run's service (`src/flow/batch.ts`): a second runner over the same tables could start a ticket twice. The token comes from a file of mode 600 (`CLEARED_V2_API_TOKEN_FILE`) or a variable, never from an argument, which `ps` and the shell's history would show.

## 9. Connect a workspace (`v2-j5-connect`)

Matrix: M10 (several repositories, setup sessions, links guessed and proposed), and P252, the lane's own line, added when it delivered. Wave 2. Effort L.

### 9.1 Context

A workspace of several services is a file a person writes today (`CLEARED_V2_WORKSPACE`, `examples/workspace.conf`). M10 asks that connecting one be part of the product: pick the repositories, set each up, and have the links proposed.

### 9.2 What exists at the end, and how it is proven

- The assistant's workspace step, also reachable from the Services screen: the repositories the forge token reaches, one or several picked, and for a monorepo its folders proposed as folder services (from its workspaces, or top folders with a manifest of their own).
- Each service cloned to its checkout, then the service map (P245) run on the checkouts and the links proposed (decision 15): `consumes`, `contract`, with the file and line that suggested each.
- The workspace file written to `<state>/workspace.conf` from what the person ticked, and named in the settings file.
- Proven by `test/workspace/connect.test.ts` and `test/workspace/guess.test.ts` (the two examples, guestbook and filter-api, as two repositories and as two folders of one: the filter API's call proposed as a link, nothing written before the tick), the step's component and browser tests in both languages.

### 9.3 Out of scope

The setup session per service (C4): section 13 adds it to this step. A service added or removed while tickets run; another forge than the contract's adapters.

### 9.4 Files this lane owns

`v2/src/workspace/connect.ts`, `v2/src/workspace/guess.ts`, `v2/src/setup/steps/workspace.ts`, `v2/app/web/screens/setup/steps/Workspace.tsx`, `v2/app/messages/setup-workspace.{en,fr}.json`, the Connect button of `v2/app/web/screens/services/Services.tsx` with its keys in `v2/app/messages/services.{en,fr}.json`, `v2/test/workspace/connect.test.ts`, `v2/test/workspace/guess.test.ts`.

### 9.5 Real accounts and machines

One real run listing and cloning the two example repositories with the `gh` login's token, as in section 5.5.

## 10. Prepared images, ready in seconds (`v2-j5-images`)

Matrix: C15, and P254, the lane's own line, added when it delivered. Wave 3. Effort M.

### 10.1 Context

Each session builds or pulls its image when it starts, and installs the project's dependencies inside it. C15 asks for an image ready in seconds.

### 10.2 What exists at the end, and how it is proven

- `v2/src/container/prepared.ts`: decision 13, the hash, the build after connect and after a merge that changes what the hash covers, the two newest kept.
- A session starts on the ready image, or tells its ticket it waits for one and starts when it is ready.
- The assistant's environment step shows the build and its time.
- A doctor section `images` (a file of `v2/src/doctor/sections/`): each service's prepared image, its age, and the time from a session's start to its container's first event, measured on a ready image.
- Proven by `test/container/prepared.test.ts` (with a fake `docker`: the hash, a merge that changes a lock file builds again, one that does not builds nothing, the cleanup removes only labelled images of that service), `test/container/session-runtime.test.ts` (the prepared image used, no build at start), and the doctor section's real run on this server, quoted with its times. Target: under 10 seconds from Todo to the container's first event on a ready image; the measure decides.

### 10.3 Out of scope

A shared cache between machines or a registry; the devcontainer specification beyond `image` and `build`.

### 10.4 Files this lane owns

`v2/src/container/prepared.ts`, the image choice in `v2/src/container/session-runtime.ts`, `v2/src/doctor/sections/images.ts`, `v2/src/setup/steps/environment.ts`, `v2/app/web/screens/setup/steps/Environment.tsx`, `v2/app/messages/setup-environment.{en,fr}.json`, `v2/test/container/prepared.test.ts`.

### 10.5 Real accounts and machines

None: Docker on this server, labelled.

### 10.6 Delivered

Matrix line P254 (issue #422). What the author found and chose, as the decisions log of 2026-10-25 says. Section 2 says each session builds or pulls what its `.devcontainer` names: at `3c27792` no session read it, so this lane is the first to. The install command is a new key, `[session] install_command` of the service's `.cleared/agents.conf`, one simple command. The dependencies are installed outside `/workspace`, which the checkout's mount hides, with `/node_modules` linked to them. The real run of `doctor images` was not made: this server holds no session or egress image, and building them was not done here, so C15 and P254 stay `partial` until the rehearsal measures the start.

## 11. GitLab, the second forge (`v2-j5-gitlab`)

Matrix: M10 (GitLab after GitHub). Wave 3. Effort L.

### 11.1 Context

M10 names GitLab as the first forge after GitHub. Section 6 makes the contract; this lane adds GitLab to it, and the lock's merge for a GitLab service.

### 11.2 What exists at the end, and how it is proven

- `v2/src/forge/gitlab.ts` over GitLab's REST API (merge requests, pipelines, notes, projects), a token from a file, the address configurable for a self-managed GitLab.
- The lock's merge for a GitLab service, with the same checks as for GitHub (the reviewed head, the human's approval, the health watch).
- The assistant's forge step offers GitLab, and goes through the contract for both forges.
- A doctor section `gitlab`, run only when named, as `mirror`.
- Proven by `test/forge/gitlab.test.ts` and `test/forge/contract.test.ts` (section 6's cases) against a fake GitLab on loopback, the lock's tests for a GitLab service, the step's tests.

### 11.3 Out of scope

GitLab issues as a mirror (the mirrors stay GitHub Issues and Linear); other forges.

### 11.4 Files this lane owns

`v2/src/forge/gitlab.ts`, `v2/src/doctor/sections/gitlab.ts`, the GitLab branch of the lock (`merge-pr.ts`, `release-request.ts`), the GitLab choice in `v2/src/setup/steps/forge.ts` and `v2/app/web/screens/setup/steps/Forge.tsx`, `v2/test/forge/gitlab.test.ts`, `v2/test/forge/fakes/gitlab.ts`.

### 11.5 Real accounts and machines

A real GitLab account and project: the owner's trial, as Linear's was (question 6). The lane proves GitLab against the fake only.

## 12. Test secrets in the app (`v2-j5-secrets`)

Matrix: C16. Wave 4. Effort M.

### 12.1 Context

A project whose tests need a key (a payment sandbox, a mail test server) has no place to put it today but its own files. C16 asks for test secrets managed in the app.

### 12.2 What exists at the end, and how it is proven

- `v2/src/secrets/`: decision 12; a service's secrets set, replaced and removed by a signed-in person, each change in the ledger with its name, who and when, never its value.
- The values given to the test services and the session container at start, and added to the cleaner's list.
- A Test secrets panel on the Services screen, and the assistant's secrets step: names and dates, never values.
- Proven by `test/secrets/*.test.ts` (encryption at rest, the ledger copied without its key reads nothing, a value never in an answer), `test/session/clean.test.ts` (a secret's value removed from an event, a comment and a pull request body), `test/container/session-runtime.test.ts` and `test/container/services.test.ts` (the variables given), the panel's and the step's tests in both languages.

### 12.3 Out of scope

Production secrets; a vault or a cloud secret manager; secrets per ticket.

### 12.4 Files this lane owns

`v2/src/secrets/`, `v2/src/modules/secrets.ts`, the secrets' variables in `v2/src/container/session-runtime.ts` and `v2/src/container/services.ts`, the secrets' list in `v2/src/session/clean.ts`, `v2/src/setup/steps/secrets.ts`, `v2/app/web/screens/setup/steps/Secrets.tsx`, `v2/app/messages/setup-secrets.{en,fr}.json`, the Test secrets panel under `v2/app/web/screens/services/` and its keys, `v2/test/secrets/`.

### 12.5 Real accounts and machines

None.

## 13. The setup session (`v2-j5-env-setup`)

Matrix: C4, M10 (setup sessions). Wave 4. Effort M.

### 13.1 Context

A repository with no `.devcontainer` runs in Cleared's base image, where its tests may not run. C4 asks for a session that sets the environment up; M10 asks for one per connected service.

### 13.2 What exists at the end, and how it is proven

- A ticket template "Prepare the environment" (decision 14), proposed by the assistant's environment step and the workspace step for a service with no `.devcontainer`, or whose checks fail in its image.
- Before the reviewer, the flow builds the branch's image with section 10's builder and runs the declared checks inside it; a failure goes back to the author, with the output cleaned and cut.
- After the merge, the prepared image is built again.
- Proven by `test/flow/env-setup.test.ts` (with the fake harness and a fake `docker`: the image built from the branch, a failed check sent back, a green one reviewed), the template's test, the steps' tests, and one real run on this server on a copy of the guestbook without its `.devcontainer`, quoted in the pull request.

### 13.3 Out of scope

Devcontainer features and lifecycle commands; a project with no declared check (the session is told so and stops at a working image).

### 13.4 Files this lane owns

`v2/src/flow/env-setup.ts`, the template in `v2/src/tickets/templates.ts` and its catalog keys, the setup session's proposal in `v2/src/setup/steps/environment.ts`, `v2/src/setup/steps/workspace.ts` and their two screens, `v2/test/flow/env-setup.test.ts`.

### 13.5 Real accounts and machines

The real run needs a Claude Code login for the author session: the service's own token on this server, as the earlier real runs used, never the owner's personal login file.

## 14. The first ticket (`v2-j5-first-ticket`)

Matrix: B6.5, B6.5p (steps 9 and 10). Wave 4. Effort S.

### 14.1 Context

The assistant ends on a live change. The newcomer needs a first ticket that is small, safe and visible.

### 14.2 What exists at the end, and how it is proven

- The assistant's last step: a first ticket, kept in the step's own file rather than in the tower's templates, that changes one visible line of the project (a heading, a README line), proposed with the service it targets; moved to Todo with one click; the step follows the ticket to live and shows the total time of the setup.
- The assistant's summary: each step's time, the person's and the machine's, and the total.
- Proven by `test/setup/first-ticket.test.ts` (on the fake harness, to the approval), the step's component and browser tests in both languages.

### 14.3 Out of scope

Choosing a ticket for the person beyond the template; skipping the review or the approval for a first ticket.

### 14.4 Files this lane owns

`v2/src/setup/steps/first-ticket.ts`, `v2/src/setup/summary.ts`, `v2/app/web/screens/setup/steps/FirstTicket.tsx`, `v2/app/messages/setup-first-ticket.{en,fr}.json`, `v2/test/setup/first-ticket.test.ts`.

### 14.5 Real accounts and machines

None: the real first ticket is the proof's.

## 15. The README and the documentation (`v2-j5-docs`)

Matrix: B6.5 (README and documentation). Wave 5. Effort M.

### 15.1 Context

The root `README.md` still describes v1 (systemd, Tailscale, Orca terminals, v1's lanes) and sends the reader to `v2/README.md` to start anything. B6.5 asks for a README and documentation a newcomer follows.

### 15.2 What exists at the end, and how it is proven

- The root `README.md` rewritten for v2: what Cleared is, the one command, the assistant, what it needs (section 3, decision 1), where to read more.
- `docs/install.md`: the one command, the assistant step by step with captures, reaching the machine from elsewhere over SSH, updating, stopping, and removing everything by label.
- `docs/troubleshooting.md`: each red line of `cleared doctor` and what to do.
- `docs/run.md`: `cleared run` and the API.
- Proven by `test/docs.test.ts`, extended: each page exists, names the files and commands it documents, and has no em dash; the wording test over the new catalogs.

### 15.3 Out of scope

A website; translating the documentation pages (the app is translated, the pages are English, as today).

### 15.4 Files this lane owns

`README.md`, `docs/install.md`, `docs/troubleshooting.md`, `docs/run.md`, `v2/README.md` (the sections that point to them), `v2/test/docs.test.ts`.

### 15.5 Real accounts and machines

None.

## 16. The proof (`v2-j5-proof`)

Matrix: B6.5p. Wave 5. Effort M.

### 16.1 Context

Section 1's steps, run end to end.

### 16.2 What exists at the end, and how it is proven

- `v2/scripts/proof-j5.ts`: the rehearsal. On this server, under a scratch Compose project name and a free port, every object labelled: the one command, then Playwright through the assistant with a fake GitHub and the fake harness, to the first ticket's approval and a fake live; each step's time; the report as `proof-report.ts` writes the others; everything it made removed by label at the end.
- The real run's sheet: what the person is given (the address of the repository, nothing else), what is recorded (the assistant's own times, the screen if they agree), and what counts as a pass.
- Proven by `test/scripts/proof-j5.test.ts` (the pure parts: the steps, the report, the cleanup's filter) and the rehearsal run, quoted in the pull request.

### 16.3 Out of scope

The real run itself (question 5).

### 16.4 Files this lane owns

`v2/scripts/proof-j5.ts`, `v2/test/scripts/proof-j5.test.ts`, `docs/v2/proof-j5.md`.

### 16.5 Real accounts and machines

The rehearsal needs none. The real run needs a fresh Linux machine with Docker, a person who does not know Cleared, a GitHub account and a Claude subscription: the owner's.

## 17. Waves

At most three lanes run at once (B4.3), and lanes of one wave never edit the same file.

| Wave | Lanes | Needs before it starts |
| --- | --- | --- |
| 1 | `v2-j5-compose`, `v2-j5-assistant`, `v2-j5-forge` | this plan merged. The three lanes touch no file of each other: the assistant's forge step checks the token on its own, `v2-j5-connect` (wave 2) is the first to call `listRepositories()`, and `v2-j5-gitlab` (wave 3) moves the forge step onto the contract; `install.ts` shows the service's log line that holds the setup code, whatever the assistant lane writes in it |
| 2 | `v2-j5-doctor`, `v2-j5-run`, `v2-j5-connect` | wave 1 merged (the step stubs, the modules, the forge contract) |
| 3 | `v2-j5-images`, `v2-j5-gitlab` | wave 2 merged (the doctor's sections folder, the workspace step) |
| 4 | `v2-j5-secrets`, `v2-j5-env-setup`, `v2-j5-first-ticket` | wave 3 merged (the prepared images' builder) |
| 5 | `v2-j5-docs`, `v2-j5-proof` | wave 4 merged |

Files edited by lanes of different waves only: `v2/src/setup/steps/environment.ts` and its screen (waves 3 and 4), `v2/src/setup/steps/workspace.ts` and its screen (waves 2 and 4), `v2/src/setup/steps/forge.ts` and its screen (waves 1 and 3), `v2/src/container/session-runtime.ts` (waves 3 and 4), `v2/scripts/doctor.ts` (wave 2 only), `v2/README.md` (waves 1 and 5), `v2/package.json` (wave 2 only).

After wave 5: the rehearsal by the orchestrator, fix lanes for what it finds, then the real run (question 5). Then rule 2 of the matrix, line by line, before `v2` goes to `main`.

Outside the waves: `v2-j5-vapid-flaky` (issue #411, pull request 413, matrix line P250) made the VAPID key test of `test/notify.test.ts` deterministic after it failed once in pull request 410's CI. It edits that test alone, no file of a wave's lane.

## 18. What needs real accounts or a fresh machine

| What | Needs | Whose |
| --- | --- | --- |
| B6.5p, the real run | a fresh Linux machine with Docker, a newcomer, a GitHub account, a Claude subscription | the owner (question 5) |
| The model step with a real `claude setup-token` | a Claude subscription | the proof's real run |
| GitLab for real (section 11) | a GitLab account and project | the owner (question 6) |
| Published images and a remote Compose file | a registry and the owner's agreement to publish | not taken: the owner chose (a) on 2026-10-25 at 19:33, nothing published (question 1) |
| The forge and workspace steps, GitHub for real | the `gh` login's token, read into a scratch file and deleted | each lane, on the example repositories |
| Docker real runs (compose, images, doctor, setup session) | Docker on this server, every object labelled `cleared.dev=v2` | each lane |

## 19. Questions for the owner

Grouped, each with options and a recommendation. A default is applied where the action stays inside this repository; publishing and a real person's run have none.

1. **The one command.** (a) `git clone`, then `docker compose -f v2/compose.yaml up -d`, images built on the machine; (b) images published on the GitHub registry of the organisation this repository lives in, and a Compose file fetched from it, so the command is `docker compose -f oci://ghcr.io/<org>/cleared:<version> up -d` and nothing is built; (c) a small installer image, published the same way, that writes the Compose file and starts it. Recommended: (b), since a build on a fresh machine eats into the hour. The lanes build (a) first, which (b) packages. No default for (b) or (c): publishing is outward facing. **Answered by the owner on 2026-10-25 at 19:33, relayed by the lead: (a).** The install is `git clone`, then Docker Compose, with the images built on the machine; nothing is published to any registry ([decisions log](decisions-log.md), 2026-10-25).
2. **What "live" means for the newcomer's first ticket.** (a) merged on the base branch by the lock and the project's health address green through the watch window, when the project declares one, else merged; (b) a starter repository with a deploy to GitHub Pages, published from a template in the organisation, so live is a page the newcomer opens. Recommended: (a) for any project, with (b) offered to a newcomer with no project of their own. Default: (a). (b) waits: a template repository is outward facing.
3. **The model's login for a newcomer.** (a) a Claude subscription through `claude setup-token`, as today; (b) an API key, billed per token; (c) both offered, (a) first. Recommended: (c), since a newcomer may have only one. Default: (c). Milestone 1's open point stays: whether a self-hosted tool where the owner signs in with their own subscription is allowed is not settled.
4. **The newcomer's machine.** (a) Linux with Docker Engine only, as decision 1 says; (b) also macOS with Docker Desktop, which needs the state folder's paths and the egress checked there and a Mac to run on. Recommended: (a) for milestone 5, (b) named for later. Default: (a).
5. **The real run of the proof.** (a) the owner finds a developer who does not know Cleared and a fresh machine, and the orchestrator reads the times; (b) as a stand-in, a fresh virtual machine and a session of another model given only the assistant's address. Recommended: (a) for B6.5p, (b) as a second rehearsal. No default: it needs a person, accounts and a machine.
6. **GitLab.** (a) against a fake in milestone 5, the real trial the owner's, as Linear's; (b) GitLab moved after milestone 5. Recommended: (a). Default: (a).

## 20. Out of scope for milestone 5

Docker Desktop and macOS or Windows (question 4); Kubernetes or several servers; TLS, a domain or a public address; published images and a registry (question 1, answered (a): nothing published); forges other than GitHub and GitLab; production secrets; the full devcontainer specification; billing, plans or several organisations; the real runs that need the owner's accounts (section 18).

## 21. Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| The hour's split: how long the image builds, the clone and the first session take on a fresh machine | the rehearsal (section 16), then the real run |
| Whether the egress's isolated gateway mode holds inside Compose with the socket of the host | `v2-j5-compose`'s real run, with `doctor docker` |
| The broker's identity and `allow_shared_uid` in a container | `v2-j5-compose` (section 4.6) |
| Whether `claude setup-token` completes in the web terminal | the proof's real run (section 5.6) |
| The time from Todo to a session's first event on a prepared image | `v2-j5-images`'s doctor section |
| The fine-grained token's rights | `v2-j5-assistant` (section 5.6) |
| The GitLab API's merge with the same checks as the lock's GitHub path | `v2-j5-gitlab`, against its fake, then the owner's trial |
