# Cleared v2: the GitHub Issues and Linear mirrors

The app holds the tickets. A mirror keeps a copy of them on GitHub Issues, on Linear, or on both, and brings back what people change there. With no mirror set up, the app alone is enough (D17). The code is `v2/src/tickets/mirror.ts`, `mirror-github.ts` and `mirror-linear.ts` (milestone 4, issue #381, matrix P230 to P232; the comments, the edits and the live redraw, issue #386, P237; the delegation, issue #398, C3 and P244, with `v2/src/tickets/delegation.ts`).

## Settings

The service reads them at start, from its environment. A token is read from a file, never from a variable, and never written in a log or an error. A setting that is wrong is said in one line at start, and the mirror stays off.

| Variable | Default | Notes |
| --- | --- | --- |
| `CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE` | none | Turns the GitHub mirror on. The file holds a token that can read and write the issues of each service's repository (`repository` in the workspace's settings). |
| `CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE` | none | Turns the Linear mirror on. The file holds a personal API key as it is, or an OAuth token written `Bearer <token>`. |
| `CLEARED_V2_MIRROR_LINEAR_TEAM` | none | The Linear team's key, such as `ENG`. Needed with the Linear token. |
| `CLEARED_V2_MIRROR_POLL_SECONDS` | `60` | Time between two passes, 15 at least. |
| `CLEARED_V2_MIRROR_GITHUB_API`, `CLEARED_V2_MIRROR_LINEAR_API` | GitHub's and Linear's | Another address must be on loopback: these are for the tests' fakes. |
| `CLEARED_V2_DELEGATION` | `on` | `off` stops reading delegations (below). |
| `CLEARED_V2_DELEGATION_LABEL` | `cleared` | The label that hands an issue over to Cleared, compared without case. A name that starts with `status:` is refused. |
| `CLEARED_V2_APP_LANGUAGE` | `fr` | The language of what the mirror writes on a tracker and on a ticket, the first line of a mirrored comment included. |

Give the mirror an account of its own, a bot or an application, as v1 already asked of the agents (`[merge] separate_identity`). With a token of a person's own account, that person's moves on the tracker still count as theirs, unless they make a move the mirror made less than a minute before.

## What is mirrored

- **New tickets, both ways.** A ticket created in the app after the mirror's first pass is created on the tracker, with its title, its body and, on GitHub, its labels. An issue created on the tracker after that pass becomes a ticket in the app, in the service's project. Tickets and issues older than the first pass are left alone, so turning the mirror on copies nothing old.
- **The state, both ways.** On Linear, the team's workflow state with the same name as the app's (`Todo`, `In Progress`, `In Review`, `Needs Approval`, `Ready to Ship`, `Done`, or the names `[tracker] *_state` sets). On GitHub, one `status:<state>` label on an open issue, as v1 wrote it; an open issue with no such label is in `Todo`; `Done` is the issue closed as completed.
- **The title and the description, both ways.** A change of either, made after the ticket and its issue were linked, is written on the other side, each field on its own, by the conflict rule below.
- **Comments, both ways.** Each comment of a mirrored ticket is written once on each of its trackers, and each comment of a mirrored issue once in the app. Its first line says who wrote it and where:
  - on the tracker, "{who}, in Cleared:" for the owner's comment, "A user of Cleared:" for another user's, "Cleared:" for the service's notes;
  - in the app, "{who}, on GitHub:" or "{who}, on Linear:".

  A comment that came from one tracker goes on to the others as it is, never back to its own. Every comment of the app goes out, the service's notes included: the app has no comment box today, so those notes and v1's tools are its only writers. On a public repository, they are public.
- **Where.** On GitHub, a ticket goes to the repository of its first service, or of the workspace's first service when it names none, and an issue of a service's repository comes in on that service. On Linear, every ticket goes to the one team.

Not mirrored: a comment edited or deleted after it was mirrored, a comment's images, later edits of the labels, assignees, Linear's labels and projects, and the trackers' states the app does not have (Linear's Backlog, Triage, Canceled; a GitHub issue closed as not planned, or with two status labels). An issue in such a state comes into the app once it is moved to one of the app's states.

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
   - It never edits the title or the description of a ticket the owner approved, until it is released. The tracker's text is put back to the app's, with one comment.
   - It never starts a session by itself. A ticket moved to `Todo` on the tracker waits in the app's Todo until someone starts it in the app. A ticket of a plan the owner approved goes on as that plan says: the plan's runner may start it again once it is back in Todo, as it does after a move in the app. A delegation (below) does not change this: it proposes a plan, and the owner approves it in the app.
7. **A tracker in a state the app does not have.** Closed as not planned, Canceled, Backlog: a person may have put it there, so an agent's change in the app is not written over it. The owner's change is. The app's state does not change either, since it has no such state.
8. **A ticket the flow is working on.** A person's move on the tracker wins here too. The flow first sets the ticket aside, as the app's Set aside does: its sessions stop and nothing of it waits in the Inbox. Then the person's state is written. The note on the ticket names who moved it and where.
9. **The title and the description.** Each follows rules 1 to 4 on its own, its text in place of the state, against the text both sides last agreed on. Who made a change:
   - on GitHub, a new title is the issue's `renamed` event, with its actor. GitHub records no event for a new description, so no one is named for it, and it counts as an agent's change;
   - on Linear, the issue's history says who changed each;
   - in the app, only the mirror writes them, as the person or agent who made the change on the tracker.
   
   An empty title is never written in the app. An edit does not stop or tell a session that works on the ticket: it reads the text it was given when it started.

Times are compared as each side stamps them: the app with this server's clock, the tracker with its own. A gap between the two clocks bigger than the time between two people's changes can change who wins.

## Handing an issue over to Cleared

A person delegates an issue to Cleared on the tracker (C3):

- on GitHub, with the label `cleared` on an open issue, or by assigning the issue to the mirror's account;
- on Linear, with the label `cleared` on the issue, or by assigning it to the user of the mirror's key, in any state but a completed or a canceled one.

At its next pass, the mirror:

1. Makes the issue a ticket, if it is not one yet, however old the issue is. An issue in a state the app does not have (Linear's Backlog or Triage) comes in `Todo`, and the mirror moves the tracker to `Todo`.
2. Hands the ticket to the lead's plans. They propose a plan of one item, bound to that ticket, which waits in the Inbox for the owner like any plan. The lead is told in its thread who handed it over, on which tracker, and which ticket and plan. The issue's text reaches the lead only through the ticket, which its tool reads.
3. Writes a comment on the issue that gives the ticket and the plan, and says that nothing starts before the owner's approval.

When the owner approves the plan, its runner starts the ticket with the owner as the one who approved it; the release still waits for the owner. A rejected plan leaves the ticket in `Todo`.

- **Who counts.** Who put the label on or made the assignment is read from the issue's events (GitHub's `labeled` and `assigned`) or its history (Linear's `addedLabelIds` and `toAssigneeId`), or is the issue's author when no event names it. A bot, an integration or an actor the tracker does not name delegates nothing. The mirror's own account counts as a person, except for the label it puts on an issue it creates from a ticket that has the label.
- **Once.** Each delegation, an issue and the time it was made, is taken once (`mirror_delegations`). Taking the label off and putting it on again is a new one. A delegation made before the mirror's first pass on that tracker is left alone.
- **A ticket already in hand.** A ticket past `Todo`, run by a session, or an item of a plan that runs gets no new plan; the comment on the issue says so. A second delegation while the ticket's plan still waits replaces that plan.
- **No lead running.** The delegation waits in its table and is handed over at the first pass after the lead starts.

Taking a delegation back by removing the label or the assignee does nothing: move the issue instead (rule 8). A start without the owner's approval, and Linear's own delegation of an issue to an application user, are not done.

## What it writes in the app

The mirror writes as an agent named `cleared-mirror`, never as a signed person: a tracker cannot write the owner's signature, so nothing that comes from a tracker can count as the owner's approval or the owner's comment. Who made the change on the tracker is kept in the mirror's own tables (`mirror_applied` for a state, `mirror_edits` for a title or a description), and the rule reads it from there.

A new title or description changes the ticket's text, not its history of states. The owner's signature on a ticket they created covers its text (`content_hash`): once the text changes, that first row no longer reads as the owner's. The approval is a separate signature and is not affected by it.

Each ticket the mirror writes, whether created, moved, edited or commented, is said on the app's change stream. An open board or ticket then fetches it again, without a reload.

## How it runs

Every minute by default, the mirror reads each tracker's issues changed since its last pass. There is no webhook: a webhook needs an address the tracker can reach, and this service listens on this machine only. A tracker that does not answer is said in one line, and is read again at the next pass. The other trackers go on.

Comments are read by their own time, apart from the issues: on GitHub, the repository's issue comments; on Linear, the team's.

The tables are in the service's ledger: `mirror_trackers` (each tracker's first pass and last read), `mirror_links` (a ticket's issue and the agreed state), `mirror_applied`, `mirror_writes` (the mirror's own writes, kept a day); and for the comments and the text, `mirror_followed` (when the mirror began following a link's comments and text), `mirror_fields` (the agreed title and description), `mirror_edits` and `mirror_comments` (each comment's two ids, the mirror's own comments on a tracker included); and `mirror_delegations` (each delegation, its ticket and what the plans made of it). A link made before this code, by version 384, is followed from the first pass after the upgrade: older comments are not copied, and both sides' texts count as agreed as the app holds them.

## What is proven, and what is left

- Tests: `v2/test/tickets/mirror-rule.test.ts` (the rule), `mirror.test.ts` (the pass on the real ticket store), `mirror-github.test.ts` and `mirror-linear.test.ts` (each tracker against a fake of its API), and `mirror-proof.test.ts` (milestone 4's proof, the mirrors' steps, and a comment and an edit each way, on both). The delegation: `mirror-delegation.test.ts` (the pass), `delegation.test.ts` (the plan bound to the ticket and its approval) and `delegation-proof.test.ts` (C3's steps on both fakes).
- GitHub ran for real three times, on the example repository: the pull requests of issues #381, #386 and #398 quote the runs. The last one found that GitHub records a `labeled` event for an issue opened with the label, and that its list of issues can show a new issue only after a pass or two; the next pass reads it.
- Linear has run against a fake only. A real trial needs a Linear account and a key, and that trial is the owner's to run. Until it has run, four things are unknown: how Linear shows an OAuth application acting as itself (`actor=app`) in an issue's history; whether a comment of an integration carries its `botActor`; whether the history's `toTitle` and `updatedDescription` are filled as its schema says; and whether its `addedLabelIds` and `toAssigneeId` are, for a delegation. A change no one is named for reads as an agent's; a delegation no history entry names is read as the issue's creator's.
- The real GitHub run was a one-off script; there is no `doctor` section for the mirrors yet.
- The app shows no comment yet: a comment that came from a tracker is read by the lead (its last five) and by v1's tools.
- The lead's tool names every comment that no person signed `cleared`. A comment from a tracker therefore reaches the lead as `cleared: jane, on GitHub: ...`. On a public repository, anyone can write that text, and it reaches the lead under Cleared's name.
- Known limit: if the service stops between the tracker's creation of an issue, or of a comment, and the mirror's record of it, the next pass creates it again.
