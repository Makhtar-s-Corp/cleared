# Cleared v2: what the onboarding takes from Linear, Vercel, Devin and Codex

Lane `v2-j7-onboarding`, issue #497. Each source was read on 2026-10-30. The signed-in products were not opened, since they need an account, so what is said of them comes from their documentation or from a dated review. Where the sources disagree or are thin, it says so. No image of theirs is in this repository and no page of theirs is copied. [DESIGN.md](../ui-pro/DESIGN.md) stays the system: the owner's direction wins over anything below.

## Linear

Sources: [Linear onboarding teardown, Candu, 2026-09-27](https://www.candu.ai/blog/linear-onboarding-teardown); [Linear user flow, Supademo](https://supademo.com/user-flow-examples/linear), undated. Both are third parties and they differ on the order of the screens.

- Seven short screens in about a minute, ending on a first issue, "cursor blinking, ready to work".
- Empty states with a "single explanation of what goes here" and "one button to move forward".

**We take:** one sentence and one button per step, and an end on real work instead of a tour.

## Vercel

Sources: [Vercel tutorial, Flavio Copes, updated 2026-10-16](https://flaviocopes.com/vercel.md); [Vercel build features](https://vercel.com/docs/deployments/build-features) and [logs](https://vercel.com/docs/deployments/logs). I found no official 2026 note on the onboarding screens themselves.

- New Project, import the repository, check what was detected, Deploy. Vercel detects the framework and the build settings, so the person confirms instead of filling in.
- The build's log sits in an accordion with a real-time stream, opened when it is wanted.
- Secret values are masked in logs and cannot be read back once saved.

**We take:** detect first and ask to confirm (the test secrets' names read from the repository, one repository said in one sentence); the log folded under the state; nothing secret shown after it is saved.

## Devin

Sources: [Environment configuration, Devin docs](https://docs.devin.ai/onboard-devin/environment); [Setting up a new repository, Devin docs](https://docs.devin.ai/onboard-devin/new-repo-setup).

- Connect the forge and choose the repositories, then a session sets up its own environment: "Set up your environment for this repo". The person approves what it proposes.
- It "can infer tools and dependencies from the repo", and credentials are the one thing it cannot find, so they are asked for separately.
- Snapshots: every session starts from the same clean state.

**We take:** a session that sets up the environment, shown live, with the request it waits on said in the assistant; a secret asked for only when the repository shows it is needed.

## Codex

Sources: [How to use Codex Cloud reusable environments, Developers Digest, 2026-10-17](https://www.developersdigest.tech/blog/codex-cloud-reusable-environments); [Codex web, OpenAI's documentation](https://learn.chatgpt.com/docs/cloud).

- Choose the repositories and select Get started: Codex inspects them, installs what they need and tests the workflow. "You don't need to write an installation script yourself."
- The person answers prompts for missing access, reads a setup report, then publishes.
- Clear states: an "Unpublished" badge says tasks cannot use the environment yet.

**We take:** the state in one word beside its service; a failed test explained, with the fix offered as one action; missing access said at the moment it blocks.

## GitHub's token page

Source: [Managing your personal access tokens, GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), section "Pre-filling fine-grained personal access token details using URL parameters".

**We take:** the forge step's link opens GitHub's page with the name and the permissions already filled in, so the permission list moves behind "Show details".

## What we do not take

- Their looks. The anti-slop rules (R-30) and the owner's direction say a calm white tool with one indigo accent: no gradient, no coloured side border, no large bold block.
- A product tour, a theme picker, a role question or a team invitation: nothing here serves one person installing their own tool.
- Any figure about onboarding length as a target. "About a minute" is Linear's, from a review; Cleared installs Docker images and states no duration it has not measured.
