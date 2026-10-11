# Contributing

Cleared is alpha software. Start with a focused bug report or idea, then propose one topic per pull request. Check the [roadmap](docs/roadmap.md) and [configuration reference](docs/configuration.md) before changing a public setting or adapter contract. Keep examples invented and do not commit credentials, project fingerprints, or private data.

## Run checks

Node.js 24, git, jq, bash, and GitHub CLI are needed for the local suite. The tests create disposable Git repositories and stub external CLIs; they do not need a real Linear ticket or model account.

```sh
node --test test/*.test.mjs
```

Run `bash -n` for touched shell files and `node --check` for touched JavaScript files. Add a focused test when changing workflow rules, approval, guard behavior, or message recognition. When editing `agents.example.conf`, update `docs/configuration.md`; an existing test checks that every example section and key is documented.

## Pull requests

Use short conventional commit subjects in plain English: `feat:`, `fix:`, `docs:`, or `chore:`. Explain what changed, why, how you tested it, and any compatibility impact. One pull request covers one subject. Every change needs review by someone other than its author before merge; changes to approval and guard logic need extra care. Do not merge your own unreviewed change.

Read the [code of conduct](CODE_OF_CONDUCT.md). Report security issues through the [private channel](SECURITY.md), not a public issue.
