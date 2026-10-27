# Milestone 5 proof: the real run's sheet

B6.5p: on a fresh machine with Docker, a developer who does not know Cleared installs it and takes a first ticket to live in under an hour, following the assistant only. The ten measured steps are in [milestone-5-plan.md](milestone-5-plan.md), section 1. This sheet is for the real run, which is the owner's (question 5 of the plan). The rehearsal on this server (`v2/scripts/proof-j5.ts`, at the end of this page) proves the path, not the hour.

## Before the run

- **The machine**: Linux with Docker Engine and git, nothing else of Cleared on it (question 4 of the plan: no macOS or Windows in milestone 5). Free disk: 20 GB. Network to GitHub, to Docker's package mirror and to npm, since the one command builds the images on the machine (question 1, answered (a)).
- **The accounts**, the newcomer's own: a GitHub account with a repository it may push to, and a Claude subscription for `claude setup-token`.
- **The newcomer** has never used Cleared and has not read its code or its documents.
- **The observer** (the owner, or the person the owner names) prepares nothing on the machine, and does not help during the run. A question the newcomer asks is written down with its time, and answered only with "follow the assistant".

## What the newcomer is given

The address of this repository on GitHub. Nothing else: no command, no settings, no token, no walkthrough.

## What is recorded

- **The assistant's own times.** Its last page shows each step's time, the person's and the machine's, and the total (`src/setup/summary.ts`). The observer copies that table, or saves the answer of `GET /api/setup` from the signed-in browser.
- **The one command's time**, which the command prints at its end, from its start to the app's first answer (step 1).
- **The time from the repository's page to the one command's start**, by the observer's clock: reading the README is part of the hour.
- **Every command typed on the machine after the one command**, and **every file edited by hand**, by the observer, with its time and why.
- **Every question the newcomer asked**, and where they hesitated, with its time.
- **The screen**, only if the newcomer agrees, recorded on the newcomer's machine and kept by the owner. Nothing of the screen or of the notes is committed to this repository; a summary in the proof's pull request names no person and no organisation, and gives no token, path or address of the machine.

## What counts as a pass

All of these:

1. The total, from the repository's page to live, is under 60 minutes.
2. No command was typed after the one command, and no file was edited by hand.
3. The first ticket is live: merged on the base branch by the lock, and the project's health address green through the watch window when the project declares one, else merged (question 2 of the plan, (a)).
4. Every step of the assistant is done, or skipped where the step allows it (the test secrets, the checks), and a skipped step is said in the report.

A run that stops on a defect of Cleared is a failed run: the defect becomes an issue, and the run is made again after its fix, with another newcomer.

## Known before the real run

What the code or the rehearsal shows will stop a real run, each to be closed before it:

- **The lock under Compose** (issue #438): the Compose broker idles until `CLEARED_V2_PROJECT_DIR` names a checkout, and the assistant gives it none. Step 10 waits for a lock that does not run. The rehearsal replaces the lock with a stand-in, so it does not prove step 10 under Compose.
- **The lock's key** (question 1 of lane `v2-j5-first-ticket`, default (c) applied): v1's lock reads `human_public_key` from the project's `.cleared/agents.conf` only. Under that default the newcomer must add the line by hand, which fails pass 2. Options (a) or (b) of that question close it.
- **The release request on an install by the assistant** (issue #445): the approval of a single service reads the project's verdict phrase and the pull request's head through `CLEARED_CONF` and `CLEARED_REPO` only, which such an install does not set. The first ticket goes back to Todo after its review, so step 9 cannot pass. Found by the rehearsal, which gives the service both as a stand-in.
- **The session plan's Go** (issue #446): the first ticket's author proposes a session plan that waits for its Go in the inbox, and the first-ticket step does not say so. A newcomer who follows the step alone waits 10 minutes of the hour for the delay's Go. Found by the rehearsal, which gives the Go from the inbox.
- **`claude setup-token` in the web terminal** (section 5.6 of the plan): not yet run with a real subscription. The rehearsal pastes a made-up value.

## After the run

Everything of the run is removed by the label, as [install.md](../install.md#removing-everything) says, then the state folder. The newcomer revokes the GitHub token and the Claude login made for the run.

## The rehearsal

```
cd v2
CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core CLEARED_V2_CHROME=/usr/bin/google-chrome \
  node scripts/proof-j5.ts --language en --report /tmp/proof-j5.md
```

On this server, under a scratch Compose project (`cleared-v2-proof-<8 hex>`) and three free ports of 9700 to 9799 on `127.0.0.1`, every Docker object labelled `cleared.dev=v2`. It builds Cleared's image from the clone, runs the one command as the README gives it, recreates the service once with its fakes (a fake GitHub on loopback, a `gh` stand-in on the service's `PATH`, a bare copy of the example guestbook as the remote, the fake harness, a stand-in lock, and the project's settings and checkout for the approval, issue #445), then walks the assistant in a headless browser to the first ticket's approval in the inbox and its live. The report, written outside the repository, has each step's time from the assistant's records and says what the rehearsal replaced. At the end it removes what it made: the scratch project's objects and what the service made with the label since it began, never an object that was there before.

Before its build, when the machine already holds an image under the tag `cleared-v2:local` (another install's), the rehearsal gives that image a second labelled name, `cleared-v2-proof-keep:<8 hex>`, and puts the tag back on it at the end: under Docker's containerd image store, an image whose only tag moves to another is gone as an image, even while containers run on it.

Its pure parts are tested by `v2/test/scripts/proof-j5.test.ts`: the ten steps, the ports, the fakes, the times, the report, and the cleanup's filter.
