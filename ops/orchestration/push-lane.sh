#!/usr/bin/env bash
# Pushes the branch of a lane and opens its pull request. Nothing else.
#
#   push-lane.sh <worktree of the lane>
#
# A lane has no network command: this script is the one way its work leaves
# the machine. It only ever does two things, to one place each:
#   - git push of the lane's own branch <role>/<ticket> to the branch of the
#     same name on origin (or, for a lane that took over a pull request, to
#     the branch of that pull request), never forced, never the base branch;
#   - a draft pull request from that branch to the base branch, if none is
#     open yet.
# It refuses anything else: another branch, a role that [lanes] push_roles
# does not name, and commit messages or changes that the guard of the
# repository would not let out (a push cannot be taken back). Called by lane-run.sh once a run is done, never by a model.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

[ $# -eq 1 ] && [ -d "$1" ] || die "usage: push-lane.sh <worktree of the lane>"
worktree=$(cd "$1" && pwd)
branch=$(git -C "$worktree" symbolic-ref --quiet --short HEAD) || die "$worktree is not on a branch"
[[ "$branch" =~ ^([a-z][a-z-]*)/([A-Z]+-[0-9]+)$ ]] || die "\"$branch\" is not the branch of a lane (<role>/<ticket>)"
role=${BASH_REMATCH[1]}
grep -qw -- "$role" <<<"$(conf_get lanes push_roles)" || die "lanes of the role \"$role\" are not pushed (see [lanes] push_roles)"
base=$(conf_get lanes base)
target=${base#origin/}
[ "$branch" != "$target" ] || die "the base branch is never pushed from here"
# A lane that took over a pull request somebody else began sends its work
# to the branch of that pull request (the dispatcher says which, never the
# model): an open pull request must stand on it, and it is never the base.
push_to=${ORCH_PUSH_BRANCH:-$branch}
[ "$push_to" != "$target" ] || die "the base branch is never pushed from here"
if [ "$push_to" != "$branch" ]; then
  [ -n "$(cd "$worktree" && gh pr list --head "$push_to" --state open --json number | jq -r '.[0].number // empty')" ] \
    || die "\"$push_to\" is not the branch of an open pull request: nothing is pushed to it"
fi

ahead=$(git -C "$worktree" rev-list --count "$base..HEAD")
if [ "$ahead" = 0 ]; then
  echo "nothing to push: $branch has no commit of its own"
  exit 0
fi

# What leaves with the push and the pull request: checked first.
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
git -C "$worktree" log --format='%B' "$base..HEAD" > "$out/messages.txt"
guard_text "$out/messages.txt" || die "$branch not pushed: a commit message is refused by the guard"
# What the branch adds, as a diff without context nor removed lines: the
# guard reads the added lines of a code file as it reads the tree, those of
# any other file strictly. What a branch removes is already on the remote.
# (A binary file is not read: the guard only knows text.)
# A diff that cannot be computed stops everything here: an empty file would
# pass the guard with nothing having been looked at.
git -C "$worktree" diff --unified=0 "$base...HEAD" > "$out/raw.diff" || die "$branch not pushed: its changes against $base cannot be read"
# Kept: the name of each file and the lines added. Dropped: the lines removed
# and the old text git quotes after the @@ of a hunk.
{ grep -v '^-' "$out/raw.diff" || true; } | sed -E 's/^(@@ [^@]* @@).*/\1/' > "$out/changes.diff"
guard_text "$out/changes.diff" || die "$branch not pushed: its changes are refused by the guard"

# The lane's branch to the branch of the same name, and only that. No force
# in any form: a remote branch that moved makes this fail, on purpose.
# A pull request that is not a draft runs its checks at every push, whatever
# the host is doing: it goes back to draft first, and is taken out of it
# when the host is free for a run (flow-lanes.sh), like a new one.
existing=$(cd "$worktree" && gh pr list --head "$push_to" --state open --json number,isDraft | jq -r '.[0] | select(.isDraft == false) | .number // empty')
[ -z "$existing" ] || (cd "$worktree" && gh pr ready "$existing" --undo) > /dev/null 2>&1 || true
git -C "$worktree" push --quiet origin "HEAD:refs/heads/$push_to"

number=$(cd "$worktree" && gh pr list --head "$push_to" --state open --json number | jq -r '.[0].number // empty')
if [ -z "$number" ]; then
  title=$(git -C "$worktree" log --reverse --format='%s' "$base..HEAD" | sed -n '1p')
  {
    echo "Opened by the dispatcher for ${BASH_REMATCH[2]} (lane \`$branch\`). Draft: the checks start when it is marked ready."
    echo
    echo "Commits:"
    git -C "$worktree" log --reverse --format='- %s' "$base..HEAD"
  } > "$out/body.md"
  url=$(cd "$worktree" && gh pr create --draft --base "$target" --head "$branch" --title "$title" --body-file "$out/body.md")
  number=${url##*/}
fi
[[ "$number" =~ ^[0-9]+$ ]] || die "$branch is pushed, but its pull request could not be opened or read"

lines=$(git -C "$worktree" diff --shortstat "$base...HEAD" | awk '{for (i = 1; i <= NF; i++) if ($(i + 1) ~ /^(insertion|deletion)/) total += $i} END {print total + 0}')
# The branch is out by now: a ledger that does not take the number must not
# make this look like a failed push.
[ -z "${ORCH_RUN_ID:-}" ] || ledger run-set --run-id "$ORCH_RUN_ID" --pr-number "$number" --lines-changed "$lines" \
  || echo "$(basename "$0"): pull request #$number not written to the ledger" >&2
echo "#$number"
