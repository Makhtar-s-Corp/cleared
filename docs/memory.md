# Project memory

Cleared starts each agent session fresh. When `[memory] enabled = true`, the dispatcher prepares a bounded briefing before the role prompt. The text is labelled as reference data, with its source, and tells the model to ignore and report any passage that reads like an instruction. This marking reduces prompt injection risk; it cannot guarantee that a model will always ignore hostile text.

The local adapter indexes the project's decision files, glossary, project overview, and role lessons in place. It does not write them. Use one decision per Markdown file and `## Term` headings for individual glossary entries. It stores handovers and machine events in SQLite beside the ledger. Node's SQLite FTS5 index is used when available; a simple scan provides the same basic content search when FTS5 is missing. File hashes avoid unnecessary reindexing. No model extraction, embeddings, npm package, or external memory service is involved.

An entry has an ID, type, scope, short Markdown content, source identity, location and time, status, links, superseded entry, and last briefing use. Agent entries start as proposals. Only the configured human owner, as identified by the tracker adapter, can approve an entry through the memory command. A decision file with `status: approved` is treated as reviewed project reference. Keep these files under normal repository review. The host account that runs Cleared can still edit everything it can read or write; use a dedicated account when isolation matters.

The briefing includes the project overview, role lessons, the newest handover for the ticket in full, up to five approved decisions matching the ticket text, and glossary content matching the ticket text. Each block has a source label and a data boundary. If a block does not fit the byte budget, the remainder is omitted; a handover is never cut halfway. The ledger records the IDs actually included.

Every enabled lane is asked to write `HANDOVER.md` with the five required headings at its worktree root. Cleared excludes it from normal `git add -A`, stores it after the harness exits, then removes the file. This also runs when a harness refuses or stops at a limit. A missing or malformed file is recorded in the ledger, and the next briefing for that ticket says so. A hard power loss can leave a file in the worktree; inspect it before discarding the worktree.

The project lead's `prompts/handover.md` is different: it guides a new lead after a lead transition. It is not a lane session handover and is not added as a ticket handover entry.
