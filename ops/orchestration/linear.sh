#!/usr/bin/env bash
# The one script through which agents and scripts talk to Linear.
#
#   linear.sh issue <ticket>                    ticket as JSON (project, labels, state…)
#   linear.sh comment <ticket> <file> [<from>]  posts the file as a comment, prints its URL
#   linear.sh waiting                           tickets waiting for the user, as JSON
#   linear.sh comments <ticket>                 its comments as JSON (id, createdAt, body)
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
    | curl -sS --max-time 30 -H "Authorization: $key" -H 'Content-Type: application/json' --data @- https://api.linear.app/graphql)
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
    [ -f "$3" ] || die "no such file: $3"
    from=${4:-script}
    id=$(gql 'query($id: String!) { issue(id: $id) { id } }' "$(jq -nc --arg id "$2" '{id: $id}')" | jq -r '.data.issue.id')
    body=$(printf '> Écrit par un agent (%s), pas par Makhtar.\n\n%s\n' "$from" "$(cat "$3")")
    created=$(gql 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }' \
      "$(jq -nc --arg issue "$id" --arg body "$body" '{input: {issueId: $issue, body: $body}}')")
    mkdir -p "$ORCH_STATE_DIR"
    jq -c --arg ticket "$2" --arg from "$from" --arg at "$(now_utc)" '.data.commentCreate.comment + {ticket: $ticket, from: $from, at: $at}' <<<"$created" >> "$ORCH_STATE_DIR/linear-comments.jsonl"
    jq -r '.data.commentCreate.comment.url' <<<"$created"
    ;;
  comments)
    ticket_ok "$2"
    gql 'query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id createdAt body url } } } }' \
      "$(jq -nc --arg id "$2" '{id: $id}')" | jq -c '.data.issue.comments.nodes'
    ;;
  waiting)
    team=$(conf_get linear team)
    gql 'query($team: String!) { viewer { assignedIssues(first: 50, filter: {team: {key: {eq: $team}}, state: {name: {eq: "In Review"}}}) { nodes { identifier title url updatedAt comments(last: 1) { nodes { url createdAt } } } } } }' \
      "$(jq -nc --arg team "$team" '{team: $team}')" \
      | jq -c '[.data.viewer.assignedIssues.nodes[] | {identifier, title, url: (.comments.nodes[0].url // .url), since: (.comments.nodes[0].createdAt // .updatedAt)}] | sort_by(.since)'
    ;;
  *)
    die "usage: linear.sh issue <ticket> | comment <ticket> <file> [<from>] | comments <ticket> | waiting"
    ;;
esac
