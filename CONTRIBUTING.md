# Contributing

Cleared is alpha software. Start with a focused bug report or idea, then propose one topic per pull request. Check the [roadmap](docs/roadmap.md) and [configuration reference](docs/configuration.md) before changing a public setting or adapter contract. Keep examples invented and do not commit credentials, project fingerprints, or private data.

## Run checks

Node.js 24, git, curl, flock (util-linux) and GitHub CLI are needed for the local suite. The tests create disposable Git repositories and stub external CLIs; they do not need a real Linear ticket or model account. The core is TypeScript that Node runs as it is; its type check uses the TypeScript that `v2/` installs.

```sh
npm ci --prefix v2 --ignore-scripts
v2/node_modules/.bin/tsc -p .
node --test test/*.test.ts
```

The core has no shell script: write a new command in TypeScript, under the same `tsconfig.json`. Add a focused test when changing workflow rules, approval, guard behavior, or message recognition. When editing `agents.example.conf`, update `docs/configuration.md`; an existing test checks that every example section and key is documented.

## Pull requests

Use short conventional commit subjects in plain English: `feat:`, `fix:`, `docs:`, or `chore:`. Explain what changed, why, how you tested it, and any compatibility impact. One pull request covers one subject. Every change needs review by someone other than its author before merge; changes to approval and guard logic need extra care. Do not merge your own unreviewed change.

Read the [code of conduct](CODE_OF_CONDUCT.md). Report security issues through the [private channel](SECURITY.md), not a public issue.
