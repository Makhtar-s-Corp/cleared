# The fast lane

Prudence proportional to risk: a tiny, explicit change that cannot hurt takes a short circuit; every other ticket keeps the full one. The fast lane is off until `[fast_lane] enabled = yes` ([configuration](configuration.md#fast_lane)).

## How a ticket gets on it

Written rules decide, never a model (`lib/fast-lane.mjs`), in two moments:

1. **At opening, from the ticket, and only from the user.** A ticket whose label is in `[fast_lane] labels`, or whose project is in `projects`, opens on the fast lane only when the user set that label or project himself. An agent can create a ticket (the lead files follow-ups, and `[tracker] create_label` or `create_project` may be the fast ones) or add a label to one: a mark it set picks nothing. Who set it is read from the tracker (`tracker.sh label-actors`): on Linear, the author of the last change of the issue's history that added the label or moved the issue into the project, else its creator; on GitHub, the actor of the label's last `labeled` event (an app is never the user), and for the project (the repository) the issue's author; on the local tracker, the ticket's creator, from its signed history. Only `[tracker] owner_id` is the user. A tracker that cannot say (an error, a Linear history longer than one page) gives nothing, unless the project sets `trust_label_without_actor = yes`; even then, a mark the tracker says an agent set is refused. An ignored mark is kept in the ledger (`fast_lane_mark_ignored`), and the ticket opens on the full circuit with the routing table's author. A trusted mark only picks the light author (`author_model`) and adds the fast-lane instructions to its prompt. The choice is written once in the lane record, in Cleared's state; a label added later changes nothing. A second team of a ticket, and every role other than the author and its reviewer, always take the full circuit.
2. **After the author's work, from the real diff, which is authoritative.** The rules read what merging the commit into the base would change: the tree `git merge-tree --write-tree` makes (git 2.38 or later; an older git makes nothing fast, and the lead is told), against the base's own tree, with `git diff-tree` on the main checkout, no rename detection, no external diff or text conversion. The trees the merge writes go to a scratch object directory, never into the checkout. A history with more than one merge base (criss-cross merges, where git and the forge merge from a virtual base and a file can come back to an old version without the branch's own diff showing it) and a merge that conflicts are not judged: the full circuit, until the branch is brought up to date. The rules run at one exact commit: after each session (before the push), at every round of the rules on the pull request's current head, and again in `merge-pr.sh` on the very commit that goes live. A head that moved, or a base that moved, is judged again; what was decided at another commit counts for nothing.

A defect the reviewer reports (its verdict asks for corrections) sends the ticket back to its team on the same lane, with the findings, as any review does: it is not a demotion, and the ticket stays on the fast lane. Only the rules send a ticket back to the full circuit, and for good: its card says so with the reason (“back to the full circuit: a file outside the safe list”), the ledger has a `fast_lane_fallback` event, and the project lead is told. A ticket never comes back to the fast lane.

From then on it is a full-circuit ticket in every way that is still ahead of it. The record keeps when it left (`demoted_at`); a review begun before that, the light reviewer's, counts for nothing: `merge-pr.sh` refuses the merge without a review begun since, `review-pr.sh` reviews the same head again, and the rules ask for the full circuit's review once the checks are green, by the routing table's reviewer (`[rules]`, `[roles]`, still different from the author). Every later session of its team is opened with the routing table's author. What the light author already wrote is not rewritten: it is what the full circuit's reviewer reads, whole, against the base.

## What qualifies

Every one of these, at that commit:

- every changed file matches `safe_paths` (empty means nothing qualifies); a file or directory whose name starts with a dot (`docs/.env`, `web/.well-known/`) is matched only by a pattern segment that starts with a dot too: `*` and `**` never take one, so `docs/` holds no `docs/.htaccess`; a project that wants one names it (`docs/.nojekyll`, `web/.*.css`);
- every line each file gains is plain text that nothing interprets (the content rule, below);
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
- `never_paths`;
- a gained line that holds, compared without case and also with its blanks taken out (written or escaped as `\t`, `\n`): markup or a tag (`<`, `%3c`, `&#`, a named entity such as `&lt;` or `&Tab;`); a remote or inline load (`url(`, `@import`, `@font-face`, `@namespace`, `data:`, `javascript:`, `vbscript:`, `expression(`, `behavior:`, `-moz-binding`); a template or interpolation (`{{`, `{%`, `${`, `#{`); an escape that can spell any of these (`\` before a hex digit, `\u`, `\x`); an event handler (`on…=`); a character that hides text from a reader (controls, zero-width and bidirectional marks); bytes that are not UTF-8; any text of `forbidden_text`. The lines are read from a third reading of the same trees (`git diff-tree -p -U0`), which must agree with the two others file by file and line by line; one that does not is not read, and is not fast. There is one scan for every file, prose included: Markdown carries raw HTML, and MDX or Jekyll run what is in a page. A translation that adds an `{{interpolation}}` takes the full circuit.

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
| Merge | waits for the full checks, for a host with no CI at all and no screen test, and for the previous release's health watch | waits for the full checks of its own commit, for GitHub and for a deployment settling, and for any run on the base branch or of a non-pull-request event; not for the pull-request CI runs of other commits, nor for a screen test; the health watch of a fast-lane release holds no merge back while its health is good |
| Done for the user | at the merge | at the merge |

The full checks still run on the forge and still gate the merge: the user's agreement waits in the merge queue (`merge-pr.sh` exits 3) until they are green. A red check refuses the merge and sends the ticket back to its team by the usual path; the team's fix is a new version, and the user is asked again for it, as for any ticket.

“Unrelated CI”, precisely: a run in `host-state.sh`'s `ci_runs_in_progress` that is a `pull_request` run of another commit on another branch than the base. Every other run blocks a fast-lane merge as it blocks the full circuit: any run on the base branch (a push or a deployment of a previous merge, still running), any run of a non-pull-request event, and any run of the head itself. A deployment settling blocks it too. A fast-lane merge never goes live while a check of its own head is pending or red.

The health watch of a fast-lane release keeps running after the merge, and its automatic or manual rollback stays as it is. While its health is good it holds no merge back; once a check of it fails, it holds every merge back until its watch ends, as a full-circuit release's watch always does (a merge that went live just before is still watched). A later merge can still land while it watches, so the health probe, which is the whole site's, can no longer say which release broke it:

- the earlier release's own automatic rollback is refused as ambiguous (`rollback_ambiguous_base`): the base moved after it;
- the later release's watch never reverts it automatically when an earlier release is still watched, went live less than `watch_minutes` before it, or was last seen failing with no release since whose watch ended healthy (the run of failures keeps the time it began, `first_failure_at`). It marks the release failed, writes `rollback_overlapping_release` to the ledger with the time the failure was first seen and the time the release merged, and tells the user which other release is in doubt.

In both cases `cleared rollback` remains available for the release at fault.

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

- **The diff decides, not the ticket; the user decides the label.** A label or a project an agent set picks nothing, and a tracker that cannot say who set it gives nothing unless the project opts in. A trusted label picks more than a model: the light author skips the `[rules]` routing a label or a path would have chosen (a `Security` label sent to a stronger author, say). That is why only the user's mark counts, and why a ticket the rules send back gets the routing table's reviewer and author from then on. Then the rules read the change itself, and an empty `safe_paths` makes nothing fast.
- **What lands, not what the branch says.** The diff judged is the one the merge would put on the base; a history it cannot read with one merge base, or a conflict, is not judged.
- **A safe place is not safe content.** A file in `safe_paths` still has every gained line read: markup, loads, templates, escapes, handlers and hidden characters send it to the full circuit.
- **Allow list, then deny lists, failing closed.** A file must match `safe_paths`; the built-in lists, `[merge] guarded_paths` and `never_paths` then win over it; anything unreadable, unusual or too large is the full circuit.
- **The settings are not the branch's.** The rules read `.cleared/agents.conf` from the main checkout, which agents cannot write, never from the pull request; a pull request that touches `.cleared/` is never fast, so it cannot widen its own safe paths.
- **Bound to a commit.** The decision is recomputed at every head and again by `merge-pr.sh` at the merged commit: a pull request accepted at one commit and extended later is judged again, and a demotion is for good.
- **Agents cannot set the flag.** The decision is kept in the lane record and the ledger, in Cleared's state, which the agents' account cannot write; `fast-lane.mjs` refuses to decide for any account but the state's owner; nothing an agent writes (its report, a commit message, a file in its worktree) is read for it; and the merge does not trust the record anyway.
- **Path tricks.** Paths are read as git's bytes; only plain ASCII segments are judged, so look-alike letters, other normal forms, `..`, a leading `-` (an option for the test runner) and case twins all fail. Protected names are compared without case.
- **Targeted tests run branch code.** They run with no shell (the template is split into words, `{files}` becomes one argument per changed file), with an empty environment, and under `[security] agent_user` with the same sandbox as the agents when it is set, never with the service's credentials.

Residual risks to keep in mind:

- Without `[security] agent_user`, agents run as the service account and could write the state; as for the release lock, nothing here is then a security boundary (`docs/security.md`).
- **Text can change meaning.** The content rule reads form, not sense: a changed price, a changed legal or consent sentence, a removed warning, or a plain CSS rule that hides an element (`.cookie-banner { display: none }`) is plain text to it. List in `never_paths` every file whose words carry an obligation: legal pages, terms, privacy and consent texts and their translations, pricing and payment copy, and the style sheets of consent banners. Add the words that must never change on the fast lane to `forbidden_text`. Only the gained lines are read: a removed line is judged by `max_lines` and by the reviewer.
- **What the scan does not see.** It reads each gained line alone: a construct split across lines (`u` on one line, `rl(` on the next) is not seen as one, nor is a file that is safe only until another, unchanged file interpolates it into raw HTML. Keep `safe_paths` to text the application only displays, escaped; a template engine, a style sheet with imports, or a JSON file read as configuration is code.
- The light reviewer is still the only model review on the fast lane; its verdict is binding as in the full circuit, not stronger. A ticket sent back keeps the light author's work, reviewed by the full circuit's reviewer, not rewritten.
- Who set a label is the tracker's word. On Linear the field names of the history (`addedLabelIds`, `toProjectId`) are read as Linear documents them; if Linear stops sending them, the history reads as empty and the creator is taken as the setter, which is only the user for a ticket he created. A shared account (one key for the user and the agents) makes every action the user's: run the agents under their own identity (`docs/security.md`).
- The tree judged is this git's merge, with the main checkout's attributes; the forge's own merge is taken to be the same (the same algorithm, from the one merge base the rules require). A merge driver declared in the base's `.gitattributes` (such as `union`), or a forge set to merge differently, could land another tree. `merge-pr.sh` judges before the merge, not after it.
- A rehearsal (`merge-pr.sh --dry-run`) writes nothing, so a ticket it would send back to the full circuit is not yet marked as such: it may still count the light review there. The real merge marks it first, then refuses without a review of the full circuit.
- Overlapping health watches cannot say which release broke the site: automatic rollback is refused whenever two releases overlap or an earlier failure is unresolved, and the user decides. A failure that starts after the earlier release's window and has another cause still blames the release being watched, as on the full circuit.
