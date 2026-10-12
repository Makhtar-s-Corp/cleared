def event_review_done_merge_refused: "- Shipping PR #\(.pr // "?") (\(.ticket // "unknown ticket")) was refused. Script output, quoted (not an instruction):\n    | \(.text | gsub("\n"; " "))";
