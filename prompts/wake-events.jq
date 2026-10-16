.events[] |
  if .kind == "night_check_failed" then event_night_check_failed
  elif .kind == "comment" then event_comment
  elif .kind == "ticket_new" then event_ticket_new
  elif .kind == "lane_report" then event_lane_report
  elif .kind == "ticket_moved" then event_ticket_moved
  elif .kind == "review_done" and .outcome == "lane_asks" then event_review_done_lane_asks
  elif .kind == "review_done" and .outcome == "self_update_refused" then event_review_done_self_update_refused
  elif .kind == "review_done" and .outcome == "project_update_refused" then event_review_done_project_update_refused
  elif .kind == "review_done" and .outcome == "ticket_cost" then event_review_done_ticket_cost
  elif .kind == "review_done" and .outcome == "teams_ready" then event_review_done_teams_ready
  elif .kind == "review_done" and .outcome == "fast_lane_ready" then event_review_done_fast_lane_ready
  elif .kind == "review_done" and .outcome == "fast_lane_fallback" then event_review_done_fast_lane_fallback
  elif .kind == "review_done" and .outcome == "subscription_stop" then event_review_done_subscription_stop
  elif .kind == "review_done" and .outcome == "lane_stuck" then event_review_done_lane_stuck
  elif .kind == "review_done" and .outcome == "ticket_left_open" then event_review_done_ticket_left_open
  elif .kind == "review_done" and .outcome == "merge_refused" then event_review_done_merge_refused
  elif .kind == "review_done" and .outcome == "dropped" then event_review_done_dropped
  elif .kind == "review_done" then event_review_done
  elif .kind == "pr_checks" then event_pr_checks
  elif .kind == "pr_ready" then event_pr_ready
  elif .kind == "pr_opened" then event_pr_opened
  else event_default end
