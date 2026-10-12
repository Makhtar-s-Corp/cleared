#!/usr/bin/env bash
# Brings the checkout of the project up to its base, when it lags. The tool
# reads the project where that checkout stands: its settings and its prompts
# (.cleared/), its rules, what a session opened there is shown. A change of
# the project that went live is seen there only once this copy has it:
# without this, somebody pulls by hand after each go-live, or it grows old.
#
#   project-update.sh
#
# Only with [update] project = yes, and only for a checkout that is on the
# branch of the base ([lanes] base): a checkout where somebody works on a
# branch never moves by itself. A project the tool lives inside of is left
# to self-update.sh, which moves that same checkout. It only ever
# fast-forwards. It leaves the copy as it is, and says why in the ledger
# (once for a given version of the base), when a tracked file of it was
# changed by hand, or it holds commits the base does not have: nothing is
# overwritten. What is not tracked (the file of secrets, the state) is
# not touched: a file that is not tracked where a tracked one comes in
# stops the update, and that is said too.
#
# Exit: 0 updated; 3 nothing to do; 1 refused.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ "$(update_setting project)" = yes ] || exit 3
base=$(conf_get lanes base)
base=${base:-origin/main}
branch=${base#origin/}
top=$(git -C "$ORCH_REPO" rev-parse --show-toplevel 2> /dev/null) || exit 3
own=$(git -C "$ORCH_HOME" rev-parse --show-toplevel 2> /dev/null) || own=
[ -z "$own" ] || [ "$(cd "$top" && pwd -P)" != "$(cd "$own" && pwd -P)" ] || exit 3
[ "$(git -C "$top" symbolic-ref --quiet --short HEAD 2> /dev/null)" = "$branch" ] || exit 3
# The remote not answering is no news: the next wake asks again.
git -C "$top" fetch --quiet origin "$branch" 2> /dev/null || exit 3
old=$(git -C "$top" rev-parse HEAD)
# A base this copy does not know (named without its remote, or never
# fetched) is nothing to follow.
new=$(git -C "$top" rev-parse --verify --quiet "$base^{commit}") || exit 3
[ "$old" != "$new" ] || exit 3

mark="$ORCH_STATE_DIR/wake/project-update-refused"
refuse() {
  echo "$(basename "$0"): $1" >&2
  if [ "$(cat "$mark" 2> /dev/null)" != "$new" ]; then
    mkdir -p "$(dirname "$mark")"
    ledger init > /dev/null
    ledger event --kind project_update_refused --detail "the checkout of the project stays at ${old:0:8} and did not take ${new:0:8} of $branch: $1. What went live since is not what the tool reads there (settings, prompts, rules); somebody must look at this copy ($top)"
    echo "$new" > "$mark"
  fi
  exit 1
}

git -C "$top" merge-base --is-ancestor "$old" "$new" || refuse "this copy holds commits $branch does not have"
changed=$(git -C "$top" status --porcelain --untracked-files=no | sed -n '1,5p' | tr '\n' ' ')
[ -z "$changed" ] || refuse "files of this copy were changed by hand and not committed ($changed)"
# Git says why when it does not go through (a file that is not tracked
# stands where a tracked one comes in). Somebody holding the index for an
# instant is no refusal: the next wake asks again.
if ! said=$(git -C "$top" merge --quiet --ff-only "$new" 2>&1); then
  case "$said" in *index.lock*) exit 3 ;; esac
  refuse "the fast-forward to ${new:0:8} did not go through: $(sed -n '1,3p' <<<"$said" | tr '\n\t' '  ' | cut -c1-300)"
fi
rm -f "$mark"
ledger init > /dev/null
ledger event --kind project_updated --detail "the checkout of the project went from ${old:0:8} to ${new:0:8} of $branch"
echo "updated: ${old:0:8} -> ${new:0:8}"
