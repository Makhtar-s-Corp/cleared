# Configuration reference

Copy [`agents.example.conf`](../agents.example.conf) to `<project>/.cleared/agents.conf` and change it for the project. Cleared reads only a tracked `.cleared/agents.conf`. An untracked copy is ignored and recorded in the ledger. The example is documentation only and is never loaded at runtime. Safe defaults are built into `lib/conf.mjs`; missing project-specific settings fail when first used. The first occurrence of a duplicate key wins and is recorded in the ledger. The parser uses `key = value` lines and full-line `#` comments; it does not strip quotes from a value. Do not put secrets in this file.

The installer never writes project files. `CLEARED_REPO`, `CLEARED_CONF`, and `CLEARED_STATE_DIR` override discovery. `serve/install.sh` binds services to a single project and requires Tailscale; `spawn-lane.sh` can be run manually without those services. If a Cleared wake timer or service is active, the installer refuses to activate another. Stop the timer with `systemctl --user disable --now cleared-wake.timer`, wait for `cleared-wake.service` to finish, and rerun the installer.

Values in the example are invented for illustration. Replace model IDs, project names, paths, ticket states, and costs. The example guard salt is a placeholder. Generate a random salt, set `[guard] salt` in the project config, and commit it with the fingerprint lists. The installer does not create or store a salt. If no lists are configured, generic checks still run and the ledger records that private-term checks are disabled.

## `[models]`

Aliases used throughout the config. Each value is `adapter:model-id`; IDs must be available to the installed CLI.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `haiku` | Model alias and `adapter:model-id` target. | Required when referenced |
| `sonnet-5.5` | Model alias and `adapter:model-id` target. | Required when referenced |
| `opus-5.5` | Model alias and `adapter:model-id` target. | Required when referenced |
| `fable-5.1` | Model alias and `adapter:model-id` target. | Required when referenced |
| `codex` | Model alias and `adapter:model-id` target. | Required when referenced |
| `codex-heavy` | Model alias and `adapter:model-id` target. | Required when referenced |
| `gpt-6-sol` | Model alias and `adapter:model-id` target. | Required when referenced |

## `[fallbacks]`

For each alias, name a second alias to try only when the first cannot start. Cycles stop at the first repeated alias.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `haiku` | Alias to try if this model cannot start. | Required when referenced |
| `sonnet-5.5` | Alias to try if this model cannot start. | Required when referenced |
| `opus-5.5` | Alias to try if this model cannot start. | Required when referenced |
| `fable-5.1` | Alias to try if this model cannot start. | Required when referenced |
| `codex` | Alias to try if this model cannot start. | Required when referenced |
| `codex-heavy` | Alias to try if this model cannot start. | Required when referenced |
| `gpt-6-sol` | Alias to try if this model cannot start. | Required when referenced |

## `[roles]`

Map each role to a model alias. Roles without a matching rule use this choice.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `dev` | Default model alias for this role. | Required when referenced |
| `review` | Default model alias for this role. | Required when referenced |
| `release` | Default model alias for this role. | Required when referenced |
| `triage` | Default model alias for this role. | Required when referenced |
| `cleanup` | Default model alias for this role. | Required when referenced |
| `mechanical` | Default model alias for this role. | Required when referenced |
| `writing` | Default model alias for this role. | Required when referenced |
| `digest` | Default model alias for this role. | Required when referenced |
| `talk` | Default model alias for this role. | Required when referenced |

## `[rules]`

Ordered role overrides. A line is `<role> <conditions> -> <alias>`; conditions include `label=`, `project=`, `path=`, and `pr_lines>` or `<`.

| Syntax | Purpose |
| --- | --- |
| `<role> [conditions] -> <alias>` | First matching override for a role. Quote condition values containing spaces. |

## `[policy]`

Failure policy that applies to all adapters.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `guard_refusal` | `stop` or `fallback` after a provider guard refuses a run. | Default: stop |

## `[lead]`

Controls the project lead’s short observation sessions and wake conditions.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `role` | Role whose model runs the project lead. | Optional; no default |
| `live` | Allow the lead to call the configured live workflow scripts. | Default: no |
| `wake_on` | Comma-separated events that start a session; other events wait. | Optional; no default |
| `night_checks_event` | GitHub event names used for nightly checks. | Optional; no default |
| `night_ticket` | Project and label for a ticket opened after failed night checks. | Optional; no default |
| `not_lanes` | Branches excluded from lead monitoring. | Optional; no default |
| `terminals_kept` | How many recent lead terminals remain open. | Default: 3 |
| `max_minutes` | Maximum duration of one short lead session. | Default: 20 |
| `name` | Label used to sign agent messages. | Optional; no default |
| `report_on` | Ticket that receives lead reports and decisions. | Required |
| `report_hours` | Minimum interval for routine reports. | Default: 6 |
| `messages_per_lane_per_hour` | Rate limit for messages the lead sends to a team. | Default: 6 |

## `[review]`

Controls independent model review and rate limits.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `differs_from_author` | Require a reviewer model different from the author. | Default: yes |
| `when_same` | Fallback reviewer alias when the default matches the author. | Optional; no default |
| `author_role` | Role whose recorded run identifies the PR author. | Optional; no default |
| `per_hour` | Maximum reviews opened in an hour. | Default: 8 |

## `[merge]`

Classifies paths and sets the guarded shipping policy.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `tooling_paths` | Paths treated as routine tooling by the project policy. | Required |
| `guarded_paths` | Paths that always require the owner’s own approval. | Required |
| `code_paths` | Paths considered application code when comparing the base. | Required |
| `verdict` | Reviewer verdict required to ship, in English or legacy French. | Required |
| `lines_until` | Cutoff for old written `Fusion:` or `Merge:` approval lines. | Optional; no default |
| `separate_identity` | Require independently attributable agent and human actions. | Default: required |
| `queue_hours` | How long a blocked merge remains queued. | Default: 24 |
| `queue_max_attempts` | Maximum transient failures before a queued merge is refused and reported. A broker-busy reply does not count as a failure. | Default: 30 |

## `[release]`

Cleared watches the application's health after a merge it performs. Either `health_url` or `health_command` enables the watch. With neither, it records one skipped-watch event per release. Only `HTTP 200` counts as a healthy URL response. A command is run by the Cleared service account in the project checkout; exit code 0 counts as healthy. The watch begins after the grace period and probes every 30 seconds until the watch window ends. While it is watching or rolling back, another Cleared merge is queued.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `health_url` | HTTP(S) health endpoint. | Optional; no default |
| `health_command` | Shell command whose exit code reports health; alternative to URL. | Optional; no default |
| `watch_minutes` | Total window from the merge. | Default: 15 |
| `deploy_grace_minutes` | Delay before first probe. Must be less than the watch window. | Default: 5 |
| `failures_to_rollback` | Consecutive failed probes before action. | Default: 3 |
| `auto_rollback` | Revert the exact merge after repeated failures. | Default: false |
| `reopen_state` | Configured non-approval tracker status to use after a rollback. | Required before any rollback; no default |
| `migration_paths` | Comma-separated file or directory paths that disable automatic rollback when touched. | Optional; no default |

Automatic rollback requires a git credential that can push a normal commit to the base branch: with a GitHub App in [`[forge]`](#forge), the app's installation, which then needs Contents: write and, if a rule blocks direct pushes, to be allowed to bypass it. A branch protection rule that blocks direct pushes also blocks this rollback; Cleared reports that failure and never force pushes. CI runs on the revert push, but its result does not gate the push. Database migrations are never reversed: declare every migration path, and use `--force-with-migrations` only after assessing database compatibility. Manual rollback uses `cleared rollback TICKET` from the configured human Unix account. The CLI shows the ticket, merge commit and files before confirmation. `--yes` skips the confirmation prompt, but never the broker's peer-UID check. Tracker comments cannot authorize rollback.

## `[heartbeat]`

Optional push heartbeat for a monitoring service. Cleared sends a GET to `ping_url` after each successful wake. A failed wake or a detected stall sends a POST to `fail_url` with only stable problem codes. If `fail_url` is absent, a failed or blocked wake sends no ping; the monitoring service detects the missed heartbeat. A failed delivery never blocks the wake and is written to the ledger at most once per hour. URL files must be regular, owned by the service account, mode `0600` or stricter, and outside the project checkout. URLs require HTTPS, except for HTTP on loopback. See [Heartbeat and status](heartbeat.md).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `ping_url` | Push URL for a successful wake. | Optional; no default |
| `fail_url` | Push URL for a failed or blocked wake. | Optional; no default |
| `ping_url_file` | Path to a private file containing the success URL; alternative to `ping_url`. | Optional; no default |
| `fail_url_file` | Path to a private file containing the failure URL; alternative to `fail_url`. | Optional; no default |
| `timeout_secs` | Maximum delivery and probe time. | Default: 10 |
| `quota_url` | Optional quota API reachability probe. No auth headers are sent. | Optional; no default |
| `quota_url_file` | Private file containing the quota probe URL; alternative to `quota_url`. | Optional; no default |
| `wake_interval_minutes` | Configured wake timer interval; late after three intervals. | Default: 1 |
| `pending_minutes` | Time for observed changes without an action. | Default: 30 |
| `service_minutes` | Time tracker, forge, or configured quota endpoint may stay unreachable. | Default: 10 |
| `lane_idle_minutes` | Time without a lane branch or ledger movement. | Default: 120 |
| `orphan_hours` | Age before an unattached Cleared process is considered orphaned. | Default: 6 |
| `reap_owner_uid` | Unix UID allowed to run `status --reap`; required for non-local trackers. Must differ from `[tracker] agents_uid`. | Optional; no default |
If the monitor cannot start after a merge, Cleared comments on the ticket and records the failure; rerun `node lib/release.mjs start TICKET PR` after fixing the cause. A stopped monitor is restarted on the next wake. An interrupted revert is reconciled from its marked commit on the base; otherwise it is marked failed and the owner is alerted.

## `[limits]`

Caps concurrent teams, subscription use, ticket spending, and CLI age.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `max_lanes` | Maximum simultaneous counted worktrees. | Default: 1 |
| `counted_roles` | Roles that consume a lane slot. | Optional; no default |
| `subscription_stop` | Percentage at which no more teams open. | Default: 90 |
| `subscription_switch` | Percentage at which an alternate harness is preferred. | Default: 80 |
| `ticket_cost_usd` | Default cost cap per ticket in US dollars. | Optional; no default |
| `cli_max_days_behind` | Maximum age of a model CLI before a warning. | Default: 14 |

## `[memory]`

Memory is disabled unless the project opts in. With `enabled = false`, no briefing or handover text is added to a lane prompt. Memory stores machine entries beside the ledger and indexes project Markdown files in place. All paths must stay inside the project checkout. Only file content matching committed `HEAD` is briefed. Decision files remain proposals until a verified human approves their indexed entry; text inside a file never approves it. Cleared never edits these Markdown files.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `enabled` | Add a project memory briefing and collect a session handover. | Default: false |
| `budget` | Maximum briefing size in UTF-8 bytes. | Default: 12000 |
| `budget_<role>` | Optional size override for one role, such as `budget_dev`. | Falls back to `budget` |
| `decisions` | Directory of decision Markdown files, one entry per file. | Default: docs/decisions/ |
| `glossary` | Glossary Markdown file. | Default: docs/glossary.md |
| `project` | Project overview Markdown file. | Default: docs/project.md |
| `lessons` | Role lesson Markdown path; `<role>` is replaced with the lane role. | Default: .cleared/prompts/<role>/lessons.md |

The project overview, role lessons, latest ticket handover, up to five matching approved decisions, and matching glossary content are added in that order. A whole entry is included only if it fits. An absent or malformed `HANDOVER.md` is recorded and announced in the next briefing for that ticket. The lead handover prompt in `prompts/handover.md` is a separate project lead transition; it does not write ticket memory.

## `[guard]`

Project-specific guard data. Salt and fingerprint files are read from the same committed project ref. Fingerprint files include a `salt_id`; a mismatched salt or a file without that identifier stops the guard. See [Security](security.md) for the command that builds a list.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `salt` | Per-project salt for private-term fingerprints; generate a random value. | Required when fingerprint lists are configured |
| `terms` | Path to the project’s private-term fingerprint JSON, or `none`. | Optional; no default |
| `allowed` | Path to the project’s allowed-fingerprint JSON, or `none`. | Optional; no default |
| `token_patterns` | Comma-separated literal token prefixes specific to this project; generic patterns remain built in. | Optional; no default |

## `[update]`

Whether the installed tool and project checkout update on a wake.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `self` | Allow a clean tool checkout to fast-forward to its base. | Default: no |
| `project` | Allow a clean project checkout to fast-forward after shipping. | Default: no |

## `[harness]`

Optional alternate model alias for a role when two teams are requested or subscription pressure favors another provider.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `dev` | Alternate model alias for this role. | Required when referenced |
| `mechanical` | Alternate model alias for this role. | Required when referenced |

## `[lanes]`

Worktree layout, captures, checks, and cleanup settings.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `root` | Directory that holds project worktrees. | Required |
| `base` | Remote base branch for new teams. | Required |
| `push_roles` | Roles whose branches and pull requests are pushed. | Required |
| `todo_since` | Optional cutoff for tickets moved to Todo. | Optional; no default |
| `runs_per_day` | Maximum sessions per team in one day. | Default: 12 |
| `session_hours` | Time after which an open session is considered stale. | Default: 6 |
| `base_without_model` | Allow a clean base integration by script. | Default: yes |
| `rerun_steps` | CI steps that may be retried without waking a model. | Optional; no default |
| `kept_from` | Capture directory inside a team worktree. | Optional; no default |
| `kept_in` | Capture directory retained in the main project. | Optional; no default |
| `heavy_commands` | Commands serialized while host resources are busy. | Optional; no default |
| `heavy_wait_minutes` | How long a heavy command waits for the host. | Default: 30 |
| `tidy_hour` | Hour of day for cleanup. | Default: 6 |
| `idle_hours` | Time before an idle team may be cleaned up. | Default: 24 |
| `trial_prefixes` | Branch prefixes for disposable trial teams. | Optional; no default |
| `busy_states` | Ticket states that mean work is active. | Required |
| `closed_states` | Ticket states that close a team. | Required |
| `archives` | Where unpushed work is bundled before cleanup. | Required |
| `tidy_reason_live` | Reason recorded when shipped work is closed. | Optional; no default |
| `tidy_reason_idle` | Reason recorded when idle work is closed. | Optional; no default |
| `tidy_reason_trial` | Reason recorded when trial work is closed. | Optional; no default |
| `tidy_reason_waiting` | Reason recorded when work waits for approval. | Optional; no default |
| `tidy_summary` | Formatting template for a cleanup summary. | Optional; no default |

## `[terminal]`

Where team and project lead sessions run. An unknown value stops `spawn-lane.sh` and the wake with an error before anything is created.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `adapter` | `orca` opens each session in an Orca terminal under its worktree. `none` needs no terminal: each session starts detached, in its own process session, with output in `terminal.log` of its run folder. | Default: orca |

The harness always starts under `[security] agent_user`, whichever adapter is used. With `none`, the handle in a run folder's `terminal.handle` is `none:<pid>:<start>:<boot>`. Before signalling, Cleared checks that the process still has that start time and boot, and that its command line is a Cleared session script. It then sends SIGTERM to the session's process group, which includes the harness. A session started by the wake must outlive the `cleared-wake.service` oneshot unit, because systemd stops the processes of a unit when it ends. Cleared therefore starts it in its own transient scope of the user's systemd manager (`systemd-run --user --scope --collect`). The release watch also relies on that manager for its transient unit. Without a user manager, for example a script run by hand outside a login session, `setsid` alone detaches it. No unit file changes are needed.

With `none`, nobody can watch a session live or type in it. `tell-lane.sh <ticket>` keeps a message for the lane's next session. `adopt-lane.sh` and `tell-lane.sh <worktree name>` refuse because there is no terminal. `talk.sh` holds the conversation in the terminal it is run from and returns when it ends. Run without a terminal, it refuses and prints the command to run by hand. Worktree names shown by Orca are not set.

## `[owner]`

How Cleared addresses the human and which language its direct user messages use.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `name` | Human name in agent messages; blank means “the user”. | Default: the user |
| `language` | Language for user messages (`en` by default; `fr` included). | Default: en |

## `[tracker]`

Selects the ticket adapter, names the workflow states, and configures identity and captures. See [Ticket trackers](trackers.md).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `adapter` | `linear`, `github`, or `local`. | Required |
| `team` | Team key used by the Linear adapter. | Required for Linear |
| `create_project` | Project for tickets created by an agent through the contract. | Required for Linear creation unless supplied in the call |
| `create_label` | Label for those tickets when the call supplies none. | Required for Linear creation unless supplied in the call |
| `repository` | `owner/repo` for GitHub Issues. | Required for GitHub |
| `project_v2_id` | Optional GitHub Project v2 node ID; otherwise status labels are used. | Optional |
| `app_login` | Login of the GitHub App bot that writes agent actions. | Required for GitHub approval attribution |
| `app_id` | Numeric GitHub App ID used to sign short-lived JWTs. | Required for GitHub |
| `installation_id` | Numeric installation ID for the configured repository. | Required for GitHub |
| `app_private_key_file` | Absolute path to the App RSA private key, outside the repository, owned by Cleared with mode `0600`. | Required for GitHub |
| `agents_uid` | System UID of the dedicated Cleared account. | Required for local |
| `human_private_key` | Absolute path to the human account’s Ed25519 private key. | Required for local human actions |
| `human_public_key` | Base64 encoded PEM public key used to verify local actions. | Required for local approval |
| `capture_branch` | Git branch used to store guarded GitHub captures. | Default: `cleared-captures` |
| `capture_base` | Branch used when the capture branch is first created. | Default: `main` |
| `writeup_role` | Role that formats an agent report for the user. | Optional; no default |
| `writeup_for` | Roles whose reports get formatted. | Optional; no default |
| `comments_per_hour` | Maximum Cleared comments on one ticket in an hour. | Default: 6 |
| `owner_id` | Human user ID or login used to verify the approver. | Required when separate identity is required |
| `validate_state` | State used while waiting for human approval. | Required |
| `go_state` | State the owner moves a ticket to when approving shipment. | Required |
| `done_state` | State after shipment. | Required |
| `progress_state` | State while a team works. | Required |
| `review_state` | State during independent review. | Required |
| `todo_state` | State that starts work. | Required |
| `capture_roots` | Allowed roots for capture images; GitHub upload requires OCR and guard approval. | Optional; no default |

## `[forge]`

Which GitHub identity the forge calls use: pushing and fetching branches, opening, reading, readying, closing and merging pull requests, reading and rerunning checks, the rollback revert push, and the commits the dispatcher makes after a session (or when it brings the base into a lane, saves work before closing a lane, or transcribes a decision). With no GitHub App configured, those calls use the service account's own `gh` login and git credentials, as before. With one, they go through the app: pull requests, pushes, merges and dispatcher commits show as its bot. The keys apply whatever the tracker is (Linear, GitHub Issues or local).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `adapter` | Forge in use. Only `github` exists, and it is what an absent key means. | Optional; no default (`github`) |
| `app_id` | Numeric GitHub App ID used to sign short-lived JWTs. | Optional; no default |
| `installation_id` | Numeric ID of the app's installation on the project repository. | Required with `app_id` |
| `app_private_key_file` | Absolute path to the app's RSA private key, outside the repository, owned by the service account with mode `0600`. | Required with `app_id` |
| `app_login` | The bot login of the app, `<app slug>[bot]`; commit author and committer name. | Required with `app_id` |
| `app_user_id` | The numeric GitHub user ID of that bot; the commit email is `<app_user_id>+<app_login>@users.noreply.github.com`. | Required with `app_id` |
| `use_tracker_app` | `yes` lends the app of `[tracker] adapter = github` to the forge when `[forge]` has no app keys of its own. | Optional; no default (`no`) |

With `use_tracker_app = yes` and no `app_id`, `installation_id` or `app_private_key_file` in `[forge]`, the app of `[tracker] adapter = github` is used for both, with `[tracker] app_login` as the bot login. It is never used for the forge without that line: an installation of the GitHub Issues tracker keeps its ambient forge credential after an upgrade until its owner opts in, after granting the installation the permissions below. Add `[forge] app_user_id` so the dispatcher's commits carry the bot's identity; without it they keep the local git identity and `cleared status` says so. The bot's user ID is public: `gh api '/users/<app slug>%5Bbot%5D' --jq .id` (the brackets of `[bot]` are URL-encoded) or `curl -s 'https://api.github.com/users/<app slug>%5Bbot%5D'`.

Cleared mints an installation token from the key, keeps it in the state directory (`forge/installation-token.json`, mode `0600`, in a `0700` directory the agents' account cannot read) and reuses it until five minutes before it expires; [GitHub installation tokens expire after one hour](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). `gh` receives it in `GH_TOKEN` for each call only; git receives it through a credential helper declared in `GIT_CONFIG_*` for `https://github.com` (user name `x-access-token`), which replaces the account's own git credential helpers for that host. A remote written as `git@github.com:` is sent over HTTPS so that it uses the app as well. The service account's and the system's git configuration files are then not read by the scripts (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), so a `url.<ssh>.insteadOf` or `pushInsteadOf` there cannot send a push to SSH with the account's key; only their `user.name`, `user.email`, `safe.directory` and `credential.*` settings (for other hosts) are carried over. Neither the user's git configuration nor the project's is written. Keep `GH_DEBUG`, `GIT_TRACE`, `GIT_TRACE_CURL` and `GIT_CURL_VERBOSE` out of the service environment: they print the `Authorization` header into run logs. The model adapters remove these variables before starting a harness. If the key is missing or too open, the IDs are wrong, the app is suspended or uninstalled, or GitHub cannot be reached, every forge call stops with a message that names the setting to check, a `forge_token_failed` event is recorded once an hour, and `cleared status` reports `forge_credential`; Cleared never falls back to the ambient credential. The fetch the tool does to update itself (`[update] self`) also goes through the app when the tool's checkout is hosted on GitHub: keep that repository public or install the app on it.

The installation needs the following repository permissions. The minimum set is Metadata read, Contents write, Pull requests write, Checks read, Statuses read, Actions read and Workflows write.

| Feature | GitHub calls | Permission |
| --- | --- | --- |
| Every call | all | Metadata: read |
| Push a lane's branch, fetch, push the rollback revert | `git push`, `git fetch`, `git ls-remote` | Contents: write |
| Push or merge a change to `.github/workflows/` | `git push`, `gh pr merge` | Workflows: write |
| Open, list, read, ready, close pull requests | `gh pr create`, `list`, `view`, `ready`, `close` | Pull requests: write |
| Merge after approval (release broker) | `gh pr merge` | Pull requests: write and Contents: write |
| Read check results of a pull request | `gh pr view --json statusCheckRollup` | Checks: read and Statuses: read |
| Read CI runs, jobs and failed logs; host state; nightly checks | `gh run list`, `gh run view` | Actions: read |
| Last commit date on the base (host state) | `gh api repos/{owner}/{repo}/commits/...` | Contents: read |
| Start failed checks again (`[lanes] rerun_steps`) | `gh run rerun --failed` | Actions: write |
| `cleared status` identity probe | `gh api /installation/repositories` | Metadata: read |

With the minimum set, `gh run rerun` is refused with HTTP 403: `flow-lanes.sh` records `checks_rerun_refused` naming Actions: write and hands the failure to the lane, as for any rerun that cannot start. Grant Actions: write to restore the automatic rerun. When the GitHub Issues tracker shares the app, it also needs Issues: write (and Projects: write with `project_v2_id`).

## `[permissions.dev]`

Provider CLI permission profile for this role. See the [role mapping](adapters.md#existing-adapters) and [host access](security.md#permissions-and-host-access).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[permissions.mechanical]`

Provider CLI permission profile for this role. See the [role mapping](adapters.md#existing-adapters) and [host access](security.md#permissions-and-host-access).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[permissions.release]`

Provider CLI permission profile for this role. See the [role mapping](adapters.md#existing-adapters) and [host access](security.md#permissions-and-host-access).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `advisor` | Whether the CLI may use a separately billed helper model. | Optional; no default |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[permissions.release-live]`

Provider CLI permission profile for this role. See the [role mapping](adapters.md#existing-adapters) and [host access](security.md#permissions-and-host-access).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `write` | Paths that trusted scripts need to write, comma separated; `{state}` and `{repo}` expand to the configured paths. Host Codex refuses read-only roles with this setting. | Optional; no default |
| `read` | Extra paths the role may read. | Optional; no default |
| `advisor` | Whether the CLI may use a separately billed helper model. | Optional; no default |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[talk]`

Interactive discussion role.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `role` | Role and permission profile used by an interactive discussion. | Optional; no default |

## `[permissions.talk]`

Provider CLI permission profile for this role. See the [role mapping](adapters.md#existing-adapters) and [host access](security.md#permissions-and-host-access).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `write` | Paths that trusted scripts need to write, comma separated; `{state}` and `{repo}` expand to the configured paths. Host Codex refuses read-only roles with this setting. | Optional; no default |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[permissions.review]`

Provider CLI permission profile for this role. See the [role mapping](adapters.md#existing-adapters) and [host access](security.md#permissions-and-host-access).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

Define a permission section for every role routed to a harness; otherwise the two CLIs can inherit different defaults.

## `[permissions.triage]`

Read-only example profile for the triage role.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |

## `[permissions.cleanup]`

Read-only example profile for the cleanup role.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |
| `allow` | Comma-separated command prefixes allowed by the role. | Optional; no default |

## `[permissions.writing]`

Read-only example profile for the writing role.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[permissions.digest]`

Read-only example profile for the digest role.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. | Required when role runs |
| `network` | Whether the Codex host sandbox allows network access (`yes` or `no`). | Default: no |
| `deny` | Comma-separated command prefixes denied by the role. | Optional; no default |

## `[adapter.claude]`

Claude Code CLI package and process options.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `package` | npm package whose latest version is checked. | Optional; no default |
| `connectors` | Connector setting passed to the Claude adapter. | Optional; no default |
| `process` | Executable used to start Claude Code. | Optional; no default |
| `deny_tools` | Provider tools disabled for this adapter. | Optional; no default |

## `[adapter.codex]`

Codex CLI on the host by default, or a project-owned container task script.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `package` | npm package whose latest version is checked. | Optional; no default |
| `process` | Executable used to start Codex. | Optional; no default |
| `runner` | `host` or `container`. | Default: host |
| `task_script` | Executable in the project called with `<worktree> <prompt-file> <model> [--tools]` in container mode. | Required for container mode |
| `task_tools` | Whether container sessions receive tools through the task script. | Optional; no default; ignored on host |
| `commits` | Whether the container adapter commits its own work. | Optional; no default; ignored on host |

## `[dashboard]`

Time display and warning threshold for the static dashboard.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `timezone` | IANA timezone for dates. | Default: UTC |
| `timezone_label` | Short label shown beside dates. | Default: UTC |
| `warn_days` | CLI or subscription warning lead time in days. | Default: 14 |

## `[subscriptions]`

Subscription period ends used in the dashboard; `ongoing` means no known end date.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `codex` | Subscription end date or `ongoing` for this provider. | Required when referenced |
| `claude` | Subscription end date or `ongoing` for this provider. | Required when referenced |

## `[prices]`

API list prices per million tokens. Values are input, output, cache read, short cache write, and long cache write; absent prices stay unknown.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `claude-haiku-4-5-20251001` | Token price row for this model ID. | Required when referenced |
| `claude-sonnet-5-5` | Token price row for this model ID. | Required when referenced |
| `claude-opus-5-5` | Token price row for this model ID. | Required when referenced |
| `claude-fable-5-1` | Token price row for this model ID. | Required when referenced |

## `[currency]`

Rate used only to express estimated costs in euros.

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `usd_eur` | USD-to-EUR multiplier for estimated costs. | Optional; no default |

## Related workflows

- [Ticket lifecycle and caps](concepts.md)
- [Adapter and Codex task script contract](adapters.md)
- [Identity, guard, and permission limits](security.md)

## `[app]`

The Cleared app. It reads the board snapshot and the ledger the last wake recorded (it never runs `cleared status`); its only writes are the three gestures of the human (clear to land, send back, answer), made under the human's own identity. See [The Cleared app](app.md).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `bind` | Address the app listens on. Use the Tailscale address to reach it from a phone; the installer does this. | Default: 127.0.0.1 |
| `port` | Port the app listens on. | Default: 8788 |
| `ranges` | Peers allowed to connect, as CIDR ranges separated by spaces or commas. | Optional; no default (Tailscale ranges and this machine are used) |
| `hosts` | Extra host names the browser may use, besides addresses, `localhost` and `*.ts.net`. | Optional; no default |
| `token_file` | Private file (mode `0600`, owned by the service account, outside the project) holding the access token. Created on first start if missing. | Optional; no default (`~/.config/cleared/app-token` is used) |
| `public_origin` | The address the browser opens the app at, for example `https://machine.tailnet.ts.net` (from `tailscale serve`). Passkeys need `https` (or `http://localhost`); its host is the passkey's relying party. When set, a write is refused unless it carries this origin. | Required for the gestures; no default |
| `human_credentials_dir` | Absolute path of a private directory (mode `0700`, owned by the app's account, outside the project and the checkout, unreadable by the agents' account) holding `credentials.json` (the human's user token, keyed by adapter name), `human-signing.key` (local tracker) and `passkeys.json`. | Optional; default `~/.config/cleared/human` |
| `grant_socket` | Absolute path of the Unix socket `cleared app passkey` asks for a one-time registration grant. Its parent must be owned by the app's account, not writable by others, and traversable by the human. Only the human's UID is answered. | Required to register a passkey; no default |
| `sent_back_state` | Tracker status a ticket is put in by *Send back*. Never the approval, agreement or done status. | Optional; default `[tracker] progress_state` |

## `[security]`

| Setting | Meaning | Requirement |
| --- | --- | --- |
| `agent_user` | System account used for both Claude Code and Codex processes. Set it to a distinct account and grant that account worktree access without Cleared state write access. | Optional; no default |
| `allow_shared_uid` | Explicitly allow release and manual rollback without `agent_user`. The lock is then not a security boundary and `cleared status` keeps a permanent warning. | Default: false |
| `human_user` | Unix account permitted to run `cleared rollback` through the broker. Required for manual rollback with a remote tracker in split-account mode; the local tracker defaults to `[tracker] owner_id`. In explicit shared-UID mode the service UID is accepted if omitted. Must differ from `agent_user`. | Optional; no default |
| `socket_path` | Absolute local Unix socket path for the service-owned release broker. Required when `agent_user` is set; its parent must be traversable by that account. | Optional; no default |
| `bwrap_path` | Bubblewrap executable used to mount shared Git metadata read-only inside agent processes. | Optional; no default |

See [the release lock installation guide](security.md#installing-the-release-account-boundary) for account creation, ownership checks, and the Codex socket path.
