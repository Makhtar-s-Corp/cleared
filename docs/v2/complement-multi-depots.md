# Cleared v2 complement: a ticket that crosses several repositories (2026-10-22)

Principle: a workspace is several services (repositories or monorepo folders). A ticket belongs to the workspace and can touch several services. A simple project is a workspace with one service (nothing changes).

Reference example: the ticket "second ISRC" is the catalogue API, the royalties API and the back-office. The contract is validated first, then 3 parallel steps with fake services, then integration, one approval, and an ordered landing.

Milestone 1 (catch-up):

- 1: workspace/services model, with a config per service; 3-level memory (workspace, service, contracts).
- 3: a set of branches with the same name, sibling containers, a fake service if one cannot be launched, a trial environment per ticket (Browser tab).
- 5: a single release card as a train, with the landing order, health checked between each landing, rollback in reverse order, and compatibility verified before approval (an untouched consumer blocks; propose an extension or backward compatibility).
- 8: sensitivity per service (full circuit, dedicated reviewer, a specific human), flagged from the plan.

Milestone 2:

- 2: a ticket in steps: the contract first (OpenAPI/protobuf/JSON Schema/event, validated by the human), steps per service with a fake service, then end-to-end integration; a plan with dependencies, order and cost per step.
- 7: skills per service in the standard format in the repository; approved knowledge goes into the skill.
- 9: a question to the whole platform (service, file, line).

Milestone 3:

- 4: notes between the sessions of a ticket (handed over at the next turn, seen by the lead); a contract change reopens the contract step with human approval; the handover files knowledge in the contract's memory.

Milestone 4:

- 6: a map of the services (calls, events, databases, contracts) kept up to date; impact analysis by the lead; a diagram visible in the app.

Milestone 5:

- 10: connect a workspace = several repositories + setup sessions + links (guessed and proposed); forge = an adapter per service, GitLab first after GitHub.
