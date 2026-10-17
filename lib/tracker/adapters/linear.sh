#!/usr/bin/env bash
# The one script through which agents and scripts talk to Linear.
#
#   linear.sh issue <ticket>                    ticket as JSON (project, labels, state…)
#   linear.sh comment <ticket> <file|-> [<from>]  posts the file (or stdin) as a comment, prints its URL
#   linear.sh waiting                           tickets in the status that asks the user, as JSON
#   linear.sh changes <ISO time>                tickets touched since then, with their recent comments, as JSON
#   linear.sh list <state>                      the tickets in that state ("In Progress"…), as JSON
#
# Linear serves the comments of a ticket newest first: `first: n` is the n
# most recent ones, `last: n` the n oldest (checked on a long ticket).
#   linear.sh comments <ticket>                 its comments as JSON (id, createdAt, editedAt, body, byOwner)
#   linear.sh create <project> <label> <title> <file>   opens a ticket, prints its identifier and URL
#   linear.sh label-actors <ticket>             who set each label and the project, as JSON ({labels: {name: {kind, id}}, project})
#
# Nothing real goes to Linear, an outside service (decision of 2026-10-06):
# a comment is checked by the guard of the repository first (private terms,
# secrets, IBANs, addresses, phone numbers), taken from the trusted ref like
# scripts/codex-task.sh does. A refused text is not sent and stays on disk.
#
# Every comment starts with a line saying an agent wrote it: the key belongs
# to the user, so Linear shows his name, and a watcher must be able to tell
# these comments from his. Their ids are also kept in state/tracker-comments.jsonl.
set -euo pipefail
. "$(cd "$(dirname "$0")/../../.." && pwd)/lib/common.sh"
[ -n "$(conf_get tracker team)" ] || die "Missing required [tracker] team for Linear"

# Under whose name the scripts act. The application of the agents when the
# project has one (its identifier and its secret): everything an agent does
# then shows under the name of the agents, never under the one of a person,
# and a move of the user can be told from theirs. Otherwise the key of a
# person: the tracker then cannot tell him from an agent (« shared »), and
# merge-pr.sh can be told to read no agreement from it ([merge]
# separate_identity). What the environment gives comes before the file of
# secrets; of that file only these names are read, and it is never sourced:
# it also holds an API key that would move the model billing off the
# subscription. Half of an application is an error, not a reason to fall
# back in silence on the key of a person.
secrets=${CLEARED_SECRETS_FILE:-${ORCH_SECRETS_FILE:-$ORCH_REPO/.env.local}}
secret_of() { [ -f "$secrets" ] && sed -n "s/^$1=//p" "$secrets" | head -n 1 | tr -d "\"'"; }
app_id=${LINEAR_APP_CLIENT_ID:-} app_secret=${LINEAR_APP_CLIENT_SECRET:-} key=${LINEAR_API_KEY:-}
if [ -z "$app_id$app_secret$key" ]; then
  app_id=$(secret_of LINEAR_APP_CLIENT_ID) || app_id=
  app_secret=$(secret_of LINEAR_APP_CLIENT_SECRET) || app_secret=
  key=$(secret_of LINEAR_API_KEY) || key=
fi
if [ -n "$app_id$app_secret" ]; then
  [ -n "$app_id" ] || die "LINEAR_APP_CLIENT_SECRET without LINEAR_APP_CLIENT_ID (environment, or $secrets)"
  [ -n "$app_secret" ] || die "LINEAR_APP_CLIENT_ID without LINEAR_APP_CLIENT_SECRET (environment, or $secrets)"
  identity=app
else
  [ -n "$key" ] || die "no application of the agents (LINEAR_APP_CLIENT_ID, LINEAR_APP_CLIENT_SECRET) and no LINEAR_API_KEY (environment, or $secrets)"
  identity=shared
fi

# The token of the application: asked for with its secret, which never is on
# a command line, kept with the state for half a day, readable by its owner
# alone, and asked for again when it is older, or once when the tracker
# refuses it.
app_token() {
  local kept="$ORCH_STATE_DIR/tracker-token.json" token answer app
  # The token kept is the one of this application: another identifier, another token.
  app=$(printf '%s' "$app_id" | sha256sum | cut -c1-16)
  if [ "${1:-}" != new ] && [ -s "$kept" ] && [ "$(jq -r '.app // ""' "$kept" 2> /dev/null)" = "$app" ] && [[ "$(jq -r '.at // ""' "$kept" 2> /dev/null)" > "$(date -u -d '12 hours ago' +%Y-%m-%dT%H:%M:%SZ)" ]]; then
    jq -r '.token' "$kept"
    return 0
  fi
  answer=$(printf 'grant_type=client_credentials&scope=read,write&client_id=%s&client_secret=%s' "$(jq -rn --arg v "$app_id" '$v | @uri')" "$(jq -rn --arg v "$app_secret" '$v | @uri')" \
    | curl -sS --max-time 30 -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data @- https://api.linear.app/oauth/token) || return 1
  token=$(jq -r '.access_token // empty' <<<"$answer" 2> /dev/null)
  [ -n "$token" ] || { echo "linear: no token for the application of the agents ($(jq -r '.error_description // .error // "unreadable answer"' <<<"$answer" 2> /dev/null || echo 'unreadable answer'))" >&2; return 1; }
  mkdir -p "$ORCH_STATE_DIR"
  (umask 077; jq -n --arg token "$token" --arg at "$(now_utc)" --arg app "$app" '{token: $token, at: $at, app: $app}' > "$kept.part") && mv "$kept.part" "$kept"
  printf '%s\n' "$token"
}

gql_once() {
  jq -n --arg query "$1" --argjson variables "${2:-{\}}" '{query: $query, variables: $variables}' \
    | curl -sS --max-time 30 -H @<(printf 'Authorization: %s' "$3") -H 'Content-Type: application/json' --data @- https://api.linear.app/graphql
}

gql() {
  local response authorization
  if [ "$identity" = app ]; then authorization="Bearer $(app_token)" || return 1; else authorization=$key; fi
  response=$(gql_once "$1" "${2:-}" "$authorization")
  # A token the tracker refuses (the secret changed, the application was
  # installed again) is thrown away and asked for again, once. Linear
  # answers a refused token with this code in a JSON body, under HTTP 401
  # (tried with a made-up token on 2026-10-08).
  if [ "$identity" = app ] && [ "$(jq -r '[.errors[]?.extensions.code] | index("AUTHENTICATION_ERROR") != null' <<<"$response" 2>/dev/null)" = true ]; then
    authorization="Bearer $(app_token new)" || return 1
    response=$(gql_once "$1" "${2:-}" "$authorization")
  fi
  if [ "$(jq -r 'has("errors")' <<<"$response" 2>/dev/null)" != false ]; then
    echo "linear: $(jq -r '.errors[0].message // "unreadable answer"' <<<"$response" 2>/dev/null || echo 'unreadable answer')" >&2
    return 1
  fi
  printf '%s\n' "$response"
}

# Who the user is, for the tracker: the settings of the project say it. With
# the application of the agents it must be said: the one that asks no longer
# is him.
owner_id() {
  local owner
  owner=$(conf_get tracker owner_id)
  [ -n "$owner" ] || [ "$identity" != app ] || { echo "$(basename "$0"): [tracker] owner_id is not set: with the application of the agents, who the user is must be written in the settings" >&2; return 1; }
  printf '%s\n' "$owner"
}

ticket_ok() { [[ "$1" =~ ^[A-Z]+-[0-9]+$ ]] || die "\"$1\" is not a ticket identifier"; }

case "${1:-}" in
  download-capture)
    # The asset remains private on Linear. Read it with the same identity as
    # GraphQL; the token is supplied through a curl header file descriptor.
    [[ "${2:-}" == https://uploads.linear.app/* ]] && [[ "$2" != *"@"* ]] && [[ "$2" != *"#"* ]] || die "capture URL is outside uploads.linear.app"
    if [ "$identity" = app ]; then authorization="Bearer $(app_token)"; else authorization=$key; fi
    curl -sS --fail --max-time 15 --max-filesize 5000000 -H @<(printf 'Authorization: %s' "$authorization") "$2"
    ;;
  identity)
    # app: the scripts act under the name of the agents. shared: under the
    # one of a person, whom the tracker cannot tell from an agent.
    echo "$identity"
    ;;
  issue)
    ticket_ok "$2"
    gql 'query($id: String!) { issue(id: $id) { id identifier title url description createdAt updatedAt state { name } project { name } labels { nodes { name } } } }' \
      "$(jq -nc --arg id "$2" '{id: $id}')" \
      | jq -c '.data.issue | {id, identifier, title, url, state: .state.name, project: (.project.name // null), labels: [.labels.nodes[].name], createdAt, updatedAt, description: (.description // "")}'
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
    limit=$(conf_get tracker comments_per_hour)
    mkdir -p "$ORCH_STATE_DIR"
    exec 9> "$ORCH_STATE_DIR/tracker-comments.lock"
    flock -w 60 9 || die "another comment is being posted for too long"
    # The script of the user is told by what runs it, not by a word in a
    # command: the parent process is bash running that very file.
    [[ "$limit" =~ ^[0-9]+$ ]] || limit=6
    mapfile -d '' -t parent < "/proc/$PPID/cmdline" 2> /dev/null || parent=()
    if [ "$(basename "${parent[0]:-}")" != bash ] || [ "$(realpath -q "${parent[1]:-/nonexistent}" 2> /dev/null)" != "$(realpath "$ORCH_HOME/confirm-decision.sh")" ]; then
      recent=$(jq -R -r --arg since "$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" 'fromjson? | select(.at > $since) | .at' "$ORCH_STATE_DIR/tracker-comments.jsonl" 2> /dev/null | grep -c . || true)
      if [ "$recent" -ge "$limit" ]; then
        echo "$(basename "$0"): the user was already written $recent times in the last hour (limit: $limit): nothing posted. Group what there is to say in one comment, later" >&2
        exit 4
      fi
    fi
    guard_text "$3" || exit 1
    id=$(gql 'query($id: String!) { issue(id: $id) { id } }' "$(jq -nc --arg id "$2" '{id: $id}')" | jq -r '.data.issue.id // empty')
    [ -n "$id" ] || die "no such ticket: $2"
    body=$(user_message agent_comment "from=$from" "owner=$(owner_name)" "body=$(cat "$3")")
    created=$(gql 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }' \
      "$(jq -nc --arg issue "$id" --arg body "$body" '{input: {issueId: $issue, body: $body}}')")
    [ "$(jq -r '.data.commentCreate.success == true and (.data.commentCreate.comment.id | type) == "string"' <<<"$created")" = true ] || die "Linear did not record the comment"
    mkdir -p "$ORCH_STATE_DIR"
    jq -c --arg ticket "$2" --arg from "$from" --arg at "$(now_utc)" '.data.commentCreate.comment + {ticket: $ticket, from: $from, at: $at}' <<<"$created" >> "$ORCH_STATE_DIR/tracker-comments.jsonl"
    jq -r '.data.commentCreate.comment.url' <<<"$created"
    ;;
  create)
    [ $# -eq 5 ] && [ -f "$5" ] || die "usage: linear.sh create <project> <label> <title> <description file>"
    title_file=$(mktemp)
    printf '%s\n' "$2" "$3" "$4" > "$title_file"
    guard_text "$title_file" && guard_text "$5" || { rm -f "$title_file"; exit 1; }
    rm -f "$title_file"
    found=$(gql 'query($team: String!, $project: String!, $label: String!) { teams(filter: {key: {eq: $team}}) { nodes { id } } projects(filter: {name: {eq: $project}}) { nodes { id } } issueLabels(filter: {name: {eq: $label}}) { nodes { id } } }' \
      "$(jq -nc --arg team "$(conf_get tracker team)" --arg project "$2" --arg label "$3" '{team: $team, project: $project, label: $label}')")
    team_id=$(jq -r '.data.teams.nodes[0].id // empty' <<<"$found") project_id=$(jq -r '.data.projects.nodes[0].id // empty' <<<"$found") label_id=$(jq -r '.data.issueLabels.nodes[0].id // empty' <<<"$found")
    [ -n "$team_id" ] && [ -n "$project_id" ] && [ -n "$label_id" ] || die "team, project \"$2\" or label \"$3\" not found in Linear"
    description=$(user_message agent_ticket "from=${ORCH_FROM:-script}" "owner=$(owner_name)" "body=$(cat "$5")")
    created=$(gql 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }' \
      "$(jq -nc --arg team "$team_id" --arg project "$project_id" --arg label "$label_id" --arg title "$4" --arg description "$description" '{input: {teamId: $team, projectId: $project, labelIds: [$label], title: $title, description: $description}}')")
    [ "$(jq -r '.data.issueCreate.success == true and (.data.issueCreate.issue.identifier | type) == "string"' <<<"$created")" = true ] || die "Linear did not open the ticket"
    mkdir -p "$ORCH_STATE_DIR"
    jq -c --arg at "$(now_utc)" '.data.issueCreate.issue + {at: $at}' <<<"$created" >> "$ORCH_STATE_DIR/tracker-issues.jsonl"
    jq -r '.data.issueCreate.issue | "\(.identifier) \(.url)"' <<<"$created"
    ;;
  comments)
    ticket_ok "$2"
    # byOwner: written by the user himself ([tracker] owner_id; without it,
    # and with the key of a person, the owner of that key), by no
    # application and no integration.
    owner=$(owner_id) || exit 1
    gql 'query($id: String!) { viewer { id } issue(id: $id) { comments(first: 100) { nodes { id createdAt editedAt body url user { id app } botActor { id } externalUser { id } } } } }' \
      "$(jq -nc --arg id "$2" '{id: $id}')" \
      | jq -c --arg owner "$owner" '(if $owner != "" then $owner else .data.viewer.id end) as $owner | [.data.issue.comments.nodes[] | {id, createdAt, editedAt, body, url, byOwner: ($owner != null and .user.id == $owner and .user.app != true and .botActor == null and .externalUser == null), by: {kind: (if .user.app == true or .botActor != null then "agents" elif $owner != null and .user.id == $owner and .externalUser == null then "human" else "other" end), id: (.user.id // .botActor.id // .externalUser.id // "unknown")}}]'
    ;;
  changes)
    [[ "${2:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || die "usage: linear.sh changes <ISO time>"
    gql 'query($team: String!, $since: DateTimeOrDuration!) { issues(first: 50, orderBy: updatedAt, filter: {team: {key: {eq: $team}}, updatedAt: {gt: $since}}) { nodes { id identifier title url createdAt updatedAt description state { name } project { name } creator { id app } botActor { id } comments(first: 20) { nodes { id createdAt body url user { id app } botActor { id } } } } } }' \
      "$(jq -nc --arg team "$(conf_get tracker team)" --arg since "$2" '{team: $team, since: $since}')" \
      | jq -c --arg owner "$(owner_id)" '[.data.issues.nodes[] | {id, identifier, title, url, createdAt, updatedAt, description: ((.description // "") | .[0:1200]), state: .state.name, project: (.project.name // null), agent: (.creator.app == true or .botActor != null), by: {kind: (if .creator.app == true or .botActor != null then "agents" elif $owner != "" and .creator.id == $owner then "human" else "other" end), id: (.creator.id // .botActor.id // "unknown")}, comments: [.comments.nodes[] | {id, createdAt, url, body, agent: (.user.app == true or .botActor != null), by: {kind: (if .user.app == true or .botActor != null then "agents" elif $owner != "" and .user.id == $owner then "human" else "other" end), id: (.user.id // .botActor.id // "unknown")}}]}]'
    ;;
  list)
    [ -n "${2:-}" ] || die "usage: linear.sh list <state>"
    listed=$(gql 'query($team: String!, $state: String!) { issues(first: 100, orderBy: updatedAt, filter: {team: {key: {eq: $team}}, state: {name: {eq: $state}}}) { nodes { id identifier title url description createdAt updatedAt state { name } project { name } labels { nodes { name } } assignee { name } } } }' \
      "$(jq -nc --arg team "$(conf_get tracker team)" --arg state "$2" '{team: $team, state: $state}')" \
      | jq -c '[.data.issues.nodes[] | {id, identifier, title, url, description: (.description // ""), body: (.description // ""), createdAt, updatedAt, state: .state.name, status: .state.name, project: (.project.name // null), labels: [.labels.nodes[]?.name], assignee: (.assignee.name // null)}]')
    # One page only: a full page may not be everything.
    [ "$(jq length <<<"$listed")" -lt 100 ] || echo "$(basename "$0"): 100 tickets in the state \"$2\": the list may be cut short" >&2
    printf '%s\n' "$listed"
    ;;
  upload)
    # Sends one screenshot to Linear and prints the address to put in a
    # comment. Only an image (its first bytes say so, not its name), and
    # only from the folder a lane sets apart for what may leave ([tracker]
    # capture_roots, where * is one folder name): nothing else on this
    # machine leaves by here. The guard reads the text of a comment, not an
    # image: what is put in that folder was taken on the demonstration data.
    file=$(realpath -e "${2:-}" 2> /dev/null) || die "usage: linear.sh upload <image>: no such file"
    allowed=
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      pattern=$(realpath -m "$(expand_home "$root")" | sed 's/[][\.^$()+?{}|]/\\&/g; s/\*/[^\/]+/g')
      if [[ "$file" =~ ^$pattern/[^/]+$ ]]; then allowed=1; fi
    done < <(conf_get tracker capture_roots | tr ',' '\n' | sed 's/^ *//; s/ *$//')
    [ -n "$allowed" ] || die "$file is not under a folder of captures ([tracker] capture_roots): nothing sent"
    case "$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')" in
      89504e470d0a1a0a) type=image/png ;;
      ffd8ff*) type=image/jpeg ;;
      *) die "$file is not a PNG or JPEG image: nothing sent" ;;
    esac
    size=$(stat -c %s "$file")
    [ "$size" -le 5000000 ] || die "$file is larger than 5 MB: nothing sent"
    asked=$(gql 'mutation($type: String!, $name: String!, $size: Int!) { fileUpload(contentType: $type, filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }' \
      "$(jq -nc --arg type "$type" --arg name "$(basename "$file")" --argjson size "$size" '{type: $type, name: $name, size: $size}')")
    [ "$(jq -r '.data.fileUpload.success' <<<"$asked")" = true ] || die "Linear did not take the upload"
    headers=()
    while IFS=$'\t' read -r name value; do headers+=(-H "$name: $value"); done < <(jq -r '.data.fileUpload.uploadFile.headers[] | [.key, .value] | @tsv' <<<"$asked")
    curl -sS --fail --max-time 60 -X PUT -H "Content-Type: $type" -H 'Cache-Control: public, max-age=31536000' "${headers[@]}" --data-binary "@$file" "$(jq -r '.data.fileUpload.uploadFile.uploadUrl' <<<"$asked")" > /dev/null \
      || die "the image could not be sent"
    jq -r '.data.fileUpload.uploadFile.assetUrl' <<<"$asked"
    ;;
  state)
    ticket_ok "$2"
    gql 'query($id: String!) { issue(id: $id) { state { name } } }' "$(jq -nc --arg id "$2" '{id: $id}')" | jq -r '.data.issue.state.name // empty'
    ;;
  history)
    ticket_ok "$2"
    owner=$(owner_id) || exit 1
    gql 'query($id: String!) { viewer { id } issue(id: $id) { state { name } createdAt creator { id app } history(first: 100) { nodes { createdAt actorId actor { id app } botActor { id } toState { name } } } } }' "$(jq -nc --arg id "$2" '{id: $id}')" \
      | jq -c --arg owner "$owner" '(if $owner != "" then $owner else .data.viewer.id end) as $owner | [.data.issue.history.nodes[] | select(.toState.name != null) | {status: .toState.name, by: {kind: (if .botActor != null or .actor.app == true then "agents" elif .actorId == $owner and .actorId != null then "human" else "other" end), id: (.actorId // .botActor.id // "unknown")}, at: .createdAt}] as $history | (if ($history | length) == 0 and .data.issue.creator != null then [{status: .data.issue.state.name, by: {kind: (if .data.issue.creator.app == true then "agents" elif .data.issue.creator.id == $owner then "human" else "other" end), id: .data.issue.creator.id}, at: .data.issue.createdAt}] else $history end) | sort_by(.at)'
    ;;
  label-actors)
    # Who set each label of the ticket and its project: the author of the
    # last change of the history that added it, else (set when it was
    # created) its creator. An application or a bot is the agents; the user
    # is [tracker] owner_id. A history longer than one page is not read in
    # part: the command fails, and nothing is taken as the user's.
    ticket_ok "$2"
    owner=$(owner_id) || exit 1
    answer=$(gql 'query($id: String!) { viewer { id } issue(id: $id) { createdAt creator { id app } botActor { id } labels { nodes { id name } } project { id name } history(first: 100) { pageInfo { hasNextPage } nodes { createdAt actorId actor { id app } botActor { id } addedLabelIds toProjectId } } } }' "$(jq -nc --arg id "$2" '{id: $id}')")
    jq -ce --arg owner "$owner" '
      def who($n; $o): {kind: (if $n.botActor != null or $n.actor.app == true then "agents" elif $n.actorId != null and $n.actorId == $o then "human" else "other" end), id: ($n.actorId // $n.botActor.id // "unknown")};
      def creator($i; $o): {kind: (if $i.botActor != null or $i.creator.app == true then "agents" elif $i.creator.id != null and $i.creator.id == $o then "human" else "other" end), id: ($i.creator.id // $i.botActor.id // "unknown")};
      (if $owner != "" then $owner else .data.viewer.id end) as $o
      | .data.issue as $i
      | if $i == null or $i.history.pageInfo.hasNextPage != false or $o == null then null
        else ($i.history.nodes | sort_by(.createdAt)) as $h
        | {labels: ([$i.labels.nodes[] | .id as $id | {key: .name, value: (([$h[] | select(any((.addedLabelIds // [])[]; . == $id))] | last) as $n | if $n then who($n; $o) else creator($i; $o) end)}] | from_entries),
           project: (if $i.project == null then null else ($i.project.id as $p | ([$h[] | select(.toProjectId == $p)] | last) as $n | if $n then who($n; $o) else creator($i; $o) end) end)}
        end' <<<"$answer" || die "who set the labels of $2 cannot be read"
    ;;
  edit-comment)
    ticket_ok "$2"
    [ -f "${4:-}" ] || die "usage: tracker.sh edit-comment <ticket> <comment id> <body file>"
    guard_text "$4" || exit 1
    existing=$(gql 'query($id: String!) { comment(id: $id) { id user { id app } botActor { id } } viewer { id } }' "$(jq -nc --arg id "$3" '{id: $id}')")
    [ "$(jq -r --arg identity "$identity" '.data.comment != null and (if $identity == "app" then .data.comment.user.app == true and .data.comment.user.id != null and .data.comment.user.id == .data.viewer.id else false end)' <<<"$existing")" = true ] || die "the comment was not written by the agent application"
    body=$(cat "$4")
    updated=$(gql 'mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: {body: $body}) { success comment { id url } } }' "$(jq -nc --arg id "$3" --arg body "$body" '{id: $id, body: $body}')")
    [ "$(jq -r '.data.commentUpdate.success' <<<"$updated")" = true ] || die "the comment could not be edited"
    jq -r '.data.commentUpdate.comment.url' <<<"$updated"
    ;;
  moved-by-owner)
    # Is the ticket in that status, and was it put there by the user
    # himself, after the time given when one is? 0: yes. 5: it is not in
    # that status. 6: it was put there by an application (the one of the
    # agents among them), an integration or another account. 7: the tracker
    # has not written the move to its history yet. 8: by him, but before
    # the time given: an agreement to something else. The user is the one
    # the settings of the project name ([tracker] owner_id); with the key of
    # a person and no such setting, the owner of that key, whom the tracker
    # cannot tell from a program acting under his account. The tracker
    # merges the successive changes of one author in one line of history,
    # and a card taken out and put back by an agent leaves no trace: hence
    # the time, which is the one his line of history began (tried on
    # 2026-10-08: a later gesture of his joins that line only when nobody
    # acted in between).
    ticket_ok "$2"
    [ -n "${3:-}" ] || die "usage: linear.sh moved-by-owner <ticket> <status> [<not before, ISO time>]"
    not_before=${4:-}
    [ -z "$not_before" ] || [[ "$not_before" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || die "\"$not_before\" is not a time"
    owner=$(owner_id) || exit 1
    answer=$(gql 'query($id: String!) { viewer { id } issue(id: $id) { state { name } createdAt creator { id app } history(first: 40) { nodes { createdAt actorId actor { id app } botActor { name } fromState { name } toState { name } } } } }' "$(jq -nc --arg id "$2" '{id: $id}')")
    [ "$(jq -r '.data.issue.state.name // empty' <<<"$answer")" = "$3" ] || exit 5
    last=$(jq -c --arg status "$3" '[.data.issue.history.nodes[] | select(.toState.name == $status) | . + {at: .createdAt}] | sort_by(.at) | last // empty' <<<"$answer")
    # A ticket created in that status never moved to it: the tracker keeps no
    # line for it. Whoever created it put it there, when it was created.
    if [ -z "$last" ] && [ "$(jq '[.data.issue.history.nodes[] | select(.toState != null or .fromState != null)] | length' <<<"$answer")" = 0 ] && [ "$(jq -r '.data.issue.creator != null' <<<"$answer")" = true ]; then
      last=$(jq -c '.data.issue | {at: .createdAt, actorId: .creator.id, actor: .creator, botActor: null}' <<<"$answer")
    fi
    [ -n "$last" ] || exit 7
    [ -n "$owner" ] || owner=$(jq -r '.data.viewer.id' <<<"$answer")
    [ "$(jq -r --arg owner "$owner" '.botActor == null and .actor.app != true and .actorId != null and .actorId == $owner' <<<"$last")" = true ] || exit 6
    # The request and the move carry subsecond times. A move earlier in the
    # same second must not authorize the later request.
    [ -z "$not_before" ] || [ "$(date -u -d "$(jq -r '.at' <<<"$last")" +%s%N)" -gt "$(date -u -d "$not_before" +%s%N)" ] || exit 8
    ;;
  move)
    # A script only ever puts a ticket in the statuses that say where the
    # work stands (at work, being checked), in the one that asks the user
    # for his agreement, or in the one that says it is done. Never in the
    # one that is his agreement, nor in the one by which he says « go ».
    ticket_ok "$2"
    target=${3:-}
    allowed=
    for name in progress_state review_state validate_state done_state; do
      [ -z "$(conf_get tracker "$name")" ] || [ "$target" != "$(conf_get tracker "$name")" ] || allowed=1
    done
    [ -n "$target" ] && [ -n "$allowed" ] && [ "$target" != "$(conf_get tracker go_state)" ] \
      || die "a script may only move a ticket to a status of the work, to \"$(conf_get tracker validate_state)\" or to \"$(conf_get tracker done_state)\", never to \"${target:-nothing}\""
    found=$(gql 'query($id: String!, $team: String!) { issue(id: $id) { id } teams(filter: {key: {eq: $team}}) { nodes { states { nodes { id name } } } } }' "$(jq -nc --arg id "$2" --arg team "$(conf_get tracker team)" '{id: $id, team: $team}')")
    issue_id=$(jq -r '.data.issue.id // empty' <<<"$found") state_id=$(jq -r --arg name "$target" '.data.teams.nodes[0].states.nodes[] | select(.name == $name) | .id' <<<"$found")
    [ -n "$issue_id" ] && [ -n "$state_id" ] || die "ticket \"$2\" or status \"$target\" not found in Linear"
    moved=$(gql 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }' "$(jq -nc --arg id "$issue_id" --arg state "$state_id" '{id: $id, input: {stateId: $state}}')")
    [ "$(jq -r '.data.issueUpdate.success' <<<"$moved")" = true ] || die "Linear did not move $2"
    echo "$2 -> $target"
    ;;
  waiting)
    # What waits for the user: the tickets in the status that asks him. Not
    # « the tickets assigned to the one who asks »: the scripts act as the
    # application of the agents, to which nothing is assigned.
    gql 'query($team: String!, $state: String!) { issues(first: 50, filter: {team: {key: {eq: $team}}, state: {name: {eq: $state}}}) { nodes { identifier title url updatedAt comments(first: 1) { nodes { url createdAt } } } } }' \
      "$(jq -nc --arg team "$(conf_get tracker team)" --arg state "$(conf_get tracker validate_state)" '{team: $team, state: $state}')" \
      | jq -c '[.data.issues.nodes[] | {identifier, title, url: (.comments.nodes[0].url // .url), since: (.comments.nodes[0].createdAt // .updatedAt)}] | sort_by(.since)'
    ;;
  *)
    die "usage: linear.sh issue <ticket> | comment <ticket> <file> [<from>] | comments <ticket> | create <project> <label> <title> <file> | changes <ISO time> | list <state> | waiting | state <ticket> | moved-by-owner <ticket> <status> | move <ticket> <status> | upload <image>"
    ;;
esac
