#!/usr/bin/env bash
# The one script through which agents and scripts talk to Linear.
#
#   linear.sh issue <ticket>                    ticket as JSON (project, labels, state…)
#   linear.sh comment <ticket> <file|-> [<from>]  posts the file (or stdin) as a comment, prints its URL
#   linear.sh waiting                           tickets waiting for the user, as JSON
#   linear.sh changes <ISO time>                tickets touched since then, with their recent comments, as JSON
#   linear.sh list <state>                      the tickets in that state ("In Progress"…), as JSON
#
# Linear serves the comments of a ticket newest first: `first: n` is the n
# most recent ones, `last: n` the n oldest (checked on a long ticket).
#   linear.sh comments <ticket>                 its comments as JSON (id, createdAt, body)
#   linear.sh create <project> <label> <title> <file>   opens a ticket, prints its identifier and URL
#
# Nothing real goes to Linear, an outside service (decision of 2026-10-06):
# a comment is checked by the guard of the repository first (private terms,
# secrets, IBANs, addresses, phone numbers), taken from the trusted ref like
# scripts/codex-task.sh does. A refused text is not sent and stays on disk.
#
# Every comment starts with a line saying an agent wrote it: the key belongs
# to the user, so Linear shows his name, and a watcher must be able to tell
# these comments from his. Their ids are also kept in state/linear-comments.jsonl.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

# Only this one key is read from the secrets file. The file is never sourced:
# it also holds an API key that would move the model billing off the subscription.
key=${LINEAR_API_KEY:-}
if [ -z "$key" ]; then
  secrets=${ORCH_SECRETS_FILE:-$ORCH_REPO/.env.local}
  [ -f "$secrets" ] && key=$(sed -n 's/^LINEAR_API_KEY=//p' "$secrets" | head -n 1 | tr -d "\"'")
fi
[ -n "$key" ] || die "no LINEAR_API_KEY (environment, or ${ORCH_SECRETS_FILE:-$ORCH_REPO/.env.local})"

gql() {
  local response
  response=$(jq -n --arg query "$1" --argjson variables "${2:-{\}}" '{query: $query, variables: $variables}' \
    | curl -sS --max-time 30 -H @<(printf 'Authorization: %s' "$key") -H 'Content-Type: application/json' --data @- https://api.linear.app/graphql)
  if [ "$(jq -r 'has("errors")' <<<"$response" 2>/dev/null)" != false ]; then
    echo "linear: $(jq -r '.errors[0].message // "unreadable answer"' <<<"$response" 2>/dev/null || echo 'unreadable answer')" >&2
    return 1
  fi
  printf '%s\n' "$response"
}

ticket_ok() { [[ "$1" =~ ^[A-Z]+-[0-9]+$ ]] || die "\"$1\" is not a ticket identifier"; }

case "${1:-}" in
  issue)
    ticket_ok "$2"
    gql 'query($id: String!) { issue(id: $id) { id identifier title url state { name } project { name } labels { nodes { name } } } }' \
      "$(jq -nc --arg id "$2" '{id: $id}')" \
      | jq -c '.data.issue | {id, identifier, title, url, state: .state.name, project: (.project.name // null), labels: [.labels.nodes[].name]}'
    ;;
  comment)
    ticket_ok "$2"
    # "-": the text is read on stdin (an agent that may run this script, and
    # write no file).
    if [ "${3:-}" = - ]; then
      text_file=$(mktemp)
      trap 'rm -f "$text_file"' EXIT
      cat > "$text_file"
      set -- "$1" "$2" "$text_file" "${4:-${ORCH_SIGNED:-script}}"
    fi
    [ -f "$3" ] || die "no such file: $3"
    grep -q '[^[:space:]]' "$3" || die "nothing to post"
    from=${4:-${ORCH_SIGNED:-script}}
    # The user reads every comment: all the agents together write him no more
    # than a few an hour. Beyond, nothing is posted; what there is to say is
    # grouped in one comment, later.
    # Counted and posted under one lock: two agents at once do not both
    # take the last place. The limit holds without its setting (6). What
    # the user confirms himself (confirm-decision.sh) is his own word, not
    # one more message of an agent: it is never held back. Exit 4 tells the
    # caller apart from a failure: it keeps its text for a grouped comment.
    limit=$(conf_get linear comments_per_hour)
    mkdir -p "$ORCH_STATE_DIR"
    exec 9> "$ORCH_STATE_DIR/linear-comments.lock"
    flock -w 60 9 || die "another comment is being posted for too long"
    # The script of the user is told by what runs it, not by a word in a
    # command: the parent process is bash running that very file.
    [[ "$limit" =~ ^[0-9]+$ ]] || limit=6
    mapfile -d '' -t parent < "/proc/$PPID/cmdline" 2> /dev/null || parent=()
    if [ "$(basename "${parent[0]:-}")" != bash ] || [ "$(realpath -q "${parent[1]:-/nonexistent}" 2> /dev/null)" != "$(realpath "$ORCH_HOME/confirm-decision.sh")" ]; then
      recent=$(jq -R -r --arg since "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" 'fromjson? | select(.at > $since) | .at' "$ORCH_STATE_DIR/linear-comments.jsonl" 2> /dev/null | grep -c . || true)
      if [ "$recent" -ge "$limit" ]; then
        echo "$(basename "$0"): the user was already written $recent times in the last hour (limit: $limit): nothing posted. Group what there is to say in one comment, later" >&2
        exit 4
      fi
    fi
    guard_text "$3" || exit 1
    id=$(gql 'query($id: String!) { issue(id: $id) { id } }' "$(jq -nc --arg id "$2" '{id: $id}')" | jq -r '.data.issue.id // empty')
    [ -n "$id" ] || die "no such ticket: $2"
    body=$(printf '> Écrit par un agent (%s), pas par Makhtar.\n\n%s\n' "$from" "$(cat "$3")")
    created=$(gql 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }' \
      "$(jq -nc --arg issue "$id" --arg body "$body" '{input: {issueId: $issue, body: $body}}')")
    [ "$(jq -r '.data.commentCreate.success == true and (.data.commentCreate.comment.id | type) == "string"' <<<"$created")" = true ] || die "Linear did not record the comment"
    mkdir -p "$ORCH_STATE_DIR"
    jq -c --arg ticket "$2" --arg from "$from" --arg at "$(now_utc)" '.data.commentCreate.comment + {ticket: $ticket, from: $from, at: $at}' <<<"$created" >> "$ORCH_STATE_DIR/linear-comments.jsonl"
    jq -r '.data.commentCreate.comment.url' <<<"$created"
    ;;
  create)
    [ $# -eq 5 ] && [ -f "$5" ] || die "usage: linear.sh create <project> <label> <title> <description file>"
    title_file=$(mktemp)
    printf '%s\n' "$4" > "$title_file"
    guard_text "$title_file" && guard_text "$5" || { rm -f "$title_file"; exit 1; }
    rm -f "$title_file"
    found=$(gql 'query($team: String!, $project: String!, $label: String!) { teams(filter: {key: {eq: $team}}) { nodes { id } } projects(filter: {name: {eq: $project}}) { nodes { id } } issueLabels(filter: {name: {eq: $label}}) { nodes { id } } }' \
      "$(jq -nc --arg team "$(conf_get linear team)" --arg project "$2" --arg label "$3" '{team: $team, project: $project, label: $label}')")
    team_id=$(jq -r '.data.teams.nodes[0].id // empty' <<<"$found") project_id=$(jq -r '.data.projects.nodes[0].id // empty' <<<"$found") label_id=$(jq -r '.data.issueLabels.nodes[0].id // empty' <<<"$found")
    [ -n "$team_id" ] && [ -n "$project_id" ] && [ -n "$label_id" ] || die "team, project \"$2\" or label \"$3\" not found in Linear"
    description=$(printf '> Ticket ouvert par un agent (%s), pas par Makhtar.\n\n%s\n' "${ORCH_FROM:-script}" "$(cat "$5")")
    created=$(gql 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }' \
      "$(jq -nc --arg team "$team_id" --arg project "$project_id" --arg label "$label_id" --arg title "$4" --arg description "$description" '{input: {teamId: $team, projectId: $project, labelIds: [$label], title: $title, description: $description}}')")
    [ "$(jq -r '.data.issueCreate.success == true and (.data.issueCreate.issue.identifier | type) == "string"' <<<"$created")" = true ] || die "Linear did not open the ticket"
    mkdir -p "$ORCH_STATE_DIR"
    jq -c --arg at "$(now_utc)" '.data.issueCreate.issue + {at: $at}' <<<"$created" >> "$ORCH_STATE_DIR/linear-issues.jsonl"
    jq -r '.data.issueCreate.issue | "\(.identifier) \(.url)"' <<<"$created"
    ;;
  comments)
    ticket_ok "$2"
    gql 'query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id createdAt body url } } } }' \
      "$(jq -nc --arg id "$2" '{id: $id}')" | jq -c '.data.issue.comments.nodes'
    ;;
  changes)
    [[ "${2:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || die "usage: linear.sh changes <ISO time>"
    gql 'query($team: String!, $since: DateTimeOrDuration!) { issues(first: 50, orderBy: updatedAt, filter: {team: {key: {eq: $team}}, updatedAt: {gt: $since}}) { nodes { id identifier title url createdAt updatedAt description state { name } project { name } comments(first: 20) { nodes { id createdAt body url } } } } }' \
      "$(jq -nc --arg team "$(conf_get linear team)" --arg since "$2" '{team: $team, since: $since}')" \
      | jq -c '[.data.issues.nodes[] | {id, identifier, title, url, createdAt, updatedAt, description: ((.description // "") | .[0:1200]), state: .state.name, project: (.project.name // null), comments: [.comments.nodes[] | {id, createdAt, url, body}]}]'
    ;;
  list)
    [ -n "${2:-}" ] || die "usage: linear.sh list <state>"
    listed=$(gql 'query($team: String!, $state: String!) { issues(first: 100, orderBy: updatedAt, filter: {team: {key: {eq: $team}}, state: {name: {eq: $state}}}) { nodes { identifier title url updatedAt state { name } project { name } assignee { name } } } }' \
      "$(jq -nc --arg team "$(conf_get linear team)" --arg state "$2" '{team: $team, state: $state}')" \
      | jq -c '[.data.issues.nodes[] | {identifier, title, url, updatedAt, state: .state.name, project: (.project.name // null), assignee: (.assignee.name // null)}]')
    # One page only: a full page may not be everything.
    [ "$(jq length <<<"$listed")" -lt 100 ] || echo "$(basename "$0"): 100 tickets in the state \"$2\": the list may be cut short" >&2
    printf '%s\n' "$listed"
    ;;
  waiting)
    team=$(conf_get linear team)
    gql 'query($team: String!) { viewer { assignedIssues(first: 50, filter: {team: {key: {eq: $team}}, state: {name: {eq: "In Review"}}}) { nodes { identifier title url updatedAt comments(first: 1) { nodes { url createdAt } } } } } }' \
      "$(jq -nc --arg team "$team" '{team: $team}')" \
      | jq -c '[.data.viewer.assignedIssues.nodes[] | {identifier, title, url: (.comments.nodes[0].url // .url), since: (.comments.nodes[0].createdAt // .updatedAt)}] | sort_by(.since)'
    ;;
  *)
    die "usage: linear.sh issue <ticket> | comment <ticket> <file> [<from>] | comments <ticket> | create <project> <label> <title> <file> | changes <ISO time> | list <state> | waiting"
    ;;
esac
