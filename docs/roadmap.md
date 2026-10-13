# Roadmap

Cleared is an alpha for developers, maintained around one real project. It aims to work with as many coding harnesses as practical. The items below are directions for contributors, not commitments or claims that these features already work.

- **Memory improvements.** The opt-in local adapter indexes project files and session handovers today. Future work may add model-assisted extraction, embeddings, and other storage adapters after their trust boundaries are designed and tested.
- **Cleared app, next.** The [app](app.md) shows teams, approvals, queues, fuel and host health live, and lets the human clear a ticket to land, send it back and answer a question. Still to come: free conversation with the tower and the teams, flight plans, a rollback button.
- **More coding harnesses.** Add OpenCode, Gemini CLI, and Copilot CLI adapters alongside today's Claude Code and Codex CLI adapters, following the documented adapter contract.
- **Review with one subscription.** When another model is available, use it for review. Otherwise, allow a fresh session on the same subscription without the author's context. Today the reviewer must use a different model.
- **Ticket tracker adapters.** Improve the first Linear, GitHub Issues, and local SQLite adapters, especially pagination, capture review, and offline use. GitHub remains the only forge; GitLab and Gitea are outside this contract.
- **Terminal adapter.** `[terminal] adapter` selects where sessions run. `orca` (the default) and `none` (no terminal: detached sessions started by the wake's systemd user service) are done. A tmux adapter is still planned.
- **Broader project support.** Remove assumptions about Node projects, `CLAUDE.md`, and example capture paths where the project supplies its own workflow. Keep documented French ticket commands usable where the parser supports them.

Small changes should arrive with a focused issue, a test for behavior, and a review from someone other than the author. See [Contributing](../CONTRIBUTING.md).
