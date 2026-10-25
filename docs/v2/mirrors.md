# Cleared v2: the GitHub Issues and Linear mirrors

The app holds the tickets. A mirror keeps a copy of them on GitHub Issues, on Linear, or on both, and brings back what people change there. With no mirror set up, the app alone is enough (D17). The code is `v2/src/tickets/mirror.ts`, `mirror-github.ts` and `mirror-linear.ts` (milestone 4, issue #381, matrix P230 to P232).

## Settings

The service reads them at start, from its environment. A token is read from a file, never from a variable, and never written in a log or an error. A setting that is wrong is said in one line at start, and the mirror stays off.

| Variable | Default | Notes |
| --- | --- | --- |
| `CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE` | none | Turns the GitHub mirror on. The file holds a token that can read and write the issues of each service's repository (`repository` in the workspace's settings). |
| `CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE` | none | Turns the Linear mirror on. The file holds a personal API key as it is, or an OAuth token written `Bearer <token>`. |
| `CLEARED_V2_MIRROR_LINEAR_TEAM` | none | The Linear team's key, such as `ENG`. Needed with the Linear token. |
| `CLEARED_V2_MIRROR_POLL_SECONDS` | `60` | Time between two passes, 15 at least. |
| `CLEARED_V2_MIRROR_GITHUB_API`, `CLEARED_V2_MIRROR_LINEAR_API` | GitHub's and Linear's | Another address must be on loopback: these are for the tests' fakes. |
| `CLEARED_V2_APP_LANGUAGE` | `fr` | The language of what the mirror writes on a tracker and on a ticket. |

Give the mirror an account of its own, a bot or an application, as v1 already asked of the agents (`[merge] separate_identity`). With a token of a person's own account, that person's moves on the tracker still count as theirs, unless they make a move the mirror made less than a minute before.

## What is mirrored

- **New tickets, both ways.** A ticket created in the app after the mirror's first pass is created on the tracker, with its title, its body and, on GitHub, its labels. An issue created on the tracker after that pass becomes a ticket in the app, in the service's project. Tickets and issues older than the first pass are left alone, so turning the mirror on copies nothing old.
- **The state, both ways.** On Linear, the team's workflow state with the same name as the app's (`Todo`, `In Progress`, `In Review`, `Needs Approval`, `Ready to Ship`, `Done`, or the names `[tracker] *_state` sets). On GitHub, one `status:<state>` label on an open issue, as v1 wrote it; an open issue with no such label is in `Todo`; `Done` is the issue closed as completed.
- **Where.** On GitHub, a ticket goes to the repository of its first service, or of the workspace's first service when it names none, and an issue of a service's repository comes in on that service. On Linear, every ticket goes to the one team.

Not mirrored: later edits of a title or a body, comments, assignees, Linear's labels and projects, and the trackers' states the app does not have (Linear's Backlog, Triage, Canceled; a GitHub issue closed as not planned, or with two status labels). An issue in such a state comes into the app once it is moved to one of the app's states.

## The conflict rule

1. For each ticket and each tracker, the mirror keeps the last state both sides agreed on. At each pass it reads both sides.
2. **One side changed since:** that side's state is written on the other.
3. **Both changed, to the same state:** nothing to write.
4. **Both changed, to different states:**
   - a change made by a person wins over a change made by an agent, whatever their times;
   - between two changes made by people, the later one wins;
   - between two changes made by agents, the app's wins;
   - two changes at the same time: the app's wins.
5. **Who made a change.**
   - In the app: a person when it is the owner's signed change. Anything else is an agent: the service, the flow, the lead, and a user of the app who is not the owner.
   - On the tracker: an agent when the actor is a bot, an integration or not named. The mirror's own writes never count as a change. Any other actor is a person.
6. **What a tracker never does through the mirror**, whoever makes the change:
   - It never approves. Moving an issue to `Ready to Ship` is not the owner's approval, which is given in the app only, so it is not applied. The tracker is put back to the app's state, and a comment on the issue says why.
   - It never moves a ticket the owner approved, or one whose release is landing. The answer is the same: put back, with a comment.
   - It never starts a session. A ticket moved to `Todo` on the tracker waits in the app's Todo until someone starts it in the app.
7. **A ticket the flow is working on.** A person's move on the tracker wins here too. The flow first sets the ticket aside, as the app's Set aside does: its sessions stop and nothing of it waits in the Inbox. Then the person's state is written. The note on the ticket names who moved it and where.

Times are compared as each side stamps them: the app with this server's clock, the tracker with its own. A gap between the two clocks bigger than the time between two people's changes can change who wins.

## What it writes in the app

The mirror writes as an agent named `cleared-mirror`, never as a signed person: a tracker cannot write the owner's signature, so nothing that comes from a tracker can count as the owner's approval. Who made the change on the tracker is kept in the mirror's own table (`mirror_applied`), and the rule reads it from there.

## How it runs

Every minute by default, the mirror reads each tracker's issues changed since its last pass. There is no webhook: a webhook needs an address the tracker can reach, and this service listens on this machine only. A tracker that does not answer is said in one line, and is read again at the next pass. The other trackers go on.

The tables are in the service's ledger: `mirror_trackers` (each tracker's first pass and last read), `mirror_links` (a ticket's issue and the agreed state), `mirror_applied`, and `mirror_writes` (the mirror's own writes, kept a day).

## What is proven, and what is left

- Tests: `v2/test/tickets/mirror-rule.test.ts` (the rule), `mirror.test.ts` (the pass on the real ticket store), `mirror-github.test.ts` and `mirror-linear.test.ts` (each tracker against a fake of its API), and `mirror-proof.test.ts` (milestone 4's proof, the mirrors' steps, on both).
- GitHub ran for real once, on the example repository: the pull request of issue #381 quotes the run.
- Linear has run against a fake only. A real trial needs a Linear account and a key, and that trial is the owner's to run. Until it has run, one thing is unknown: how Linear shows an OAuth application acting as itself (`actor=app`) in an issue's history. Such a change reads as an agent's.
- Known limit: if the service stops between the tracker's creation of an issue and the mirror's record of it, the next pass creates the issue again.
