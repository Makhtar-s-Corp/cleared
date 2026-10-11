# Configuration reference

Copy [`agents.example.conf`](../agents.example.conf) to `<project>/.cleared/agents.conf` and change it for the project. Cleared reads a project setting first and the example for missing keys. A full existing project config keeps its values. `[rules]` is replaced as a whole when the project declares it; most other sections overlay key by key. The parser uses `key = value` lines and full-line `#` comments; it does not strip quotes from a value. Do not put secrets in this file.

For an older project, `.ferme/agents.conf`, `~/.local/state/ferme/<project>/`, and `ferme-*` services remain usable when the Cleared paths are absent. `./migrate-from-ferme.sh --dry-run` prints proposed copies; `--apply` copies without deleting old files. The tool records a `legacy_path_used` ledger event once. New environment names use `CLEARED_*`; older `ORCH_*` names remain accepted. `CLEARED_REPO`, `CLEARED_CONF`, and `CLEARED_STATE_DIR` override discovery. `serve/install.sh` binds services to a single project and requires Tailscale; `spawn-lane.sh` can be run manually without those services.

Values in the example are invented for illustration. Replace model IDs, project names, paths, ticket states, and costs. The example guard salt is a placeholder; `serve/install.sh` generates a random project salt when it is missing or still the placeholder. To run without the service installer, generate and save a random salt yourself.

## `[models]`

Aliases used throughout the config. Each value is `adapter:model-id`; IDs must be available to the installed CLI.

| Key | Purpose |
| --- | --- |
| `haiku` | Model alias and `adapter:model-id` target. |
| `sonnet-5.5` | Model alias and `adapter:model-id` target. |
| `opus-5.5` | Model alias and `adapter:model-id` target. |
| `fable-5.1` | Model alias and `adapter:model-id` target. |
| `codex` | Model alias and `adapter:model-id` target. |
| `codex-heavy` | Model alias and `adapter:model-id` target. |
| `gpt-6-sol` | Model alias and `adapter:model-id` target. |

## `[fallbacks]`

For each alias, name a second alias to try only when the first cannot start. Cycles stop at the first repeated alias.

| Key | Purpose |
| --- | --- |
| `haiku` | Alias to try if this model cannot start. |
| `sonnet-5.5` | Alias to try if this model cannot start. |
| `opus-5.5` | Alias to try if this model cannot start. |
| `fable-5.1` | Alias to try if this model cannot start. |
| `codex` | Alias to try if this model cannot start. |
| `codex-heavy` | Alias to try if this model cannot start. |
| `gpt-6-sol` | Alias to try if this model cannot start. |

## `[roles]`

Map each role to a model alias. Roles without a matching rule use this choice.

| Key | Purpose |
| --- | --- |
| `dev` | Default model alias for this role. |
| `review` | Default model alias for this role. |
| `release` | Default model alias for this role. |
| `triage` | Default model alias for this role. |
| `cleanup` | Default model alias for this role. |
| `mechanical` | Default model alias for this role. |
| `writing` | Default model alias for this role. |
| `digest` | Default model alias for this role. |
| `talk` | Default model alias for this role. |

## `[rules]`

Ordered role overrides. A line is `<role> <conditions> -> <alias>`; conditions include `label=`, `project=`, `path=`, and `pr_lines>` or `<`.

| Syntax | Purpose |
| --- | --- |
| `<role> [conditions] -> <alias>` | First matching override for a role. Quote condition values containing spaces. |

## `[policy]`

Failure policy that applies to all adapters.

| Key | Purpose |
| --- | --- |
| `guard_refusal` | `stop` or `fallback` after a provider guard refuses a run. |

## `[lead]`

Controls the project lead’s short observation sessions and wake conditions.

| Key | Purpose |
| --- | --- |
| `role` | Role whose model runs the project lead. |
| `live` | Allow the lead to call the configured live workflow scripts. |
| `wake_on` | Comma-separated events that start a session; other events wait. |
| `night_checks_event` | GitHub event names used for nightly checks. |
| `night_ticket` | Project and label for a ticket opened after failed night checks. |
| `not_lanes` | Branches excluded from lead monitoring. |
| `terminals_kept` | How many recent lead terminals remain open. |
| `max_minutes` | Maximum duration of one short lead session. |
| `name` | Label used to sign agent messages. |
| `report_on` | Ticket that receives lead reports and decisions. |
| `report_hours` | Minimum interval for routine reports. |
| `messages_per_lane_per_hour` | Rate limit for messages the lead sends to a team. |

## `[review]`

Controls independent model review and rate limits.

| Key | Purpose |
| --- | --- |
| `differs_from_author` | Require a reviewer model different from the author. |
| `when_same` | Fallback reviewer alias when the default matches the author. |
| `author_role` | Role whose recorded run identifies the PR author. |
| `per_hour` | Maximum reviews opened in an hour. |

## `[merge]`

Classifies paths and sets the guarded shipping policy.

| Key | Purpose |
| --- | --- |
| `tooling_paths` | Paths treated as routine tooling by the project policy. |
| `guarded_paths` | Paths that always require the owner’s own approval. |
| `code_paths` | Paths considered application code when comparing the base. |
| `verdict` | Reviewer verdict required to ship, in English or legacy French. |
| `lines_until` | Cutoff for old written `Fusion:` or `Merge:` approval lines. |
| `separate_identity` | Whether the agent must have a separate Linear application identity. |
| `queue_hours` | How long a blocked merge remains queued. |

## `[limits]`

Caps concurrent teams, subscription use, ticket spending, and CLI age.

| Key | Purpose |
| --- | --- |
| `max_lanes` | Maximum simultaneous counted worktrees. |
| `counted_roles` | Roles that consume a lane slot. |
| `subscription_stop` | Percentage at which no more teams open. |
| `subscription_switch` | Percentage at which an alternate harness is preferred. |
| `ticket_cost_usd` | Default cost cap per ticket in US dollars. |
| `cli_max_days_behind` | Maximum age of a model CLI before a warning. |

## `[guard]`

Project-specific guard data. Fingerprint files belong to the project and are read from its remote base branch.

| Key | Purpose |
| --- | --- |
| `salt` | Per-project salt for private-term fingerprints; generate a random value. |
| `terms` | Path to the project’s private-term fingerprint JSON, or `none`. |
| `allowed` | Path to the project’s allowed-fingerprint JSON, or `none`. |

## `[update]`

Whether the installed tool and project checkout update on a wake.

| Key | Purpose |
| --- | --- |
| `self` | Allow a clean tool checkout to fast-forward to its base. |
| `project` | Allow a clean project checkout to fast-forward after shipping. |

## `[harness]`

Optional alternate model alias for a role when two teams are requested or subscription pressure favors another provider.

| Key | Purpose |
| --- | --- |
| `dev` | Alternate model alias for this role. |
| `mechanical` | Alternate model alias for this role. |

## `[lanes]`

Worktree layout, captures, checks, and cleanup settings.

| Key | Purpose |
| --- | --- |
| `root` | Directory that holds project worktrees. |
| `base` | Remote base branch for new teams. |
| `push_roles` | Roles whose branches and pull requests are pushed. |
| `todo_since` | Optional cutoff for tickets moved to Todo. |
| `runs_per_day` | Maximum sessions per team in one day. |
| `session_hours` | Time after which an open session is considered stale. |
| `base_without_model` | Allow a clean base integration by script. |
| `rerun_steps` | CI steps that may be retried without waking a model. |
| `kept_from` | Capture directory inside a team worktree. |
| `kept_in` | Capture directory retained in the main project. |
| `heavy_commands` | Commands serialized while host resources are busy. |
| `heavy_wait_minutes` | How long a heavy command waits for the host. |
| `tidy_hour` | Hour of day for cleanup. |
| `idle_hours` | Time before an idle team may be cleaned up. |
| `trial_prefixes` | Branch prefixes for disposable trial teams. |
| `busy_states` | Ticket states that mean work is active. |
| `closed_states` | Ticket states that close a team. |
| `archives` | Where unpushed work is bundled before cleanup. |
| `tidy_reason_live` | Reason recorded when shipped work is closed. |
| `tidy_reason_idle` | Reason recorded when idle work is closed. |
| `tidy_reason_trial` | Reason recorded when trial work is closed. |
| `tidy_reason_waiting` | Reason recorded when work waits for approval. |
| `tidy_summary` | Formatting template for a cleanup summary. |

## `[owner]`

How Cleared addresses the human and which language its direct user messages use.

| Key | Purpose |
| --- | --- |
| `name` | Human name in agent messages; blank means “the user”. |
| `language` | Language for user messages (`en` by default; `fr` included). |

## `[linear]`

Linear team, ticket states, message limits, and captures.

| Key | Purpose |
| --- | --- |
| `team` | Linear team key used in ticket IDs. |
| `writeup_role` | Role that formats an agent report for the user. |
| `writeup_for` | Roles whose reports get formatted. |
| `comments_per_hour` | Maximum Cleared comments on one ticket in an hour. |
| `owner_id` | Linear user ID used to verify the human approver. |
| `validate_state` | State used while waiting for human approval. |
| `go_state` | State the owner moves a ticket to when approving shipment. |
| `done_state` | State after shipment. |
| `progress_state` | State while a team works. |
| `review_state` | State during independent review. |
| `todo_state` | State that starts work. |
| `capture_roots` | Allowed roots for images uploaded to Linear. |

## `[permissions.dev]`

Provider CLI permission profile for this role. These settings are not a sandbox.

| Key | Purpose |
| --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. |
| `allow` | Comma-separated command prefixes allowed by the role. |
| `deny` | Comma-separated command prefixes denied by the role. |

## `[permissions.mechanical]`

Provider CLI permission profile for this role. These settings are not a sandbox.

| Key | Purpose |
| --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. |
| `allow` | Comma-separated command prefixes allowed by the role. |
| `deny` | Comma-separated command prefixes denied by the role. |

## `[permissions.release]`

Provider CLI permission profile for this role. These settings are not a sandbox.

| Key | Purpose |
| --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. |
| `advisor` | Whether the CLI may use a separately billed helper model. |
| `allow` | Comma-separated command prefixes allowed by the role. |
| `deny` | Comma-separated command prefixes denied by the role. |

## `[permissions.release-live]`

Provider CLI permission profile for this role. These settings are not a sandbox.

| Key | Purpose |
| --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. |
| `read` | Extra paths the role may read. |
| `advisor` | Whether the CLI may use a separately billed helper model. |
| `allow` | Comma-separated command prefixes allowed by the role. |
| `deny` | Comma-separated command prefixes denied by the role. |

## `[talk]`

Interactive discussion role.

| Key | Purpose |
| --- | --- |
| `role` | Role and permission profile used by an interactive discussion. |

## `[permissions.talk]`

Provider CLI permission profile for this role. These settings are not a sandbox.

| Key | Purpose |
| --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. |
| `allow` | Comma-separated command prefixes allowed by the role. |
| `deny` | Comma-separated command prefixes denied by the role. |

## `[permissions.review]`

Provider CLI permission profile for this role. These settings are not a sandbox.

| Key | Purpose |
| --- | --- |
| `mode` | `read-only` or `accept-edits` for the provider CLI. |
| `allow` | Comma-separated command prefixes allowed by the role. |
| `deny` | Comma-separated command prefixes denied by the role. |

## `[adapter.claude]`

Claude Code CLI package and process options.

| Key | Purpose |
| --- | --- |
| `package` | npm package whose latest version is checked. |
| `connectors` | Connector setting passed to the Claude adapter. |
| `process` | Executable used to start Claude Code. |
| `deny_tools` | Provider tools disabled for this adapter. |

## `[adapter.codex]`

Codex CLI and the project-owned task script.

| Key | Purpose |
| --- | --- |
| `package` | npm package whose latest version is checked. |
| `process` | Executable used to start Codex. |
| `task_script` | Executable in the project called with `<worktree> <prompt-file> <model> [--tools]`. |
| `task_tools` | Whether work sessions receive tools through the task script. |
| `commits` | Whether the adapter commits its own work. |

## `[dashboard]`

Time display and warning threshold for the static dashboard.

| Key | Purpose |
| --- | --- |
| `timezone` | IANA timezone for dates. |
| `timezone_label` | Short label shown beside dates. |
| `warn_days` | CLI or subscription warning lead time in days. |

## `[subscriptions]`

Subscription period ends used in the dashboard; `ongoing` means no known end date.

| Key | Purpose |
| --- | --- |
| `codex` | Subscription end date or `ongoing` for this provider. |
| `claude` | Subscription end date or `ongoing` for this provider. |

## `[prices]`

API list prices per million tokens. Values are input, output, cache read, short cache write, and long cache write; absent prices stay unknown.

| Key | Purpose |
| --- | --- |
| `claude-haiku-4-5-20251001` | Token price row for this model ID. |
| `claude-sonnet-5-5` | Token price row for this model ID. |
| `claude-opus-5-5` | Token price row for this model ID. |
| `claude-fable-5-1` | Token price row for this model ID. |

## `[currency]`

Rate used only to express estimated costs in euros.

| Key | Purpose |
| --- | --- |
| `usd_eur` | USD-to-EUR multiplier for estimated costs. |

## Related workflows

- [Ticket lifecycle and caps](concepts.md)
- [Adapter and Codex task script contract](adapters.md)
- [Identity, guard, and permission limits](security.md)
