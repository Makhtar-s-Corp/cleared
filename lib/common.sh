# Shared by the dispatcher scripts. Sourced, never executed.
# Nothing here names a model or a provider: both come from agents.conf.

# Accept the public Cleared environment names while old launchers continue to
# pass ORCH_* during the transition. The newer name wins when both are set.
while IFS= read -r cleared_name; do
  old_name=ORCH_${cleared_name#CLEARED_}
  printf -v "$old_name" '%s' "${!cleared_name}"
  export "$old_name"
done < <(compgen -e | grep '^CLEARED_' || true)

ORCH_HOME=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ORCH_REPO=${CLEARED_REPO:-${ORCH_REPO:-}}
ORCH_CONF=${CLEARED_CONF:-${ORCH_CONF:-}}
ORCH_STATE_DIR=${CLEARED_STATE_DIR:-${ORCH_STATE_DIR:-}}
# The project these scripts work on, by its main checkout: said by whoever
# runs them (ORCH_REPO), else once for the machine (first line of
# ~/.config/ferme/project), else the repository these scripts sit in (a
# project that carries its own copy of the tool).
cleared_config_root=${XDG_CONFIG_HOME:-$HOME/.config}
cleared_project_file=$cleared_config_root/cleared/project
if [ ! -f "$cleared_project_file" ] && [ -f "$cleared_config_root/ferme/project" ]; then cleared_project_file=$cleared_config_root/ferme/project; CLEARED_LEGACY_PATH=$cleared_project_file; fi
ORCH_REPO=${ORCH_REPO:-$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;}' "$cleared_project_file" 2> /dev/null || true)}
ORCH_REPO=${ORCH_REPO:-$(git -C "$ORCH_HOME" worktree list --porcelain 2> /dev/null | sed -n '1s/^worktree //p' || true)}
# No project at all (nobody named one, and the tool sits in no repository):
# nothing is done « wherever this was started from ».
[ -n "$ORCH_REPO" ] || { echo "$(basename "$0"): no project is named (ORCH_REPO, or the first line of $cleared_project_file)" >&2; exit 1; }
# Its settings: its own (.ferme/agents.conf in that checkout, which no lane
# writes to), else the example that comes with the tool.
if [ -z "${ORCH_CONF:-}" ]; then
  if [ -f "$ORCH_REPO/.cleared/agents.conf" ] && git -C "$ORCH_REPO" ls-files --error-unmatch -- .cleared/agents.conf > /dev/null 2>&1; then ORCH_CONF=$ORCH_REPO/.cleared/agents.conf
  elif [ -f "$ORCH_REPO/.ferme/agents.conf" ]; then ORCH_CONF=$ORCH_REPO/.ferme/agents.conf; CLEARED_LEGACY_PATH=$ORCH_CONF
  else ORCH_CONF=$ORCH_REPO/.cleared/agents.conf; fi
  if [ -f "$ORCH_REPO/.cleared/agents.conf" ] && [ "$ORCH_CONF" != "$ORCH_REPO/.cleared/agents.conf" ]; then CLEARED_IGNORED_UNTRACKED_CONF=$ORCH_REPO/.cleared/agents.conf; fi
fi
# The state is kept on the machine, outside the repositories: one folder per
# project, named after its checkout.
if [ -z "${ORCH_STATE_DIR:-}" ]; then
  cleared_state_root=${XDG_STATE_HOME:-$HOME/.local/state}
  ORCH_STATE_DIR=$cleared_state_root/cleared/$(basename "$ORCH_REPO")
  if [ ! -d "$ORCH_STATE_DIR" ] && [ -d "$cleared_state_root/ferme/$(basename "$ORCH_REPO")" ]; then ORCH_STATE_DIR=$cleared_state_root/ferme/$(basename "$ORCH_REPO"); CLEARED_LEGACY_PATH=$ORCH_STATE_DIR; fi
fi
export ORCH_HOME ORCH_CONF ORCH_REPO ORCH_STATE_DIR CLEARED_LEGACY_PATH CLEARED_IGNORED_UNTRACKED_CONF
export CLEARED_REPO="$ORCH_REPO" CLEARED_CONF="$ORCH_CONF" CLEARED_STATE_DIR="$ORCH_STATE_DIR"

# prompt_file <name>: the prompt of that name. The project's own
# (.ferme/prompts/<name>.md in its main checkout) comes before the one of the
# tool: what an agent is told about a product is the product's.
prompt_asset() {
  if [ -f "$ORCH_REPO/.cleared/prompts/$1" ]; then printf '%s\n' "$ORCH_REPO/.cleared/prompts/$1"
  elif [ -f "$ORCH_REPO/.ferme/prompts/$1" ]; then printf '%s\n' "$ORCH_REPO/.ferme/prompts/$1"
  else printf '%s\n' "$ORCH_HOME/prompts/$1"; fi
}
prompt_file() { prompt_asset "$1.md"; }
# prompt_text <file>: its text, with {orch} standing for where these scripts
# are on this machine (the same word as in [permissions.*]).
# Written as it is, whatever characters the path holds (a quoted replacement
# is taken literally).
prompt_text() {
  local text verdict
  [ -r "$1" ] || { echo "$(basename "$0"): no prompt to read at $1" >&2; return 1; }
  text=$(cat "$1"; printf x)
  text=${text%x}
  if [[ "$text" == *'@REVIEW_VERDICT@'* ]]; then
    verdict=$(conf_get merge verdict) || return 1
    text=${text//@REVIEW_VERDICT@/$verdict}
  fi
  printf '%s' "${text//\{orch\}/"$ORCH_HOME"}"
}

die() { echo "$(basename "$0"): $*" >&2; exit 1; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

expand_home() { case "$1" in "~/"*) printf '%s\n' "$HOME/${1#\~/}" ;; *) printf '%s\n' "$1" ;; esac; }

ledger() { node --no-warnings "$ORCH_HOME/lib/ledger.mjs" "$@"; }

# lane_worktree <name>: the worktree of that name, as git knows it. Fails when
# there is none, or more than one.
lane_worktree() {
  local found
  found=$(git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | awk -F/ -v name="$1" '$NF == name')
  [ -n "$found" ] && [ "$(grep -c . <<<"$found")" -eq 1 ] && printf '%s\n' "$found"
}

# orca_terminal <handle>: "<connected> <worktree path>" of that terminal as
# Orca shows it now, nothing when Orca has no such terminal. Orca that does
# not answer, or answers without a list, is said and stops the script.
orca_terminal() {
  local listed
  listed=$(orca terminal list --json 2> /dev/null) || die "Orca did not answer (orca terminal list): nothing done"
  jq -e '(.result.terminals // .result) | type == "array"' <<<"$listed" > /dev/null 2>&1 || die "Orca gave no list of terminals: nothing done"
  jq -r --arg handle "$1" '(.result.terminals // .result)[] | select(.handle == $handle) | "\(.connected) \(.worktreePath)"' <<<"$listed" | sed -n '1p'
}

# update_setting <key>: a setting of [update]. How the checkouts on this
# machine follow their bases is said by the project when it says it, else by
# the settings that come with the tool: a project that keeps its own file
# and says nothing of it does not switch the updates off by leaving it out.
update_setting() {
  conf_get update "$1"
}

# conf_get <section> <key>: one value of agents.conf (empty when absent).
conf_get_from() {
  awk -v section="[$1]" -v wanted="$2" '
    /^\[/ { inside = ($0 == section); next }
    inside && $0 !~ /^[ \t]*#/ {
      i = index($0, "="); if (!i) next
      key = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key == wanted) { value = substr($0, i + 1); gsub(/^[ \t]+|[ \t]+$/, "", value); found = 1 }
    }
    END { if (!found) exit 1; print value }' "$3"
}
conf_get() {
  local value code=0
  if [ -f "$ORCH_CONF" ] && value=$(conf_get_from "$1" "$2" "$ORCH_CONF"); then :
  else
    value=$(node "$ORCH_HOME/lib/conf.mjs" default "$1" "$2") || code=$?
    [ "$code" != 2 ] || return 2
    [ "$code" = 0 ] || value=
  fi
  printf '%s\n' "$value"
}

# shown_left <record of a request>: of the pull requests the user was shown
# on a ticket and that are not live, how many are still open and how many
# GitHub cannot be asked about, as "<open> <unknown>". One GitHub says
# closed, or merged by another hand, no longer counts.
shown_left() {
  local other state open=0 unknown=0
  while IFS= read -r other; do
    state=$(cd "$ORCH_REPO" && gh pr view "$other" --json state 2> /dev/null | jq -r '.state // empty' 2> /dev/null) || state=
    case "$state" in CLOSED | MERGED) ;; OPEN) open=$((open + 1)) ;; *) unknown=$((unknown + 1)) ;; esac
  done < <(jq -r '.pulls[] | select(.merged_at == null) | .pr' "$1")
  echo "$open $unknown"
}

# A go-live was done, and its ticket could not be closed because GitHub did
# not say what became of another pull request shown on it (merge-pr.sh marks
# the record): asked again at each wake, with no model, under the lock of
# the go-lives since both write these records. Nothing is given up in
# silence: while that pull request is open or unknown, or while Linear does
# not answer or has not written yet who moved the ticket, the mark stays and
# the next wake tries again. The ticket is closed only if it still is where
# the user put it himself; if it is not, it is left as it is, and said.
close_tickets_left_open() {
  local record ticket open unknown code go
  ls "$ORCH_STATE_DIR/validations"/*.json > /dev/null 2>&1 || return 0
  go=$(conf_get linear go_state)
  (
    flock -n 9 || exit 0
    for record in "$ORCH_STATE_DIR/validations"/*.json; do
      [ "$(jq -r '.closing // false' "$record" 2> /dev/null)" = true ] || continue
      ticket=$(jq -r '.ticket' "$record")
      # The result of a team he did not choose, that GitHub did not close
      # at the go-live of the other: closed here.
      # (One that is closed already, or that somebody merged by hand since,
      # has nothing left to close: the second is said, once.)
      open=$(jq -r '.close // empty' "$record")
      if [ -n "$open" ]; then
        case "$(cd "$ORCH_REPO" && gh pr view "$open" --json state 2> /dev/null | jq -r '.state // empty' 2> /dev/null)" in
          CLOSED) ;;
          MERGED) ledger event --kind ticket_left_open --ticket "$ticket" --value "$open" --detail "#$open, the result of the team the user did not choose for $ticket, was merged by another hand than the script's after the go-live of the one he chose: both are live. Tell the user, nothing else can be done from here" ;;
          OPEN) (cd "$ORCH_REPO" && gh pr close "$open") > /dev/null 2>&1 || continue ;;
          *) continue ;;
        esac
        jq 'del(.close)' "$record" > "$record.next" && mv "$record.next" "$record"
      fi
      read -r open unknown <<<"$(shown_left "$record")"
      [ "$open" = 0 ] && [ "$unknown" = 0 ] || continue
      code=0
      "$ORCH_HOME/linear.sh" moved-by-owner "$ticket" "$go" || code=$?
      case "$code" in
        0) "$ORCH_HOME/linear.sh" move "$ticket" "$(conf_get linear done_state)" > /dev/null || continue ;;
        5 | 6) ledger event --kind ticket_left_open --ticket "$ticket" --detail "everything shown on $ticket is live or closed, but the ticket is no longer in « $go » by the user's own hand (he moved it, or someone else did): the wake leaves it as it is and closes nothing. Tell the user where the ticket stands" ;;
        *) continue ;;
      esac
      jq 'del(.closing)' "$record" > "$record.next" && mv "$record.next" "$record"
    done
  ) 9> "$ORCH_STATE_DIR/merge.lock"
  return 0
}

# conf_keys <section>: the keys of a section, one per line.
conf_keys() {
  if [ -f "$ORCH_CONF" ]; then awk -v section="[$1]" '
    /^\[/ { inside = ($0 == section); next }
    inside && $0 !~ /^[ \t]*#/ { i = index($0, "="); if (i) { key = substr($0, 1, i - 1); gsub(/^[ \t]+|[ \t]+$/, "", key); if (!seen[key]++) print key } }' "$ORCH_CONF"; fi
  node "$ORCH_HOME/lib/conf.mjs" default-keys "$1"
}

# Every key of [adapter.<name>] reaches the adapter as ADAPTER_<KEY>.
adapter_env() {
  local key
  while IFS= read -r key; do
    [ -n "$key" ] && export "ADAPTER_$(printf '%s' "$key" | tr '[:lower:]-' '[:upper:]_')=$(conf_get "adapter.$1" "$key")"
  done < <(conf_keys "adapter.$1")
  return 0
}

# What a role may do without a screen, from [permissions.<role>], handed to
# the adapter as ORCH_PERMISSION_MODE, ORCH_ALLOW and ORCH_DENY (comma
# separated command prefixes). No section: nothing is set, and the CLI keeps
# the settings of the user.
permissions_env() {
  unset ORCH_PERMISSION_MODE ORCH_ALLOW ORCH_DENY ORCH_ADVISOR ORCH_READ
  local mode
  # advisor = no: the role runs without the helper model the CLI may consult.
  [ "$(conf_get "permissions.$1" advisor)" != no ] || export ORCH_ADVISOR=no
  mode=$(conf_get "permissions.$1" mode)
  [ -n "$mode" ] || return 0
  export ORCH_PERMISSION_MODE=$mode ORCH_ALLOW ORCH_DENY
  ORCH_ALLOW=$(conf_get "permissions.$1" allow)
  ORCH_DENY=$(conf_get "permissions.$1" deny)
  # {orch} is where these scripts are: a lane is handed the dispatcher's own
  # copy of a script, never the one of the branch it works on.
  ORCH_ALLOW=${ORCH_ALLOW//\{orch\}/"$ORCH_HOME"}
  ORCH_DENY=${ORCH_DENY//\{orch\}/"$ORCH_HOME"}
  # read: folders the role may read beyond its own worktree, separated by
  # commas. {kept} is where what the lanes set apart for the user is kept
  # ([lanes] kept_in): the lead shows it to him. Nothing else is opened.
  ORCH_READ=$(conf_get "permissions.$1" read)
  if [ -n "$ORCH_READ" ]; then
    ORCH_READ=${ORCH_READ//\{kept\}/"$(expand_home "$(conf_get lanes kept_in)")"}
    export ORCH_READ
  fi
}

adapter_path() {
  local path="$ORCH_HOME/adapters/$1.sh"
  [ -x "$path" ] || die "no adapter for \"$1\": add $path (contract in README.md)"
  printf '%s\n' "$path"
}

# model_available <adapter> <model id>: asks the adapter (list-models), and
# remembers a yes for a day so that a spawn does not probe again.
model_available() {
  local adapter=$1 model=$2 cache="$ORCH_STATE_DIR/models/$1.available" ttl=${ORCH_MODELS_TTL:-86400} seen
  mkdir -p "$ORCH_STATE_DIR/models"
  seen=$(awk -F'\t' -v m="$model" '$1 == m { t = $2 } END { print t + 0 }' "$cache" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - seen )) -lt "$ttl" ]; then return 0; fi
  adapter_env "$adapter"
  if "$(adapter_path "$adapter")" list-models "$model" < /dev/null | grep -qxF "$model"; then
    model_seen "$adapter" "$model"
    return 0
  fi
  return 1
}

# available_chain <chain as JSON, from route.mjs>: the candidates the adapters
# say are available now, in order, as a JSON array (empty when none is).
available_chain() {
  local kept='[]' alias adapter model
  while IFS=$'\t' read -r alias adapter model; do
    if model_available "$adapter" "$model"; then
      kept=$(jq -c --arg alias "$alias" --arg adapter "$adapter" --arg model "$model" '. + [{alias: $alias, adapter: $adapter, model: $model}]' <<<"$kept")
    else
      echo "$(basename "$0"): $alias ($adapter: $model) is not available" >&2
    fi
  done < <(jq -r '.[] | [.alias, .adapter, .model] | @tsv' <<<"$1")
  printf '%s\n' "$kept"
}

model_seen() {
  mkdir -p "$ORCH_STATE_DIR/models"
  printf '%s\t%s\n' "$2" "$(date +%s)" >> "$ORCH_STATE_DIR/models/$1.available"
}

# The worktree where a discussion writes docs/decisions.md, and nothing else.
decisions_worktree() {
  printf '%s\n' "${ORCH_DECISIONS_WORKTREE:-$(expand_home "$(conf_get lanes root)")/$(conf_get talk role)-$(conf_get lead report_on)}"
}

# flush_outbox: the comments the hourly limit held back (lane-run.sh) leave in
# one grouped comment on the ticket of the reports, as soon as the user may be
# written again. Nothing is removed before Linear has it.
flush_outbox() {
  local box="$ORCH_STATE_DIR/linear-outbox" sending grouped file count code left
  # What a wake killed while sending had taken aside comes back first.
  for left in "$box"/sending.*; do
    [ -d "$left" ] || continue
    mv "$left"/*.md "$box"/ 2> /dev/null || true
    rmdir "$left" 2> /dev/null || true
  done
  ls "$box"/*.md > /dev/null 2>&1 || return 0
  # Taken aside first: a report that arrives while these are sent is not
  # among them, and stays for the next time.
  sending=$(mktemp -d "$box/sending.XXXXXX")
  mv "$box"/*.md "$sending"/
  count=$(ls -1 "$sending" | grep -c .)
  grouped=$(mktemp)
  {
    printf '**%s comptes rendus groupés** (pas plus de quelques commentaires par heure : ceux-ci attendaient)\n' "$count"
    for file in "$sending"/*.md; do
      printf '\n### %s\n\n' "$(basename "$file" | sed 's/--.*//')"
      cat "$file"
    done
  } > "$grouped"
  code=0
  "$ORCH_HOME/linear.sh" comment "$(conf_get lead report_on)" "$grouped" "dispatcher, comptes rendus groupés" > /dev/null || code=$?
  rm -f "$grouped"
  # Not sent: back where they were, for the next wake.
  [ "$code" = 0 ] || mv "$sending"/*.md "$box"/
  rm -rf "$sending"
  return 0
}

# open_queued_reviews: the reviews review-pr.sh could not open at once, opened
# now if they may, oldest first, one a wake. No model: the same script, with
# the same rules. A failure that may pass (GitHub or the network not
# answering) is tried again at every wake for an hour. One that will never
# open (already reviewed, pull request closed), one that kept failing for
# that hour, and an entry that cannot be read leave the queue: each is
# written to the ledger (review_dropped) and told to the lead at its next
# wake, as a review to ask for again.
open_queued_reviews() {
  local queue="$ORCH_STATE_DIR/reviews-queue" entry pr ticket author code limit recent since why
  ls "$queue"/*.json > /dev/null 2>&1 || return 0
  for entry in "$queue"/*.json; do
    jq -e '(.pr | type) == "number" and (.ticket | type) == "string"' "$entry" > /dev/null 2>&1 && continue
    ledger event --kind review_dropped --detail "an entry of the queue of reviews ($(basename "$entry")) cannot be read: removed, the review is to be asked for again"
    rm -f "$entry"
  done
  ls "$queue"/*.json > /dev/null 2>&1 || return 0
  limit=$(conf_get review per_hour)
  [[ "$limit" =~ ^[0-9]+$ ]] || limit=4
  recent=$(ledger sql "select count(*) n from runs where role = 'review' and source = 'dispatcher' and started_at >= '$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)'" | jq -r '.[0].n')
  [ "$recent" -lt "$limit" ] || return 0
  while IFS= read -r entry; do
    pr=$(jq -r '.pr' "$entry") ticket=$(jq -r '.ticket' "$entry") author=$(jq -r '.author // ""' "$entry")
    code=0
    why=$(ORCH_FROM_QUEUE=1 "$ORCH_HOME/review-pr.sh" "$pr" "$ticket" ${author:+--author-model "$author"} 2>&1 > /dev/null) || code=$?
    case "$code" in
      0) rm -f "$entry"; return 0 ;;
      5)
        # "Not now" is no failure: the hour of failures, if one had begun, starts again.
        jq 'del(.failing_since)' "$entry" > "$entry.next" && mv "$entry.next" "$entry"
        ;;
      6) drop_queued_review "$entry" "$pr" "$ticket" "$why" ;;
      *)
        # Only a time in the form this script writes counts: anything else
        # (unreadable, or a word date would take for a time to come) is no
        # time, and the hour starts now.
        since=$(jq -r '.failing_since // empty' "$entry")
        if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]]; then since=$(date -d "$since" +%s 2> /dev/null) || since=; else since=; fi
        if [ -z "$since" ]; then
          jq --arg since "$(now_utc)" '.failing_since = $since' "$entry" > "$entry.next" && mv "$entry.next" "$entry"
        elif [ $(( $(date +%s) - since )) -ge 3600 ]; then
          drop_queued_review "$entry" "$pr" "$ticket" "it kept failing for an hour, the last time: $why"
        fi
        ;;
    esac
  done < <(for entry in "$queue"/*.json; do printf '%s\t%s\n' "$(jq -r '.at // ""' "$entry")" "$entry"; done | sort | cut -f2)
  return 0
}

drop_queued_review() {
  ledger event --kind review_dropped --ticket "$3" --detail "the review of #$2 left the queue without opening: $(tr '\n' ' ' <<<"$4" | cut -c1-400)"
  rm -f "$1"
}

# open_queued_merges: the go-lives merge-pr.sh could not do at once, tried
# again now, oldest first, one a wake (a merge takes the host for a while).
# No model: the same script, with every check again. One that is refused for
# good leaves the queue: written to the ledger (merge_refused) and told to
# the lead at its next wake.
open_queued_merges() {
  local queue="$ORCH_STATE_DIR/merge-queue" entry pr ticket said code why hours since
  hours=$(conf_get merge queue_hours)
  [[ "$hours" =~ ^[0-9]+$ ]] || hours=24
  ls "$queue"/*.json > /dev/null 2>&1 || return 0
  while IFS= read -r entry; do
    if ! jq -e '(.pr | type) == "number" and (.ticket | type) == "string"' "$entry" > /dev/null 2>&1; then
      ledger event --kind merge_refused --detail "an entry of the queue of go-lives ($(basename "$entry")) cannot be read: removed, the go-live is to be asked for again"
      rm -f "$entry"
      continue
    fi
    pr=$(jq -r '.pr' "$entry") ticket=$(jq -r '.ticket' "$entry") said=$(jq -r '.announcement // ""' "$entry")
    code=0
    why=$(ORCH_FROM_QUEUE=1 "$ORCH_HOME/merge-pr.sh" "$pr" "$ticket" ${said:+"$said"} 2>&1 > /dev/null) || code=$?
    case "$code" in
      0) rm -f "$entry" "$queue/$pr.announcement.md"; return 0 ;;
      5)
        # It does not wait for ever. Only a time in the form merge-pr.sh
        # writes counts: anything else is no time, and it leaves too.
        since=$(jq -r '.at // ""' "$entry")
        if ! [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || [[ "$since" < "$(date -u -d "$hours hours ago" +%Y-%m-%dT%H:%M:%SZ)" ]]; then
          ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "the go-live of #$pr waited more than $hours hours in the queue ($(tr '\n' ' ' <<<"$why" | cut -c1-300)): it left the queue, and is to be asked for again"
          rm -f "$entry" "$queue/$pr.announcement.md"
        fi
        ;;
      *)
        ledger event --kind merge_refused --ticket "$ticket" --value "$pr" --detail "the go-live of #$pr left the queue without being done: $(tr '\n' ' ' <<<"$why" | cut -c1-400)"
        rm -f "$entry" "$queue/$pr.announcement.md"
        ;;
    esac
  done < <(for entry in "$queue"/*.json; do printf '%s\t%s\n' "$(jq -r '.at // ""' "$entry" 2> /dev/null)" "$entry"; done | sort | cut -f2)
  return 0
}

# github_down: what GitHub says is down among the parts the dispatcher needs,
# as its public status page has it: nothing when all is well. Exit 2 when the
# page cannot be read, which says nothing either way. A slowdown is not an
# outage.
github_down() {
  local page
  page=$(curl -fsS --max-time 8 "${ORCH_GITHUB_STATUS:-https://www.githubstatus.com/api/v2/components.json}" 2> /dev/null) || return 2
  jq -e '.components | type == "array"' <<<"$page" > /dev/null 2>&1 || return 2
  jq -r '[.components[] | select(.name == "Git Operations" or .name == "Pull Requests" or .name == "Actions" or .name == "API Requests")
      | select(.status == "major_outage" or .status == "partial_outage") | .name] | join(", ")' <<<"$page"
}

# talk_open: is a discussion open in the lane of the lead? talk.sh writes
# "opening <time>" in the mark before it opens the terminal (good for five
# minutes: Orca may take two to open one), talk-run.sh puts
# its process there and takes the mark away when the conversation ends. A
# mark whose process is gone, or is no longer a conversation (its number was
# given to something else), or an opening that never came, holds nothing.
talk_open() {
  local mark="$ORCH_STATE_DIR/wake/talk" first second
  [ -r "$mark" ] || return 1
  read -r first second 2> /dev/null < "$mark" || return 1
  if [ "$first" = opening ]; then
    [ $(( $(date +%s) - ${second:-0} )) -lt "${ORCH_TALK_OPENING:-300}" ]
  else
    [[ "$first" =~ ^[0-9]+$ ]] && tr '\0' ' ' < "/proc/$first/cmdline" 2> /dev/null | grep -q "talk-run.sh"
  fi
}

# close_old_terminals <lane> <kept>: closes in Orca the terminals of the past
# sessions of a lane, all but the last <kept> (run folders are named by their
# time). What a session said stays in its run folder and in the ledger. A
# terminal is closed once; one that Orca no longer shows is forgotten.
close_old_terminals() {
  local lane=$1 kept=$2 env dir handle listed
  while IFS= read -r env; do
    dir=$(dirname "$env")
    [ -s "$dir/terminal.handle" ] && [ ! -f "$dir/terminal.closed" ] || continue
    handle=$(sed -n '1p' "$dir/terminal.handle")
    if orca terminal close --terminal "$handle" --tab > /dev/null 2>&1 \
      || { listed=$(orca terminal list --json 2> /dev/null) && jq -e --arg handle "$handle" '(.result.terminals // .result) | type == "array" and (any(.handle == $handle) | not)' <<<"$listed" > /dev/null 2>&1; }; then
      now_utc > "$dir/terminal.closed"
    fi
  done < <(grep -l -x -F "ORCH_LANE=$lane" "$ORCH_STATE_DIR"/runs/*/lane.env 2> /dev/null | head -n "-$kept")
  return 0
}

# guard_text <file>: refuses, without showing any value, a text the guard of
# the repository would not let out (private terms, secrets, IBANs, addresses,
# phone numbers). For anything a script sends to an outside service: Linear,
# GitHub.
guard_text() {
  local dir ref tool_ref settings terms_setting allowed_setting guard_key
  dir=$(mktemp -d)
  # 1. Its code is the tool's own (lib/guard/). When the tool is a checkout
  # that follows a branch ([update] base), it is the code of that branch,
  # not the files of the checkout: a copy edited by hand (which
  # self-update.sh then refuses to move) does not run an edited guard. When
  # that cannot be (the branch does not carry the guard yet, the tool is a
  # folder of a larger repository), the files are what runs, and it is said
  # each time. ORCH_GUARD_TOOL_REF= (empty) asks for the files: the tests of
  # a change to the guard itself.
  if [ -n "${ORCH_GUARD_TOOL_REF+set}" ]; then tool_ref=$ORCH_GUARD_TOOL_REF; else tool_ref=$(conf_get update base 2> /dev/null || true) tool_ref=${tool_ref:-origin/main}; fi
  if [ -n "$tool_ref" ] && [ "$(git -C "$ORCH_HOME" rev-parse --show-toplevel 2> /dev/null)" = "$(cd "$ORCH_HOME" && pwd -P)" ] \
    && git -C "$ORCH_HOME" cat-file -e "$tool_ref:lib/guard/codex-guard.mjs" 2> /dev/null; then
    git -C "$ORCH_HOME" show "$tool_ref:lib/guard/codex-guard.mjs" > "$dir/codex-guard.mjs" 2> /dev/null || true
    git -C "$ORCH_HOME" show "$tool_ref:lib/guard/private-terms.mjs" > "$dir/private-terms.mjs" 2> /dev/null || true
  else
    [ -z "$tool_ref" ] || echo "$(basename "$0"): the guard runs from the files of this checkout ($ORCH_HOME does not follow $tool_ref, or that branch does not carry lib/guard/)" >&2
    cp "$ORCH_HOME/lib/guard/codex-guard.mjs" "$ORCH_HOME/lib/guard/private-terms.mjs" "$dir/" 2> /dev/null || true
  fi
  [ -s "$dir/codex-guard.mjs" ] && [ -s "$dir/private-terms.mjs" ] || {
    rm -rf "$dir"
    echo "$(basename "$0"): not sent, the guard of the tool (lib/guard/) could not be read" >&2
    return 1
  }
  # 2. What it must know of the project (the fingerprints of its private
  # terms, the values checked by hand as fictitious) is the project's, and
  # is read from what is committed on the default branch of its remote,
  # never from the files of a checkout (a session runs code there) and
  # never at a place a settings file names. Which files: [guard] terms and
  # allowed, as the project's own settings say there (.ferme/agents.conf),
  # else as the example of the tool says. Each names a file, or says
  # « none »; a key left out or misspelt is a refusal, never « no list ».
  # ORCH_GUARD_REF names another ref: the tests, and a project without a
  # remote.
  ref=${ORCH_GUARD_REF:-$(git -C "$ORCH_REPO" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2> /dev/null || true)}
  ref=${ref:-origin/main}
  if git -C "$ORCH_REPO" cat-file -e "$ref:.cleared/agents.conf" 2> /dev/null; then
    git -C "$ORCH_REPO" show "$ref:.cleared/agents.conf" > "$dir/settings.conf" 2> /dev/null || true
    settings=$dir/settings.conf
  elif git -C "$ORCH_REPO" cat-file -e "$ref:.ferme/agents.conf" 2> /dev/null; then
    git -C "$ORCH_REPO" show "$ref:.ferme/agents.conf" > "$dir/settings.conf" 2> /dev/null || true
    settings=$dir/settings.conf
  else
    settings=$dir/settings.conf
  fi
  [ -f "$settings" ] || : > "$settings"
  while IFS= read -r guard_key; do
    case "$guard_key" in salt|terms|allowed|token_patterns) ;; *) echo "$(basename "$0"): unknown [guard] key $guard_key in committed project configuration" >&2; rm -rf "$dir"; return 1 ;; esac
  done < <(awk '/^\[/{inside=($0=="[guard]");next} inside && $0 !~ /^[[:space:]]*#/ && index($0,"=") {key=substr($0,1,index($0,"=")-1);gsub(/^[[:space:]]+|[[:space:]]+$/,"",key);print key}' "$settings")
  terms_setting=$(conf_get_from guard terms "$settings" 2> /dev/null || true)
  allowed_setting=$(conf_get_from guard allowed "$settings" 2> /dev/null || true)
  if { [ -z "$terms_setting" ] || [ "$terms_setting" = none ]; } && { [ -z "$allowed_setting" ] || [ "$allowed_setting" = none ]; }; then
    echo '{"disabled":true,"hashes":[]}' > "$dir/private-terms.json"
    echo '{"disabled":true,"hashes":[]}' > "$dir/codex-guard-allow.json"
    mkdir -p "$ORCH_STATE_DIR"
    (
      flock -w 30 9 || exit 1
      ledger init > /dev/null || exit 1
      if [ "$(ledger sql "select count(*) as n from events where kind = 'private_terms_disabled'" | jq -r '.[0].n')" = 0 ]; then
        ledger event --kind private_terms_disabled --detail 'No committed private-term fingerprint lists are configured for this project' || exit 1
      fi
    ) 9> "$ORCH_STATE_DIR/guard-disabled.lock" || { rm -rf "$dir"; return 1; }
  else
    if [ -z "$(conf_get_from guard salt "$settings" 2> /dev/null || true)" ]; then
      printf '%s\n' 'Missing committed [guard] salt: add [guard] salt = <random value> to the project agents.conf and commit it before using these fingerprint lists.' >&2
      rm -rf "$dir"
      return 1
    fi
    guard_list "$dir" "$ref" "$settings" terms private-terms.json "of private terms" \
      && guard_list "$dir" "$ref" "$settings" allowed codex-guard-allow.json "of allowed values" || {
      rm -rf "$dir"
      return 1
    }
  fi
  if ! ORCH_GUARD_REF="$ref" node "$dir/codex-guard.mjs" --strict "$1" >&2; then
    rm -rf "$dir"
    echo "$(basename "$0"): not sent, the guard refuses this text" >&2
    return 1
  fi
  rm -rf "$dir"
}

# guard_list <dir> <ref> <settings> <key> <file> <what>: one list of the
# project put where the guard reads it, as its settings name it.
guard_list() {
  local value
  value=$(conf_get_from guard "$4" "$3" 2> /dev/null || true)
  case "$(tr '[:upper:]' '[:lower:]' <<<"$value")" in
    "")
      echo "$(basename "$0"): not sent, the project names no list $6 ([guard] $4): write the path of the file, or « none »" >&2
      return 1
      ;;
    none) echo '{"disabled":true,"hashes":[]}' > "$1/$5" ;;
    *)
      git -C "$ORCH_REPO" show "$2:$value" > "$1/$5" 2> /dev/null || {
        echo "$(basename "$0"): not sent, the list $6 of the project ($value on $2) could not be read" >&2
        return 1
      }
      ;;
  esac
}

# open_terminal <worktree> <title> <command> [<ticket>]: opens a terminal of
# the lane in Orca and prints its handle. Orca only knows a new worktree a few
# seconds after git does, sometimes much later: the attempt is repeated for
# ORCH_ORCA_WAIT seconds (120), then made once more. A wait longer than
# ORCH_ORCA_SLOW seconds (30), and a failure, are written to the ledger.
open_terminal() {
  local worktree=$1 title=$2 command=$3 ticket=${4:-} wait=${ORCH_ORCA_WAIT:-120} step=${ORCH_ORCA_STEP:-5} slow=${ORCH_ORCA_SLOW:-30}
  local started answer waited last=
  started=$(date +%s)
  while :; do
    if answer=$(orca terminal create --worktree "path:$worktree" --title "$title" --command "$command" --json 2> /dev/null); then
      waited=$(( $(date +%s) - started ))
      if [ "$waited" -ge "$slow" ]; then
        ledger event --kind orca_terminal_delayed --ticket "$ticket" --value "$waited" --detail "$title: Orca took $waited s to open the terminal"
      fi
      jq -r '.. | objects | .handle? // empty' <<<"$answer" | sed -n '1p'
      return 0
    fi
    [ -z "$last" ] || break
    # Past the wait: one more attempt, then give up.
    if [ $(( $(date +%s) - started )) -ge "$wait" ]; then last=1; fi
    sleep "$step"
  done
  ledger event --kind orca_terminal_failed --ticket "$ticket" --value "$(( $(date +%s) - started ))" --detail "$title: Orca did not open a terminal in $worktree"
  return 1
}

# lane_deps <worktree>: the dependencies of the project, at hand in that
# worktree. A lane has no network command and may install nothing: the
# dispatcher installs them, once for a given lock file, in the state, and
# every worktree links to them.
# What is installed is what the base asks for, never what the lane wrote: an
# install fetches and runs code with the rights of the dispatcher, outside
# what a lane may do. No script of a package is run either, and nobody
# writes in what is shared but for the scratch folders a build needs. A lane
# whose lock file differs from the one of the base is told (deps_note): what
# it adds is installed once it is on the base. A package that needs its own
# install script to work would fail in the lanes and pass in the checks of
# the pull request, which install it whole: that is where to look first.
# Nothing to do for a project without a lock file.
lane_deps() {
  local worktree=$1 base hash dir new exclude scratch other used
  deps_note=
  base=$(conf_get lanes base)
  git -C "$worktree" cat-file -e "$base:package.json" 2> /dev/null && git -C "$worktree" cat-file -e "$base:package-lock.json" 2> /dev/null || return 0
  hash=$({ git -C "$worktree" show "$base:package.json"; git -C "$worktree" show "$base:package-lock.json"; } | sha256sum | cut -c1-16)
  dir="$ORCH_STATE_DIR/deps/$hash"
  mkdir -p "$ORCH_STATE_DIR/deps"
  (
    flock -w 900 7 || exit 1
    if [ ! -d "$dir/node_modules" ]; then
      new=$(mktemp -d "$ORCH_STATE_DIR/deps/.new.XXXXXX")
      git -C "$worktree" show "$base:package.json" > "$new/package.json"
      git -C "$worktree" show "$base:package-lock.json" > "$new/package-lock.json"
      if (cd "$new" && npm ci --ignore-scripts --no-audit --no-fund > "$new/install.log" 2>&1) && [ -d "$new/node_modules" ]; then
        mv "$new" "$dir"
      else
        echo "$(basename "$0"): the dependencies could not be installed (see $new/install.log)" >&2
        exit 1
      fi
    fi
    # Shared by every lane: read-only, but for where a build writes.
    if [ -w "$dir/node_modules" ]; then
      for scratch in .vite .vite-temp .cache; do mkdir -p "$dir/node_modules/$scratch"; done
      chmod -R a-w "$dir/node_modules"
      for scratch in .vite .vite-temp .cache; do chmod -R u+w "$dir/node_modules/$scratch"; done
    fi
    # Linked while the lock is held: the tidying below, run by another lane
    # being opened, then sees it in use.
    ln -sfn "$dir/node_modules" "$worktree/node_modules"
    # Those of a lock file no worktree uses any more go, once older than an
    # hour: they are only a copy of what can be installed again, and they
    # would pile up.
    used=$(git -C "$ORCH_REPO" worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r other; do readlink "$other/node_modules" 2> /dev/null || true; done)
    for other in "$ORCH_STATE_DIR/deps"/*/; do
      other=${other%/}
      [[ "$(basename "$other")" =~ ^[0-9a-f]{16}$ ]] && [ "$other" != "$dir" ] || continue
      grep -qxF -- "$other/node_modules" <<<"$used" && continue
      [ -n "$(find "$other" -maxdepth 0 -mmin +60 2> /dev/null)" ] || continue
      chmod -R u+w "$other" 2> /dev/null || true
      rm -rf "$other" 2> /dev/null || true
    done
    # A tidying that fails never keeps a lane from opening.
    true
  ) 7> "$ORCH_STATE_DIR/deps/lock" || return 1
  # The link is not a change of the lane (an ignore rule written for a folder does not hold a link).
  exclude="$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
  mkdir -p "$(dirname "$exclude")"
  grep -qxF '/node_modules' "$exclude" 2> /dev/null || echo '/node_modules' >> "$exclude"
  if ! git -C "$worktree" show "$base:package.json" | cmp -s - "$worktree/package.json" || ! git -C "$worktree" show "$base:package-lock.json" | cmp -s - "$worktree/package-lock.json"; then
    deps_note="Les dépendances installées sont celles de la branche principale : ton \`package.json\` ou ton \`package-lock.json\` en diffère. Ce que tu y ajoutes n'est pas installé ici (rien n'est installé à partir de ce qu'une équipe écrit) : dis-le dans ton compte rendu, les vérifications automatiques de ta PR l'installeront."
  fi
}

# only_base_merges <commit> <head>: the head holds that commit, and adds on
# top of it nothing but merges of the base that changed nothing by
# themselves. A commit of the lane itself would have been seen by nobody;
# nor would the branch of another lane, which brings commits of its own
# (of one parent, refused below) or a merge that changed something by
# itself (refused too).
only_base_merges() {
  local added parents auto base
  base=$(conf_get lanes base)
  [ "$1" != "$2" ] || return 0
  git -C "$ORCH_REPO" merge-base --is-ancestor "$1" "$2" 2> /dev/null || return 1
  while IFS= read -r added; do
    read -r -a parents < <(git -C "$ORCH_REPO" rev-list --parents -n 1 "$added" | cut -d' ' -f2-)
    [ "${#parents[@]}" = 2 ] || return 1
    auto=$(git -C "$ORCH_REPO" merge-tree --write-tree "${parents[0]}" "${parents[1]}" 2> /dev/null) || return 1
    [ "$auto" = "$(git -C "$ORCH_REPO" rev-parse "$added^{tree}")" ] || return 1
  done < <(git -C "$ORCH_REPO" rev-list "$1..$2" --not "$base")
}

# owner_name: how the agents name the user in what they write (the first
# line of their comments, what the lead is told): [linear] owner_name, his
# first name for instance. The tool carries no name of its own: with no
# setting he is « l'utilisateur ». owner_name_first is the same at the
# start of a sentence.
owner_name() {
  local name unnamed="the user"
  name=$(conf_get owner name)
  [ -n "$name" ] || name=$(conf_get linear owner_name)
  echo "${name:-$unnamed}"
}
owner_name_first() {
  local name
  name=$(owner_name)
  echo "${name^}"
}

# lane_record <ticket>: where what is known of the lane of a ticket is kept
# (its branch, the branch its work is sent to, its pull request, its runs).
# It outlives the worktree: a lane the tidying closed is opened again from it.
lane_record() { echo "$ORCH_STATE_DIR/lanes/$1.json"; }

# teams_of <ticket>: the lanes at work on a ticket, one a line, as
# « <team> <its pull request, or 0> »: the first (1), and the second when
# the user gave the ticket to two teams (<ticket>.2). A lane that is over
# (its record says closed) is no longer one of them.
teams_of() {
  local one team
  for one in "$1" "$1.2"; do
    team=1
    [ "$one" = "$1" ] || team=2
    jq -r --arg team "$team" 'select(type == "object" and (.closed // "") == "") | "\($team) \(.pr // 0)"' "$(lane_record "$one")" 2> /dev/null || true
  done
}

# quoted <file>: a text handed to a model as what somebody wrote, line by
# line under a mark: none of its lines is an order of another kind.
quoted() { sed 's/^/    | /' "$1"; }

# Lanes opened by the dispatcher: branches named <role>/<ticket>.
dispatcher_lanes() {
  local roles
  roles=$(conf_keys roles | paste -sd'|')
  # A worktree named .base-<ticket> is the dispatcher's own, for the time of
  # a merge (flow-lanes.sh): it has the branch of a lane, and is not one.
  git -C "$ORCH_REPO" worktree list --porcelain | awk '/^worktree /{n = split($0, part, "/"); own = part[n] ~ /^\.base-/} /^branch refs\/heads\//{if (!own) print substr($0, 19)}' | grep -E "^($roles)/" || true
}

# Those that take one of the max_lanes places: the roles of [limits]
# counted_roles (every role when it is not set). A lane that only watches or
# reads, like the project lead's, does not hold a place.
counted_lanes() {
  local counted
  counted=$(conf_get limits counted_roles | tr -s ' ' '|')
  if [ -z "$counted" ]; then dispatcher_lanes; else dispatcher_lanes | grep -E "^($counted)/" || true; fi
}

# The line by which the user says what a ticket may cost, as he writes it:
# « Plafond 80 », « Plafond : 80 $ », « plafond: 80,5 », alone on its line
# (the spaces a French keyboard puts before « : » and « $ » included).
# A line that goes on is a sentence, and sets nothing (« plafond 80 % de
# l'abonnement », « plafond 3 niveaux de prix »). cap_line is the pattern,
# given to jq as $cap; cap_only is the jq test of a comment that says
# nothing else: it sets the cap, and is no word for the lane.
cap_line='^[ \t\x{00A0}\x{202F}]*plafond[ \t\x{00A0}\x{202F}]*:?[ \t\x{00A0}\x{202F}]*([0-9]+(?:[.,][0-9]+)?)[ \t\x{00A0}\x{202F}]*(?:\$|€|usd|dollars?)?[ \t\x{00A0}\x{202F}]*[.!]?[ \t\x{00A0}\x{202F}]*\r?$'
# Two more lines of his are read by the dispatcher the same way, alone on
# their line: « Équipes : les deux » (or « Deux équipes ») gives the ticket
# to two teams that work each on its own, and « Équipe 1 » or « Équipe 2 »
# says which of the two results goes live. teams_line and team_line are
# their patterns. cap_only is the jq test of a comment that says nothing but
# such lines: it is read by the dispatcher, and is no word for a lane.
blank='[ \t\x{00A0}\x{202F}]*'
teams_line="^$blank(?:[éÉeE]quipes?$blank:?$blank(?:les$blank)?deux|deux$blank[éÉeE]quipes)$blank[.!]?$blank\\r?\$"
team_line="^$blank[éÉeE]quipe$blank:?$blank([12])$blank[.!]?$blank\\r?\$"
cap_only='(.body | [split("\n")[] | select(test("^\\s*$") | not)] | (length > 0 and all(.[]; test("(?i)" + $cap) or test("(?i)'"${teams_line//\\/\\\\}"'") or test("(?i)'"${team_line//\\/\\\\}"'"))))'

# takes_a_place <role>: whether a lane of that role holds one of them, by the
# same rule: its exact name in counted_roles, or any role when none is set.
takes_a_place() {
  local counted
  counted=$(conf_get limits counted_roles)
  [ -z "$counted" ] || tr -s ' ' '\n' <<<"$counted" | grep -qxF -- "$1"
}
