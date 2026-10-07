#!/usr/bin/env bash
# Says whether the project lead may start: the model agents.conf gives its
# role must be the one decided last, as the ledger has it (events of kind
# role_model_changed, detail "<role>: <from> -> <to>: <why>"). A model that
# was set aside cannot be put back to work by a table that was not changed
# yet, nor by a timer started by hand. No decision written down: the table
# is the only word.
#
#   check-lead-model.sh        exit 1, and why, when the lead must not start
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

role=$(conf_get lead role)
[ -n "$role" ] || die "[lead] role is not set"
set_now=$(conf_get roles "$role")
[ -n "$set_now" ] || die "the role $role has no model in [roles]"
ledger init > /dev/null
last=$(ledger sql "select at, detail from events where kind = 'role_model_changed' and detail like '$role: %' order by at desc, event_id desc limit 1" | jq -c '.[0] // empty')
[ -n "$last" ] || exit 0
decided=$(jq -r '.detail' <<<"$last" | sed -n -E "s/^$role: [^ ]+ -> ([^ :]+).*/\1/p")
[ -n "$decided" ] || die "the last decision on the model of the role $role cannot be read: $(jq -r '.detail' <<<"$last")"
[ "$decided" = "$set_now" ] || die "the model of the role $role in agents.conf ($set_now) is not the one decided last ($decided), on $(jq -r '.at' <<<"$last"): $(jq -r '.detail' <<<"$last"). The project lead does not start. Bring agents.conf of this checkout up to date, or write a new decision to the ledger"
