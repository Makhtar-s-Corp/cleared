# The fast lane

Prudence proportional to risk: a tiny, explicit change that cannot hurt takes a short circuit; every other ticket keeps the full one. The fast lane is off until `[fast_lane] enabled = yes` ([configuration](configuration.md#fast_lane)).

## How a ticket gets on it

Written rules decide, never a model (`lib/fast-lane.mjs`), in two moments:

1. **At opening, from the ticket.** A ticket whose label is in `[fast_lane] labels`, or whose project is in `projects`, opens on the fast lane. This only picks the light author (`author_model`) and adds the fast-lane instructions to its prompt. The choice is written once in the lane record, in Cleared's state; a label added later changes nothing. A second team of a ticket, and every role other than the author and its reviewer, always take the full circuit.
2. **After the author's work, from the real diff, which is authoritative.** The rules read what the branch changes since it left the base (`git diff-tree` against the merge base, on the main checkout, no rename detection, no external diff or text conversion), at one exact commit. They run after each session (before the push), at every round of the rules on the pull request's current head, and again in `merge-pr.sh` on the very commit that goes live. A head that moved is judged again; what was decided at another commit counts for nothing.

A defect the reviewer reports (its verdict asks for corrections) sends the ticket back to its team on the same lane, with the findings, as any review does: it is not a demotion, and the ticket stays on the fast lane. Only the rules send a ticket back to the full circuit, and for good: its card says so with the reason (“back to the full circuit: a file outside the safe list”), the ledger has a `fast_lane_fallback` event, and the project lead is told. A ticket never comes back to the fast lane.

## What qualifies

Every one of these, at that commit:

- every changed file matches `safe_paths` (empty means nothing qualifies);
- at most `max_lines` changed lines (added plus removed) and `max_files` files, no file over `max_file_bytes`;
- each file is added or modified as a plain, non-executable file, both before and after (git mode `100644`);
- every path is plain ASCII, with no empty, `.` or `..` segment and no segment starting with `-`, and no two paths differ only by case;
- the author's team asked the user no question.

## What never qualifies

Whatever the settings say, any of these sends the ticket to the full circuit:

- a deletion, a rename (seen as a deletion), a change of type or mode, a symbolic link, a submodule, an executable, a binary file, an unmerged or unknown status, an empty change, a diff git cannot read;
- Cleared's own settings and prompts (`.cleared/`), CI and forge files (`.github/`, `.gitlab/`, `.circleci/`), agent rules (`.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md`), any segment starting with `.git`, `.husky/`, `.devcontainer/`, Dockerfiles and Containerfiles with their variants (`Dockerfile.web`, `*.dockerfile`), compose files (`compose*.yaml`, `docker-compose*.yml`), `Makefile`, `CODEOWNERS`, `Procfile`, `justfile`, at any depth and in any case;
- `[merge] guarded_paths`, compared without case;
- dependency files at any depth: `package.json`, lock files (`*.lock`, `*-lock.json`, `*-lock.yaml`, `*.lockb`, `*.lockfile`), `npm-shrinkwrap.json`, `.npmrc`, `.yarnrc*`, `.nvmrc`, `.node-version`, `.tool-versions`, `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `Pipfile`, `Gemfile`, `go.mod`, `go.sum`, `go.work`, `Cargo.toml`, `composer.json`, `pom.xml`, Gradle build files, `mix.exs`, `Podfile`, `Package.swift`, `deno.json`, `flake.nix` and a few more, plus `dependency_files`;
- migrations: a `migrations`, `migration` or `migrate` segment, any `.sql` file, and `[release] migration_paths`;
- `never_paths`.

## What the fast lane changes

| Step | Full circuit | Fast lane |
| --- | --- | --- |
| Author | the routing table | `author_model` |
| Questions | the team and the lead may ask the user | none: the team takes the most prudent reading of the ticket and writes it in its report; a team that still asks sends the ticket to the full circuit, and its question is relayed |
| Tests | the whole suite in the session | `tests_command` on the changed files only, run by Cleared after the session, without a shell, under `[security] agent_user` when set, with an empty environment |
| Captures | as the project's rules ask | one capture of `capture_screen` (or the screen the ticket names), before and after |
| Full checks | start when the host is free for a run, one pull request at a time | the same: they start when the host is free, and nothing but the merge waits for them |
| Review | after green checks, by the routing table | at once once the pull request is out of draft, by `review_model`, while the checks run; the reviewer still differs from the author |
| “Ready to land” | after green checks and review | as soon as the review (nothing blocking), the targeted tests (passed at that commit) and the capture are there, and the pull request is out of draft; the card says “full checks running, landing when green” while they run, and “full checks not started yet” or “full checks failed” otherwise |
| Merge | waits for the full checks, for a host with no CI at all and no screen test, and for the previous release's health watch | waits for the full checks of its own commit, for GitHub and for a deployment settling, and for any run on the base branch or of a non-pull-request event; not for the pull-request CI runs of other commits, nor for a screen test; the health watch of a fast-lane release holds no merge back |
| Done for the user | at the merge | at the merge |

The full checks still run on the forge and still gate the merge: the user's agreement waits in the merge queue (`merge-pr.sh` exits 3) until they are green. A red check refuses the merge and sends the ticket back to its team by the usual path; the team's fix is a new version, and the user is asked again for it, as for any ticket.

“Unrelated CI”, precisely: a run in `host-state.sh`'s `ci_runs_in_progress` that is a `pull_request` run of another commit on another branch than the base. Every other run blocks a fast-lane merge as it blocks the full circuit: any run on the base branch (a push or a deployment of a previous merge, still running), any run of a non-pull-request event, and any run of the head itself. A deployment settling blocks it too. A fast-lane merge never goes live while a check of its own head is pending or red.

The health watch of a fast-lane release keeps running after the merge, and its automatic or manual rollback stays as it is. Because it no longer holds the next merge back, a later merge can land while it watches: an automatic rollback of the fast-lane release is then refused as ambiguous (`rollback_ambiguous_base`), the user is told, and `cleared rollback` remains available. A full-circuit release's watch still holds every merge back, the fast lane's included.

## Measurement

At each merge, `ticket_measured` goes to the ledger with the minutes from Todo (when the user put the ticket there, as the tracker dates it) to Done (the merge), split into:

- **working time**: the union of the agent sessions' times;
- **human wait**: from the first `notification_sent` approval notification after the request (when notifications are installed), else from the request that made the card appear, to the user's gesture (the app's agreement, else the tracker's history of his move where the tracker keeps one; unknown otherwise);
- **machine wait**: the rest (checks, queues, the host);
- the lane, fast or full.

The stamps are compared as dates. `todo_at` is the tracker's own stamp of the ticket's move to Todo (its updated time, as the tracker dates it); when it is unknown, the time is shown as unknown, never taken from the opening. The validation's `at` is the last time the user was asked (a request made again replaces it), not the time of the first ask: the human's wait is measured from it.

The app shows each landed ticket's lane and times, and one line with the median from Todo to Done over the last seven days, by lane. A ticket whose Todo time is unknown is not in the median.

## Threat model: can a risky ticket take the fast lane?

The fast lane removes waits and weight, never a gate. Even a ticket that should not have been fast cannot go live without green full checks on its exact commit, a review by a model other than its author that concludes `[merge] verdict`, and the user's agreement to that exact version (`merge-pr.sh`, unchanged). What the fast lane can cost, when it is wrongly granted, is a lighter author and reviewer, fewer tests and captures before the user is asked, and a merge that does not wait for an idle host.

How a risky change is kept off it:

- **The diff decides, not the ticket.** A label only picks the author; the rules read the commit itself, and an empty `safe_paths` makes nothing fast.
- **Allow list, then deny lists, failing closed.** A file must match `safe_paths`; the built-in lists, `[merge] guarded_paths` and `never_paths` then win over it; anything unreadable, unusual or too large is the full circuit.
- **The settings are not the branch's.** The rules read `.cleared/agents.conf` from the main checkout, which agents cannot write, never from the pull request; a pull request that touches `.cleared/` is never fast, so it cannot widen its own safe paths.
- **Bound to a commit.** The decision is recomputed at every head and again by `merge-pr.sh` at the merged commit: a pull request accepted at one commit and extended later is judged again, and a demotion is for good.
- **Agents cannot set the flag.** The decision is kept in the lane record and the ledger, in Cleared's state, which the agents' account cannot write; `fast-lane.mjs` refuses to decide for any account but the state's owner; nothing an agent writes (its report, a commit message, a file in its worktree) is read for it; and the merge does not trust the record anyway.
- **Path tricks.** Paths are read as git's bytes; only plain ASCII segments are judged, so look-alike letters, other normal forms, `..`, a leading `-` (an option for the test runner) and case twins all fail. Protected names are compared without case.
- **Targeted tests run branch code.** They run with no shell (the template is split into words, `{files}` becomes one argument per changed file), with an empty environment, and under `[security] agent_user` with the same sandbox as the agents when it is set, never with the service's credentials.

Residual risks to keep in mind:

- Without `[security] agent_user`, agents run as the service account and could write the state; as for the release lock, nothing here is then a security boundary (`docs/security.md`).
- A file in `safe_paths` that the application executes or interprets (a template engine, a style sheet with remote imports, a JSON file read as configuration) is as risky as code: keep `safe_paths` to text the application only displays.
- The light reviewer is still the only model review; its verdict is binding as in the full circuit, not stronger.
- Overlapping health watches can blame the wrong release; automatic rollback refuses an ambiguous base and the user decides.
