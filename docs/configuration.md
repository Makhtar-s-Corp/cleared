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

Automatic rollback requires a git credential that can push a normal commit to the base branch. A branch protection rule that blocks direct pushes also blocks this rollback; Cleared reports that failure and never force pushes. CI runs on the revert push, but its result does not gate the push. Database migrations are never reversed: declare every migration path, and use `--force-with-migrations` only after assessing database compatibility. Manual rollback uses `cleared rollback TICKET`; a remote tracker owner may provide `--approval-comment COMMENT_ID` after posting exactly `Rollback TICKET MERGE_SHA` on the ticket. The CLI shows the ticket, merge commit and files before confirmation. `--yes` skips the confirmation prompt, but never identity verification.

## `[heartbeat]`

Optional push heartbeat for a monitoring service. Cleared sends a GET to `ping_url` after each successful wake. A failed wake or a detected stall sends a POST to `fail_url` with only stable problem codes. If `fail_url` is absent, a failed or blocked wake sends no ping; the monitoring service detects the missed heartbeat. A failed delivery never blocks the wake and is written to the ledger at most once per hour. See [Heartbeat and status](heartbeat.md).

| Key | Purpose | Requirement or default |
| --- | --- | --- |
| `ping_url` | Push URL for a successful wake. | Optional; no default |
| `fail_url` | Push URL for a failed or blocked wake. | Optional; no default |
| `ping_url_file` | Path to a private file containing the success URL; alternative to `ping_url`. | Optional; no default |
| `fail_url_file` | Path to a private file containing the failure URL; alternative to `fail_url`. | Optional; no default |
| `timeout_secs` | Maximum delivery and probe time. | Default: 10 |
| `quota_url` | Optional quota API reachability probe. No auth headers are sent. | Optional; no default |
| `wake_interval_minutes` | Configured wake timer interval; late after three intervals. | Default: 1 |
| `pending_minutes` | Time for observed changes without an action. | Default: 30 |
| `service_minutes` | Time tracker, forge, or configured quota endpoint may stay unreachable. | Default: 10 |
| `lane_idle_minutes` | Time without a lane branch or ledger movement. | Default: 120 |
| `orphan_hours` | Age before an unattached Cleared process is considered orphaned. | Default: 6 |
| `reap_owner_uid` | Unix UID allowed to run `status --reap`; required for non-local trackers. Must differ from `[tracker] agents_uid`. | Optional; no default |
The approval comment must be unedited, posted after the merge, and no more than ten minutes old when used. If the monitor cannot start after a merge, Cleared comments on the ticket and records the failure; rerun `node lib/release.mjs start TICKET PR` after fixing the cause. A stopped monitor is restarted on the next wake. An interrupted revert is reconciled from its marked commit on the base; otherwise it is marked failed and the owner is alerted.

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
