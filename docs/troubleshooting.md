# Troubleshooting

`cleared doctor` says whether an install of Cleared is ready for a first ticket. This page takes each line it can print that is not green, in the order it prints them, and says what to do.

## Running the checks

The setup assistant's Checks step (step 7 of [the install](install.md#7-checks)) runs them and shows each line green, or red with what to do. Nothing to type.

From a terminal on the machine, the same checks:

```sh
# From a clone, with Node.js 24 (as for an install made by hand):
node v2/src/cli/cleared.ts doctor

# On a Compose install, with the variables the install was given
# (the command the Checks step names):
docker compose -f v2/compose.yaml run --rm --no-deps service cleared doctor
```

The checks are read only: Docker is asked its version and its lists filtered on `cleared.dev=v2`, GitHub is read with the saved token, git reads each checkout without fetching. Nothing is built or started, no session runs, no model is called, and no token is ever printed. The code is `v2/src/doctor/ready.ts`; its words are `v2/src/doctor/messages/ready.en.json` and `ready.fr.json`, in the language of `CLEARED_V2_APP_LANGUAGE` (French by default).

Each line starts with a mark:

| Mark | Meaning |
| --- | --- |
| `ok` | The check passed. |
| `failed` | The check failed. What to do is on the next line. |
| `note` | Worth knowing; nothing stops a first ticket. |
| `not run` | A check above it failed, and this one needs it. Fix that one first. |

The last line counts the failures. The command exits 0 when no check failed, 1 when one did, and 64 for an argument it does not know. `cleared doctor --full` runs the older, longer sections of `v2/scripts/doctor.ts` instead: they build the images and start a session, so they are for people working on Cleared, not for a first install.

On this page, the quoted lines are the English words, with `{path}`, `{reason}` and the other values in braces where the doctor puts the real ones.

## The checks

### `docker`: Docker answers

- **failed:** Docker does not answer: {reason}
- **What to do:** Start Docker, and run Cleared under an account of the docker group.

The reason is Docker's own first line. "permission denied" on `/var/run/docker.sock` means the account is not in the `docker` group yet: add it, then open a new session for the group to apply. "Cannot connect to the Docker daemon" means Docker Engine is stopped or not installed. While Docker does not answer, the next three checks say "not run".

### `labels`: Docker honours the label filter

Cleared acts only on what Docker lists under the label `cleared.dev=v2`, so it first checks that Docker's filter works.

- **failed:** Docker listed a container without the label cleared.dev=v2: its filters cannot be trusted, and Cleared acts only on what it lists by that label.
- **failed:** Docker refused the labelled list: {reason}
- **What to do:** Update Docker Engine, then run the doctor again.

Until the filter is trusted, the images and the address pool are not checked: a list that ignores the filter would name containers and networks that are not Cleared's.

### `images`: the session and egress images are there

Each session runs in the session image, behind the egress image's proxy. The install builds both.

- **failed:** Missing images: {images}.
- **failed:** Docker refused the list of images: {reason}
- **What to do:** Run the install again from the clone: docker compose -f v2/compose.yaml run --rm install. It builds what is missing.

The first build takes several minutes and a few gigabytes. Running the install again changes nothing that already runs; it builds the missing images only.

### `pool`: Docker has free subnets for a session

Each session takes two Docker networks: one with no way out, and one for its proxy. Each needs a subnet from Docker's address pools.

- **failed:** {free} free subnets in Docker's address pools; a session takes two.
- **failed:** Docker refused the list of labelled networks: {reason}
- **What to do:** Stop the sessions you no longer need, or widen default-address-pools in /etc/docker/daemon.json and restart Docker.

Restarting Docker stops every container of the machine, Cleared's and others'. A stopped session's networks are not always freed yet (issue #265): `docker network ls --filter label=cleared.dev=v2` lists Cleared's, and a network of a session that no longer runs can be removed with `docker network rm`.

### `state`: the state folder

The state folder (`/var/lib/cleared-v2` by default, `CLEARED_V2_STATE_DIR` at install) holds the ledger, the keys, the tokens the assistant saved and each ticket's checkout. It must belong to the account Cleared runs as, and no other account may write in it.

- **failed:** No state folder is set.
- **What to do:** Set CLEARED_STATE_DIR, or install with docker compose -f v2/compose.yaml run --rm install, which sets it.

- **failed:** There is no state folder at {path}.
- **failed:** {path} is not a folder.
- **What to do:** Run the install from the clone: docker compose -f v2/compose.yaml run --rm install. It makes the folder.

- **failed:** The state folder {path} belongs to another account (uid {owner}), and Cleared runs as uid {uid}.
- **What to do:** Run Cleared as the folder's account, or run the install again, which gives the folder to the clone's owner.

- **failed:** Other accounts may write in the state folder {path} (mode {mode}).
- **What to do:** Run chmod go-w {path}.

- **note:** Other accounts can read the state folder {path} (mode {mode}); the install makes it 700.
- **What to do:** Run chmod 700 {path}.

Until the state folder passes, the disk and the settings are not checked.

### `disk`: free space on the state folder's disk

- **failed:** {free} free on the state folder's disk: too little to build the images.
- **failed:** The free space of the state folder's disk could not be read: {reason}
- **note:** {free} free on the state folder's disk; the images and each ticket's checkout take several gigabytes.
- **What to do:** Free some space on that disk: Cleared needs 5 GB at least, 20 GB to work in comfort.

Under 5 GB is a failure, under 20 GB a note. `docker system df` shows what Docker's images and containers take; remove only what you know is not needed.

### `settings`: the settings file

The setup assistant writes the settings it collects in `settings.conf` in the state folder, mode 600. A variable set in Cleared's environment wins over the file, so an install made by hand keeps working without one.

- **note:** No settings file at {path}: the settings come from the environment, as for an install made by hand.
- **What to do:** The setup assistant writes it; nothing to do if you set the variables yourself.

- **failed:** The settings file {path} is a link: Cleared does not follow it.
- **What to do:** Replace the link by the file itself, mode 600.

- **note:** Other accounts can read the settings file {path} (mode {mode}).
- **What to do:** Run chmod 600 {path}.

### `credentials`: the token files the settings name

A token is never in the settings file: each one is a file of its own in the state folder, mode 600, which the settings name. The doctor looks at each file (its kind, owner, mode and size) and never opens it.

- **failed:** The file the settings name for {name} is a link, another account's, readable by others, or empty: {path}. Cleared does not set {name} from it.
- **What to do:** Save it again in the setup assistant, or run chmod 600 {path} if it is this account's file.

### `model`: the Claude Code login

Sessions run Claude Code with the login the assistant's Claude Code step saved (`claude.token` in the state folder, or the file `CLEARED_CLAUDE_CREDENTIALS` names). The doctor looks at the file and never reads it.

- **failed:** No Claude Code login at {path}.
- **failed:** The Claude Code login at {path} is empty.
- **failed:** The Claude Code login {path} is not a file.
- **What to do:** Open the setup assistant's model step and paste what claude setup-token prints.

- **note:** The Claude Code login {path} belongs to another account (uid {owner}).
- **What to do:** Save it again in the setup assistant, so that it is this account's file.

- **note:** Other accounts can read the Claude Code login {path} (mode {mode}).
- **What to do:** Run chmod 600 {path}.

The doctor does not call the model, so a login that is there but expired passes this check; only a session finds that out.

### `forge`: the GitHub token

The doctor asks GitHub which account the saved token is for (`GET /user`). The token travels in the request's header only and is removed from every line before it is printed.

- **failed:** No GitHub token: neither GH_TOKEN nor GITHUB_TOKEN is set.
- **What to do:** Open the setup assistant's forge step and save a token.

- **failed:** The GitHub address is refused: {reason}
- **What to do:** Unset CLEARED_V2_FORGE_GITHUB_API, or give an address on loopback.

- **failed:** GitHub refuses the token (401): it is wrong, expired or revoked.
- **What to do:** Make a new one on GitHub and save it in the setup assistant's forge step.

- **failed:** GitHub forbids the request (403): the token lacks a right, or GitHub's rate limit is reached.
- **What to do:** Check its rights against the list of the forge step, or try again in an hour.

- **failed:** GitHub did not answer within {limit} at {api}.
- **What to do:** Check that this machine reaches {api}, then run the doctor again.

- **failed:** GitHub answered {status} to the token's check.
- **What to do:** Run the doctor again in a few minutes; GitHub's status page says whether it is down.

The rights a fine-grained token needs are listed on the Forge step: Metadata, Contents, Pull requests and Commit statuses, with Workflows and Issues only when you need them. A token of an organisation may wait for an administrator's approval before it reaches anything. A GitLab install is not checked by this section yet (issue #424): `cleared doctor --full gitlab` runs GitLab's own section.

### `repository`: each connected repository

For each repository of the workspace, the doctor asks GitHub whether the token reaches it and may push there.

- **failed:** {repo} is not reached: the token does not see it (404).
- **What to do:** Add {repo} to the token's repositories on GitHub, or fix repo in the workspace file.

- **failed:** GitHub refused to show {repo} ({status}).
- **What to do:** Check the token's rights on {repo} against the list of the forge step.

- **failed:** {repo} is reached, read only: Cleared pushes branches and opens pull requests there.
- **What to do:** Give the token Contents and Pull requests, read and write, on {repo}.

- **failed:** GitHub did not answer about {repo} within {limit}.
- **What to do:** Run the doctor again; check that this machine reaches {api}.

- **note:** {repo} is reached; GitHub did not say what the token may do there.

A fine-grained token's repositories are changed on GitHub, on the token's own page; the token's value stays the same, so nothing is saved again in Cleared. This check says "not run" until a workspace exists and the `forge` check passes.

### `checkout`: the workspace and each service's checkout

The workspace is the list of connected repositories, written by the assistant's Repositories step. Each service gets a clone of its repository in the state folder.

- **failed:** The workspace's settings are refused: {reason}
- **What to do:** Fix the workspace file CLEARED_V2_WORKSPACE names, or the CLEARED_V2_* settings it repeats.

- **note:** No workspace yet: no repository is connected.
- **What to do:** The setup assistant's workspace step connects one.

- **note:** {service} has no checkout at {dir} yet; the first ticket clones it.

- **failed:** {dir} is there, and is not a git checkout.
- **What to do:** Move that folder away; the first ticket clones {service} there.

- **failed:** {dir} is a clone of another repository than {url}.
- **What to do:** Fix url in the workspace file, or move that folder away so that the first ticket clones {service} there.

- **failed:** The checkout of {service} at {dir} has no origin/{base}.
- **What to do:** Check base in the workspace file; the next ticket fetches the checkout.

"Move that folder away" means renaming it, not deleting it: it may hold work that is not anywhere else.

## Known gaps of a Compose install

These are open issues, not mistakes in the install. The doctor does not check them yet.

- The release lock reads the owner's public key from the project's `.cleared/agents.conf` only (`[tracker] human_public_key`), so on a Compose install an approved first ticket is not merged until that line is there. The `broker` container gets its project from the workspace the assistant writes; until a repository is connected, its log says it waits.
- A repository connected after the first ones is used after a restart of the service, and the release trains of several repositories need a release lock each, which the Compose file does not run: [What needs a restart](install.md#what-needs-a-restart) lists both, with the command.
- A session's container that stops is recreated for Claude Code sessions only, at most three times; a Codex or Cursor session's ticket goes back to Todo, and a restart of the service stops every session (issue #58). [adapters.md](adapters.md#a-sessions-container-that-stops-issue-453) says how.
- With no GitHub App, the release lock's own git (the `broker` container) has no credential helper for `GH_TOKEN`, so its fetches and pushes of a private repository are refused; the service's git has one (issue #421).

When the install command itself stops before Cleared starts, it says why and that nothing was written: [install.md](install.md#when-the-command-stops) lists its refusals.
