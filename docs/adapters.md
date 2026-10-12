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

`adapters/claude.sh` invokes Claude Code directly and maps role permissions to its allow and deny options. `adapters/codex.sh` delegates to the project's executable named by `[adapter.codex] task_script`; Cleared does not embed a container recipe. The task script receives `<worktree> <prompt-file> <model> [--tools]`. It must run Codex in the environment chosen by the project, leave file changes in that worktree, print the model's answer on stdout, and print usage records such as `token usage <json>` and `rate limits <json>` on stderr when available. Exit 0 means success, 2 means no session started, and 3 means a provider guard refusal. With `task_tools = yes`, list the script in `[lanes] heavy_commands` so it waits for the host's heavy-command gate. With `commits = no`, the dispatcher commits returned changes under the model's `.commit-message` or a fallback title.

## Add an adapter

1. Copy the command structure of an existing adapter and source `lib/contract.sh` for `run` reports and usage.
2. Make `list-models` report only IDs that can start now. Keep `version` fast and return null for unavailable metadata.
3. Translate `[permissions.<role>]` into the CLI's own controls. Document any command or file access they cannot enforce.
4. Add `[adapter.<name>]` settings and `[models]` aliases to the project config, with a fallback and prices if known.
5. Test no-output, cannot-start, guard-refusal, success, and an actual report. The dispatcher must be able to tell code 2 from a failed run.

The adapter contract is stable for this alpha only as exercised by the tests; check existing callers before changing a report field. A terminal backend independent of Orca is on the [roadmap](roadmap.md).
