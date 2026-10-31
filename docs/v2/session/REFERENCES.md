# Cleared v2: what the session screen takes from Devin, Codex and Linear

Lane `v2-j7-session`, issue #499. Each source was read on 2026-10-31. The signed-in products were not opened, since they need an account, so nothing below describes their real screens: it says what their public documentation states, and where that stops. These documentation pages carry no date, so they are the current text and not dated 2026 notes. No image of theirs is in this repository and no page of theirs is copied. [DESIGN.md](../ui-pro/DESIGN.md) stays the system, and the owner's direction wins over anything below.

## Devin

Source: [Devin session tools, Devin docs](https://docs.devin.ai/work-with-devin/devin-session-tools).

- The Progress tab brings the work together in "one unified view": "All shell commands, code edits, and browser activity", and any step opens its details on a click.
- The shell, the browser and the editor are tools beside it, opened when wanted.
- The page says nothing of a session's status, its cost or its pull request.

**We take:** one place for all the technical activity, each step opening its details, behind the fold rather than in front of the person. The thread, the Files tab and the Preview tab are that place.

## Codex

Source: [Codex web, OpenAI's documentation](https://learn.chatgpt.com/docs/cloud).

- Once a task is done: "Inspect changed files and check results", "Review the changes and test results, request follow-ups", "commit or open a pull request when ready".
- The page does not describe what a running task shows, so nothing here is taken from it for the running state.

**We take:** the end of a task is its result and the next gesture, not its log. A finished session shows its pull request and its receipt, and the changed files and checks stay one click away.

## Linear

Source: [Developing the agent interaction, Linear's developer docs](https://linear.app/developers/agent-interaction).

- A session has six states, which "will be visible to users": `pending`, `active`, `error`, `awaitingInput`, `complete` and `stale`. Linear sets them from the "last emitted activity", so an agent does not manage them.
- An agent's activities are a thought, an elicitation (a request for clarification), an action, a response and an error. Ephemeral ones are replaced by the next.
- The plan is a session-level checklist to "keep users informed on current and upcoming actions". Each step has a `status` of `pending`, `inProgress`, `completed` or `canceled`, and the agent replaces the whole plan at each update. That API is in technology preview.
- The page does not say how any of this looks on screen.

**We take:** a small fixed set of states derived from what happened, not written by the agent, which is how `glance.ts` reads the session. A request for clarification is a state of its own, which is our one action at the top. A plan is a readable checklist of current and upcoming work.

**Taken since, by lane `v2-j7-plan-step` (issue #501):** Linear knows the current step of a plan because the agent reports it. Cleared's author now reports the number of the step it starts (`report_plan_step`), and the screen marks that step; with no report it keeps the ticket's stage out of five and lists the plan without a mark. We take the agent's report, not Linear's whole model: a number rather than a status for each step and a plan replaced at each update, since the steps before a reported one are done and the ones after it are to come.

## What we do not take

- Their looks. The owner's direction says a calm white tool with one indigo accent: no gradient, no coloured side border, no big bold block.
- Any claim about their screens beyond the pages above. A search summary attributed a sentence about session states to [Linear's AI agents page](https://linear.app/docs/agents-in-linear), and that page does not hold it, so it is not used here.
