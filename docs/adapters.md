# Model adapters

An adapter is an executable `adapters/<name>.sh`. Routing uses `[models] alias = adapter:model-id`; dispatch scripts name neither provider nor model. `lib/contract.sh` contains the shared report helpers. An adapter can be added without changing the dispatcher when it implements the commands below and declares its model IDs in the project configuration.

| Command | Required behavior |
| --- | --- |
| `list-models [id...]` | Print runnable model IDs, one per line, optionally limited to candidates. An unavailable CLI prints no IDs. |
| `version` | Print one JSON object with `cli`, `installed`, `latest`, and `days_behind` (null when unknown). |
| `run --model ID --prompt-file FILE --report FILE --usage FILE` | Work in the current worktree, save a `lane-report/1` report and usage JSON, and return an exit code below. |
| `talk --model ID --prompt-file FILE [--session-id UUID]` | Optional interactive session in the current terminal. Return 2 when unavailable here. |

`run` exits 0 after a completed run, 2 if nothing reached the model, 3 if the provider's own guard refused the task, 5 when a configured budget stopped the run, and another nonzero code for a failure. Only code 2 triggers the normal fallback chain. Code 3 follows `[policy] guard_refusal`; an ordinary failure is reported without trying another model. The report has YAML-like front matter with run ID, lane, ticket, role, selected and actual model, outcome, times, exit code, and usage fields, followed by `## Report` and `## Changed files`. Readers also accept the earlier French headings. `usage.json` can contain `model`, token counts, `cost_usd`, and provider limits; unknown values remain null.

A model used for `review` must differ from the one recorded as the pull request's author. A review runs read-only, has its own worktree, and should not run tests or edit the change. The CLI's tool permissions are mapped from `[permissions.<role>]`; the host and any containers still need their own isolation. See [Security](security.md).

## Existing adapters

`adapters/claude.sh` invokes Claude Code on the host. `adapters/codex.sh` invokes Codex on the host by default, in the same lane worktree. Both work in the same lane with its linked dependencies, host-installed browser and test database, heavy-command gate, and capture directory. Provider-specific browser tools still depend on each CLI configuration. A host Codex session holds the heavy-command slot for its entire run and commits its own changes; `task_tools` and `commits` apply only to the container runner. Set `[adapter.codex] runner = container` to use the project's executable named by `task_script`.

| Role | Claude Code CLI | Codex CLI on host |
| --- | --- | --- |
| `dev`, `mechanical` | `acceptEdits`, configured allowed and denied Bash prefixes, no approval prompt | `:workspace` profile, lane worktree writable, the lane Git directory and its branch namespace writable for commits, network enabled for the local test database, `approval_policy=never` |
| `release`, `review` | Edit/Write denied, configured Bash prefixes | `:read-only` profile, network disabled, `approval_policy=never` |
| `triage`, `cleanup`, `writing`, `digest` | Edit/Write denied; optional Bash prefixes from each role | `:read-only` profile, network disabled, `approval_policy=never` |
| `release-live` | Edit/Write denied; trusted lead scripts from `allow` can update state or merge | `:read-only` plus configured state and project repository write paths for trusted scripts, network enabled, `approval_policy=never` |
| `talk` | Edit/Write denied; configured decision scripts can update state | Interactive discussion is unavailable; the adapter returns 2 so routing can try another harness. |

These rows come from the same `[permissions.<role>]` section. `mode` selects read-only or workspace writing; `network` selects Codex sandbox network access; `write` grants explicit paths needed by trusted scripts. The example config gives `network = yes` to development roles for TCP test databases and to the live lead and talk roles. Review and read-only support roles use `network = no`. Network-on allows external destinations too; Codex cannot limit this to a local database without a separately configured proxy or host firewall. A role with no permission section retains Claude's user settings and gets Codex's read-only default; define the section if you route that role to either harness.

The CLIs enforce different things. Claude receives an allowed command-prefix list but its CLI permissions are not OS isolation and a permitted command can reach the network. Codex has no equivalent command allowlist: its [OS sandbox profile](https://learn.chatgpt.com/codex/permissions) limits writes and network access, but a process can run any installed command within those boundaries. Both run under the Cleared account. The Codex profile hides common credential stores and the ledger from development roles, but any other readable file may be reached by commands. Noninteractive Codex runs ignore the user config to keep the selected permission profile effective, so user-configured MCP tools are not inherited. Interactive Codex discussion is unavailable from this adapter and returns 2 for the configured fallback. A text-only Codex run remains read-only and ephemeral, but its CLI still offers a shell tool; Claude disables tools entirely for that path. Network-enabled roles and project tests can still contact external services. Development roles receive a private temporary directory inside their lane Git directory. Git control files (`commondir`, `HEAD`, `config.worktree`) and object-store metadata are read-only; existing sibling branch refs in the same namespace are denied. The shared loose-object store and parent branch namespace remain writable for commits, so a model can still damage objects or create new refs there. Keep independent Git backups and limit access to the account running Cleared. The `release-live` write exception covers the project checkout as well as the ledger because trusted merge scripts need both; it is broader than the review role. Neither CLI's settings replace a dedicated operating-system account or a human review.

The optional container task script receives `<worktree> <prompt-file> <model> [--tools]`. It must run Codex in the environment chosen by the project, leave file changes in that worktree, print the model's answer on stdout, and print usage records such as `token usage <json>` and `rate limits <json>` on stderr when available. Exit 0 means success, 2 means no session started, and 3 means a provider guard refusal. With `task_tools = yes`, list the script in `[lanes] heavy_commands` so it waits for the host's heavy-command gate. With `commits = no`, the dispatcher commits returned changes under the model's `.commit-message` or a fallback title. The container is project-owned; Cleared does not embed its recipe or promise that it follows host permissions.

## Add an adapter

1. Copy the command structure of an existing adapter and source `lib/contract.sh` for `run` reports and usage.
2. Make `list-models` report only IDs that can start now. Keep `version` fast and return null for unavailable metadata.
3. Translate `[permissions.<role>]` into the CLI's own controls. Document any command or file access they cannot enforce.
4. Add `[adapter.<name>]` settings and `[models]` aliases to the project config, with a fallback and prices if known.
5. Test no-output, cannot-start, guard-refusal, success, and an actual report. The dispatcher must be able to tell code 2 from a failed run.

The adapter contract is stable for this alpha only as exercised by the tests; check existing callers before changing a report field. A terminal backend independent of Orca is on the [roadmap](roadmap.md).
