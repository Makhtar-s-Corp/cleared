# Cleared v2: milestone 4 plan

Written on 2026-10-25, before the code of milestone 4. The brief's section 6 for milestone 4 is not in this repository; its content is taken from the matrix's lines B6.4 and B6.4p ([requirements-matrix.md](requirements-matrix.md), section C), which repeat it: two-way Linear and GitHub Issues, v1 data reused, every removal of [keep-and-drop.md](keep-and-drop.md) done, no bash in the core; the proof, "a ticket created in the app appears in Linear and the reverse; a human move in Linear wins; `git grep` finds no bash script in the core".

Milestone 4 runs as lanes, each with its issue: the mirrors (issue #381, lane `v2-j4-issue-mirrors`, section 2 below) and the cleanup (issue #382: the dropped files, the bash of the core, the kept JavaScript in strict TypeScript). Each lane adds its own section to this file. `milestone-2-plan.md` has no sections 9 and 10; the conventions followed are those of sections 9 and 10 of [milestone-1-plan.md](milestone-1-plan.md), as the lanes of milestone 3 noted: a lane fills its own module, never `main.ts`; a screen's words live in its catalogs; `api/types.ts` is not changed on the side.

## 1. The proof, the mirrors' part

B6.4p, steps 1 to 3 (step 4, `git grep`, is the cleanup's):

1. A ticket created in the app appears in Linear, in the state it has in the app, at the next pass of the mirror.
2. An issue created in Linear appears in the app as a ticket, in the state it has in Linear.
3. A person moves the issue in Linear while an agent moves the ticket in the app, between two passes: after the pass both sides hold the person's state.

Linear is a fake server here, never a real account and never a real key (the issue's rule): the steps run in `test/tickets/mirror-proof.test.ts` on the real ticket store over a fake Linear GraphQL server on loopback. The same steps are run against GitHub Issues, faked in the tests and once for real on the example repository `cleared-example-guestbook`, the run quoted in the pull request. A real Linear trial is the owner's.

## 2. The mirrors lane (`v2-j4-issue-mirrors`, issue #381)

### 2.1 Context

The v2 ticket store lives in the app (`tickets/local-store.ts`, decision 11 of milestone 1), and D17 asks for it to be kept in step with Linear and GitHub Issues, with the app alone sufficing when nothing is configured. v1 had Linear and GitHub adapters (`lib/tracker/`) but as the tracker itself, not as mirrors of the app's store, and its bash Linear adapter is one of the files milestone 4 removes. This lane adds a mirror that polls each configured tracker, applies the changes both ways and settles a conflict by a written rule.

### 2.2 What exists at the end, and how it is proven

- `src/tickets/mirror.ts`: the mirror's tables, its pass, the conflict rule as a pure function, its settings. `src/tickets/mirror-github.ts` and `src/tickets/mirror-linear.ts`: the two trackers behind one small interface. `src/tickets/messages/mirror.{en,fr}.json`: the words it writes.
- The tickets module (`modules/tickets.ts`) starts the mirror's timer at the service's start and stops it at its stop; with nothing configured it starts nothing.
- [docs/v2/mirrors.md](mirrors.md): the settings, what is mirrored and what is not, and the conflict rule in full. `v2/README.md` points to it.
- Proven by `test/tickets/mirror-rule.test.ts` (the rule, case by case), `test/tickets/mirror.test.ts` (the pass on the real store with a tracker in memory), `test/tickets/mirror-github.test.ts` and `test/tickets/mirror-linear.test.ts` (each tracker against its fake HTTP server), `test/tickets/mirror-proof.test.ts` (section 1), and the real GitHub run quoted in the pull request.

### 2.3 The conflict rule

The rule, as `docs/v2/mirrors.md` writes it for a person:

1. For each ticket and each tracker, the mirror keeps the last state both sides agreed on. At each pass it reads the state of each side.
2. Only one side changed since: that side's state is written on the other.
3. Both changed to the same state: nothing to write.
4. Both changed to different states: the change made by a person wins over the change made by an agent, whatever their times. Between two changes made by people, the later one wins. Between two changes made by agents, the app's wins. Two changes at the same second: the app's wins.
5. Who made a change. In the app: a person when the history row is the owner's signed row, an agent otherwise (the service, the flow, the lead). On the tracker: an agent when the event's actor is a bot or an integration, or when the actor is unknown; the mirror's own writes are recognised and never count as a change; any other actor is a person.
6. What a tracker never does through the mirror, whoever made the change. It never approves: a move to the go state ("Ready to Ship") is the owner's approval, given in the app only (B5.3c), so it is not applied, the tracker is put back to the app's state and a comment says why. It never moves a ticket the owner approved, or one whose release is landing: same answer. It never starts a session by itself: a ticket moved to Todo on the tracker waits in the app's Todo until someone starts it in the app (a ticket of a plan the owner approved goes on as the plan says). A tracker in a state the app does not have is not written over by an agent's change, only by the owner's.
7. A person's move on the tracker of a ticket the flow is working on wins too: the flow sets the ticket aside first (its sessions stop, nothing of it waits in the inbox), as the app's Set aside does, then the person's state is written.

### 2.4 Decisions this lane takes

- **Polling, no webhook.** A webhook needs an address the tracker can reach, and the brief forbids tunnels and new listeners. The mirror reads each tracker every minute by default (`CLEARED_V2_MIRROR_POLL_SECONDS`, at least 15).
- **What is mirrored.** The creation of a ticket, both ways (title, body; GitHub's labels), and its state, both ways. Not mirrored: later edits of the title and the body (the app has no edit of them, and the approval binds them through `content_hash`), comments, assignees, the trackers' states that are not the six of the app (Linear's Backlog, Triage, Canceled; an issue closed as not planned). Only tickets and issues created after the mirror's first pass are mirrored, so turning it on does not copy a project's whole history.
- **States.** Linear: the team's workflow states, matched by name to the app's six. GitHub: one label `status:<state>` on an open issue, as v1's GitHub adapter did; Done is the issue closed as completed, with its `status:Done` label.
- **Where.** GitHub: the repository of the ticket's first service, else of the workspace's first service; an issue of a service's repository becomes a ticket on that service when the workspace has several. Linear: one team for the workspace.
- **Who writes in the app.** A change the mirror applies is written as `agents`, id `cleared-mirror`, never as a signed human row: a tracker cannot forge the owner's signature. Who made it on the tracker, person or agent, with the tracker's name and time, is kept in the mirror's own table and read back by the rule.
- **Secrets.** The tokens are read from files (`CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE`, `CLEARED_V2_MIRROR_LINEAR_TOKEN_FILE`), never from the environment, and never written in a log or an error. An API address other than the trackers' own must be on loopback (the tests' fakes).
- **Language.** The comment the mirror writes on a tracker follows `CLEARED_V2_APP_LANGUAGE` (French by default), as the chat's replies do; the note on a ticket set aside follows it too.
- **Matrix lines.** P230 (the mirror's pass and its settings), P231 (the conflict rule), P232 (what a tracker never does through the mirror); B5.8b, D17, B6.4 and B6.4p updated.

### 2.5 Out of scope

Comments and later edits of title and body both ways; Linear's labels, projects and assignees; a real Linear account; webhooks; a screen that shows a ticket's mirrors (the mirror's state is in its tables and its log lines); mapping a tracker's people to the app's users, which a session started from the tracker would need; v1 data reused for estimates (B6.4's other part).

### 2.6 Files this lane owns

`v2/src/tickets/mirror*.ts`, `v2/src/tickets/messages/mirror.*.json`, `v2/test/tickets/mirror*.test.ts` and their fakes, `docs/v2/mirrors.md`; one function added to `modules/tickets.ts` (start and stop); one optional argument added to `FlowEngine.setAside` (the note's words); its lines of the matrix and its log entry.

### 2.7 Unknowns, and who closes them

| Unknown on 2026-10-25 | Closed by |
| --- | --- |
| How Linear shows an OAuth application acting as itself (`actor=app`) in an issue's history: `botActor`, or the user | the owner's real trial; until then such an event reads as an agent's |
| Whether GitHub's issue events lag behind the issue's labels | the real GitHub run of this lane; a stale read of the mirror's own write is not a change either way |
| A crash between the tracker's creation of an issue and the mirror's record of it creates the issue again at the next pass | not closed: named in `docs/v2/mirrors.md` |
