#!/usr/bin/env bash
# Brings the checkout these scripts run from up to the base, when it lags.
# A change of the tooling that went live is live only once this copy has
# it: without this, somebody pulls by hand after each go-live, or the
# dispatcher keeps running what was replaced.
#
#   self-update.sh
#
# Only with [update] self = yes, and only for a checkout that is on the
# branch of the base: a worktree where somebody works on the tooling never
# moves by itself. It only ever fast-forwards. It leaves this copy as it is,
# and says why in the ledger (once for a given version of the base), when:
#   - a tracked file of this copy was changed by hand, or this copy holds
#     commits the base does not have: nothing is overwritten;
#   - a script of the incoming version cannot even be read by its
#     interpreter. The checks of its pull request ran its tests; this is the
#     last look before the wake itself is replaced.
# When what runs the services changed (serve/), they are installed again.
#
# Exit: 0 updated; 3 nothing to do; 1 refused.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ "$(update_setting self)" = yes ] || exit 3
# The branch of the tool itself, not the one of the project it works on.
base=$(update_setting base)
base=${base:-origin/main}
branch=${base#origin/}
top=$(git -C "$ORCH_HOME" rev-parse --show-toplevel 2> /dev/null) || exit 3
[ "$(git -C "$top" symbolic-ref --quiet --short HEAD 2> /dev/null)" = "$branch" ] || exit 3
# The remote not answering is no news: the next wake asks again.
git -C "$top" fetch --quiet origin "$branch" 2> /dev/null || exit 3
old=$(git -C "$top" rev-parse HEAD) new=$(git -C "$top" rev-parse "$base")
[ "$old" != "$new" ] || exit 3
# Where the tool is in that repository: a folder of it, or the whole of it.
tools=$(cd "$ORCH_HOME" && pwd -P)
tools=${tools#"$(cd "$top" && pwd -P)"}
tools=${tools#/}
tools=${tools:-.}

mark="$ORCH_STATE_DIR/wake/self-update-refused"
refuse() {
  echo "$(basename "$0"): $1" >&2
  if [ "$(cat "$mark" 2> /dev/null)" != "$new" ]; then
    mkdir -p "$(dirname "$mark")"
    ledger init > /dev/null
    ledger event --kind self_update_refused --detail "the checkout the dispatcher runs from stays at ${old:0:8} and did not take ${new:0:8} of $branch: $1. The tooling that went live since does not run yet; somebody must look at this copy ($top)"
    echo "$new" > "$mark"
  fi
  exit 1
}

git -C "$top" merge-base --is-ancestor "$old" "$new" || refuse "this copy holds commits $branch does not have"
changed=$(git -C "$top" status --porcelain --untracked-files=no | sed -n '1,5p' | tr '\n' ' ')
[ -z "$changed" ] || refuse "files of this copy were changed by hand and not committed ($changed)"

# What comes in, read by its interpreter before it replaces what runs.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
while IFS= read -r path; do
  case "$path" in
    *.sh) git -C "$top" show "$new:$path" | bash -n /dev/stdin 2> /dev/null || refuse "the shell cannot read $path of the new version" ;;
    *.mjs)
      git -C "$top" show "$new:$path" > "$work/incoming.mjs"
      node --check "$work/incoming.mjs" 2> /dev/null || refuse "node cannot read $path of the new version"
      ;;
  esac
done < <(git -C "$top" diff --name-only --diff-filter=AM "$old" "$new" -- "$tools")

git -C "$top" merge --quiet --ff-only "$new" > /dev/null 2>&1 || refuse "the fast-forward to ${new:0:8} did not go through"
rm -f "$mark"
ledger init > /dev/null
services=
if [ -n "$(git -C "$top" diff --name-only "$old" "$new" -- "$tools/serve")" ] && [ -x "$ORCH_HOME/serve/install.sh" ]; then
  if "$ORCH_HOME/serve/install.sh" > /dev/null 2>&1; then services=", its services installed again"; else services=", but its services could not be installed again (serve/install.sh): to be run by hand"; fi
fi
ledger event --kind self_updated --detail "the checkout the dispatcher runs from went from ${old:0:8} to ${new:0:8} of $branch$services"
echo "updated: ${old:0:8} -> ${new:0:8}"
