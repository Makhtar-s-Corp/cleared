# The multi-service proof's clean base

Every run of the multi-service proof (`v2/scripts/proof-j2-multi.ts`) starts from the same commits, recreated automatically, and nothing is ever pushed to the `main` branch of a proof repository. Since the owner's approval of 2026-10-23 at 11:24 (the LOCAL-20 reverts, in [decisions-log-milestone-2.md](decisions-log-milestone-2.md)), that push was the last one to `main`.

## How it works

Each proof repository (the guestbook's and the filter API's) has two branches besides `main`:

- **`proof-base`**, the frozen base: the commit every run starts from. A run only ever reads it.
- **`proof-run`**, the run branch, recreated from `proof-base` at the start of every run. The tickets of the run merge into it, its rollbacks revert on it, and the deploy watchers deploy it.

The service's workspace (`base`), each release broker's machine settings (`[lanes] base`) and each deploy watcher (`--branch`) name `proof-run`. `main` is in none of them.

Before its first ticket, a real run checks its setup, then does four things, in this order (`v2/scripts/proof-base.ts`).

**The start check** (issue #277) stops the run with code 64 and says why when:
- a service's base in the workspace is not `proof-run` (the guards below);
- no workflow of a repository's `proof-base` runs on both a push and a pull request to `proof-run`. The reader knows `on:` as a list, or as events filtered on `branches` and `branches-ignore`; an event filtered on anything else (paths, tags, types) does not count. Without such a workflow, the release card waits for checks that never come;
- a deploy watcher of one of the run's services deploys another branch (its `--branch`, `main` by default), a service has no watcher, or the service of a running watcher cannot be read. The watchers are read from `/proc` on the machine the proof runs on: each `deploy/watch.ts` process, and the `cleared.example` label its script sets.

The four things:


1. **The earlier runs' tickets are set aside.** A ticket with one of the proof's four titles that is not Done, and is not in Todo, or has a live session, or has anything waiting in the inbox, gets `POST /api/tickets/:id/set-aside`. Its sessions stop, everything of it that waits is settled, a train not yet approved is halted, and it goes back to Todo without starting again. The proof then reads the API again. If one of those tickets is still open, the run stops before ticket 1 and says which one.
2. **The open pull requests into `proof-run` are closed** (`gh pr list --base proof-run`, then `gh pr close` for each). They were opened against a run branch that is about to be recreated. Pull requests into any other branch are left alone.
3. **Each `proof-run` is recreated** at the commit of `proof-base`, with one push that names its target in full: `git push --force origin <commit>:refs/heads/proof-run`. Nothing else is pushed.
4. **The run waits for the deploys.** Each watcher must run an app container labelled with that commit (`cleared.commit`), and each service's `health_url` must answer, within `PROOF_DEPLOY_MINUTES` (10 by default).

### The guards

The guards fail closed. The run refuses to recreate the run branch, and stops, when:

- it does not start with `proof-` (`proof-run`, `proof-run-2`), or it is named `main` or `master`;
- it is the repository's default branch, as `git ls-remote --symref origin HEAD` says, or that default branch cannot be read;
- it has the same name as the frozen branch;
- the workspace names `main` or `master` as the base of any service;
- the workspace does not name it as every service's base (`GET /api/workspace`);
- a service of the workspace has no clone in `PROOF_REPOS`.

A real run also refuses to start without `PROOF_REPOS`: it would merge into whatever the workspace names. `PROOF_REPOS=none` is accepted by the rehearsal only, where it skips the reset of its own bare copies.

It also refuses a frozen commit that already holds a change one of the proof's tickets asks for:

- `severity` or `positions` in the filter API's `contract/openapi.yaml`;
- `casino` in its `words.txt`;
- `PROOF_BREAK_HEALTH` turned on in the guestbook's `src/config.ts`;
- `severity` read in the guestbook's `src/filter.ts`.

A contract diff that is empty never creates the inbox item that step 3 waits for.

### A clean state

An earlier run's ticket is clean when all of the following hold:

- it is in Todo or Done;
- no session of it is live;
- nothing of it waits in the inbox: no permission, question, session plan, release card, contract or knowledge item;
- it has no train that is waiting or blocked.

The proof checks this before every run. The ops requests called it "no open items left".

## Setting it up, once

Do this on the machine that runs the proof, with the owner's agreement. Every name below is a placeholder.

1. **Choose the frozen commit** in each proof repository: the head of `main` after the reverts of 2026-10-23 11:24, or another commit the owner names. Check that it holds none of the changes listed under the guards.
2. **Create the two branches** from a clone that can push:

   ```
   git -C <clone> fetch origin
   git -C <clone> push origin <frozen commit>:refs/heads/proof-base
   git -C <clone> push origin <frozen commit>:refs/heads/proof-run
   ```

   Neither command writes `main`.
3. **Protect `proof-base`** on the forge (no force push, no deletion). Leave **`proof-run` open to force pushes**: each run recreates it. If a rule refuses the force push, the run stops at step 3 and says so.
4. **The workspace file** (`CLEARED_V2_WORKSPACE`): set `base = proof-run` in each service's section.
5. **Each release broker's machine settings**: set `[lanes] base = origin/proof-run`. `merge-pr.sh` refuses a pull request into any other branch, and a rollback pushes its revert to that base.
6. **Each deploy watcher**: restart it with `--branch proof-run`, for example `node deploy/watch.ts --repo <clone> --branch proof-run`. The app containers keep running while it restarts.
7. **Restart the service.** At start, it stops what the last process left, puts those tickets back in Todo, and releases the stopped sessions' containers and networks. It does not wait for a request.
8. **The proof's settings**, beside its usual ones:

   | Variable | Value |
   | --- | --- |
   | `PROOF_REPOS` | `guestbook=<absolute path of a clone of the guestbook repository>,filter-api=<absolute path of a clone of the filter API repository>`: clones that can push `proof-run` and where `gh` is signed in. Required by a real run |
   | `PROOF_REMOTE` | the clones' remote, `origin` by default |
   | `PROOF_BASE_BRANCH` | `proof-base` by default |
   | `PROOF_RUN_BRANCH` | `proof-run` by default; always `proof-<something>` |
   | `PROOF_DEPLOY_MINUTES` | how long the watchers have to deploy the base, 10 by default |
   | `PROOF_REVIEW_ROUNDS` | how many reviews a ticket may go through before the proof gives up, 3 by default (2 before the review channel of issue #291). The service has its own limit, `CLEARED_V2_REVIEW_ROUNDS`, 3 by default as well, and the proof does not read it: set both to the same value, because the lower one ends the review first. The same reviewer session gives its verdicts round after round, so the proof follows the latest reviewer session and each round is a verdict, not a session |

   Without `PROOF_REPOS`, a real run stops before it signs in.

To move the frozen base later, push a new commit to `proof-base` after a written decision. That push is never to `main`.

## What it does not touch

- No volume. The guestbook's database volume keeps the `held` and `held_words` columns of LOCAL-11, with their defaults. A migration in ticket 1 that is not idempotent would turn `/health` red and roll back step 7. Read that from the run's report; it is not a fault of the base.
- The demo's ports, 8796 to 8799, and its containers. The proof's ports are 8791 to 8795.
- Earlier runs' release rows. After a reset, their merge commits are no longer on `proof-run`. A rollback then refuses to act, because the base changed after that release (`lib/release.mjs`).
- Their branches: a closed pull request's head branch stays on the forge.

## The rehearsal

`PROOF_REHEARSAL=1` exercises the same path on bare copies in a temporary folder (`PROOF_REPOS` unset; `PROOF_REPOS=none` skips the reset there). Each copy has a `proof-base` and a `proof-run` that an earlier run moved on. The workspace and the two stand-in brokers name `proof-run`. The proof recreates the run branch before its first ticket. It closes no pull request, because the forge stand-in has none from an earlier run, and waits for no watcher.
