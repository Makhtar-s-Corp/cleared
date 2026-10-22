-- A ledger made by the milestone 2 schema (origin/v2 at 50faee9, before the
-- workspace migration of lane 14): every module table of the eight modules,
-- with sessions, session events, tickets, plans and inbox rows. Written by a
-- script on that commit: the tickets, sessions, events and the policy rule
-- through the real stores, the plan, its items, the inbox items and the lead
-- message as plain inserts with their columns. test/store/migrations.test.ts
-- runs the migrations on a ledger made from it.
CREATE TABLE session_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, ticket TEXT NOT NULL, project TEXT NOT NULL,
  type TEXT NOT NULL, event TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, ticket TEXT NOT NULL, role TEXT NOT NULL, harness TEXT NOT NULL,
  model TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX sessions_ticket ON sessions(ticket);
CREATE TABLE policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (project, tool, pattern)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE tracker_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  labels TEXT NOT NULL, project TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tracker_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL, status TEXT NOT NULL,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, at TEXT NOT NULL
  , proof TEXT, approval_context TEXT, content_hash TEXT
);
CREATE TABLE tracker_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL, body TEXT NOT NULL,
  images TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL, edited_at TEXT, proof TEXT
);
CREATE INDEX tracker_tickets_status ON tracker_tickets(status);
CREATE INDEX tracker_history_ticket ON tracker_history(ticket, id);
CREATE INDEX tracker_comments_ticket ON tracker_comments(ticket, id);
CREATE TABLE tracker_images (
  digest TEXT PRIMARY KEY, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  ticket TEXT,
  role TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache INTEGER,
  cost_eur REAL,
  outcome TEXT,
  pr_number INTEGER,
  lines_changed INTEGER,
  human_decision TEXT,
  human_latency_min REAL,
  lane TEXT,
  source TEXT NOT NULL DEFAULT 'dispatcher',
  requested_model TEXT,
  exit_code INTEGER,
  tokens_cache_write INTEGER,
  tokens_total INTEGER,
  cost_basis TEXT,
  project TEXT,
  label TEXT
);
CREATE INDEX runs_started ON runs (started_at);
CREATE INDEX runs_ticket ON runs (ticket);
CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticket TEXT,
  run_id TEXT,
  detail TEXT,
  value REAL,
  source TEXT NOT NULL DEFAULT 'dispatcher'
);
CREATE INDEX events_at ON events (at);
CREATE TABLE flow_inbox (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket TEXT NOT NULL, project TEXT NOT NULL,
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, since TEXT NOT NULL,
  state TEXT NOT NULL, handled_at TEXT, handled_by TEXT, payload TEXT NOT NULL
);
CREATE TABLE lead_generations (
  project TEXT NOT NULL, number INTEGER NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT, reason TEXT, handover_id TEXT, briefing_bytes INTEGER NOT NULL, highest_percent REAL,
  PRIMARY KEY (project, number)
);
CREATE TABLE lead_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, user TEXT,
  text TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER, question TEXT, plan_id TEXT, turn TEXT, turn_text TEXT
);
CREATE TABLE lead_commitments (
  n INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, text TEXT NOT NULL, ticket TEXT, due TEXT,
  state TEXT NOT NULL, created_at TEXT NOT NULL, fulfilled_at TEXT, note TEXT, generation INTEGER, woken_at TEXT
);
CREATE TABLE lead_handovers (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, generation INTEGER NOT NULL, at TEXT NOT NULL,
  summary TEXT NOT NULL, machine INTEGER NOT NULL, parts TEXT NOT NULL, messages TEXT NOT NULL
);
CREATE TABLE lead_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, urgent INTEGER NOT NULL, sent_at TEXT
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, goal TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
  state TEXT NOT NULL, max_parallel INTEGER NOT NULL, totals TEXT NOT NULL, proposed_at TEXT NOT NULL,
  approved_at TEXT, approved_by TEXT, ended_at TEXT
);
CREATE TABLE plan_items (
  plan_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, lane TEXT NOT NULL,
  size TEXT NOT NULL, after TEXT NOT NULL, estimate TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL,
  put_backs INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (plan_id, position)
);
CREATE INDEX plan_items_ticket ON plan_items(ticket);
CREATE TABLE v2_notify_queue (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, grp TEXT NOT NULL, ticket TEXT, facts TEXT NOT NULL,
  first_at TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, done_at TEXT
);
CREATE INDEX v2_notify_queue_state ON v2_notify_queue (state, grp);
INSERT INTO session_events (session_id, seq, at, ticket, project, type, event) VALUES ('s-author-1', 1, '2026-10-22T20:09:00.000Z', 'LOCAL-1', 'guestbook', 'RUN_STARTED', '{"type":"RUN_STARTED","threadId":"s-author-1","runId":"r1"}');
INSERT INTO session_events (session_id, seq, at, ticket, project, type, event) VALUES ('s-author-1', 2, '2026-10-22T20:10:00.000Z', 'LOCAL-1', 'guestbook', 'TEXT_MESSAGE_CONTENT', '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Reading src/page.ts."}');
INSERT INTO session_events (session_id, seq, at, ticket, project, type, event) VALUES ('s-author-1', 3, '2026-10-22T20:11:00.000Z', 'LOCAL-1', 'guestbook', 'RUN_FINISHED', '{"type":"RUN_FINISHED","threadId":"s-author-1","runId":"r1"}');
INSERT INTO session_events (session_id, seq, at, ticket, project, type, event) VALUES ('s-review-1', 1, '2026-10-22T20:12:00.000Z', 'LOCAL-1', 'guestbook', 'STEP_STARTED', '{"type":"STEP_STARTED","stepName":"review"}');
INSERT INTO sessions (id, project, ticket, role, harness, model, status, created_at, updated_at) VALUES ('s-author-1', 'guestbook', 'LOCAL-1', 'author', 'claude-code', 'claude-opus-5-5', 'stopped', '2026-10-22T20:06:00.000Z', '2026-10-22T20:06:00.000Z');
INSERT INTO sessions (id, project, ticket, role, harness, model, status, created_at, updated_at) VALUES ('s-review-1', 'guestbook', 'LOCAL-1', 'reviewer', 'claude-code', 'claude-sonnet-5-5', 'working', '2026-10-22T20:07:00.000Z', '2026-10-22T20:07:00.000Z');
INSERT INTO sessions (id, project, ticket, role, harness, model, status, created_at, updated_at) VALUES ('s-lead-1', 'guestbook', 'lead', 'lead', 'claude-code', 'claude-opus-5-5', 'idle', '2026-10-22T20:08:00.000Z', '2026-10-22T20:08:00.000Z');
INSERT INTO policy_rules (id, project, tool, pattern, created_by, created_at) VALUES (1, 'guestbook', 'Bash', 'npm test', 'u1', '2026-10-22T20:13:00.000Z');
INSERT INTO tracker_tickets (id, title, body, labels, project, status, created_at, updated_at) VALUES (1, 'Newest entry first', 'Show the newest entry at the top.', '["Quick"]', 'guestbook', 'In Review', '2026-10-22T20:01:00.000Z', '2026-10-22T20:04:00.000Z');
INSERT INTO tracker_tickets (id, title, body, labels, project, status, created_at, updated_at) VALUES (2, 'Pages of 20 entries', 'Criteria: a next link.', '[]', 'guestbook', 'Todo', '2026-10-22T20:02:00.000Z', '2026-10-22T20:05:00.000Z');
INSERT INTO tracker_history (id, ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash) VALUES (1, 1, 'Todo', 'agents', 'cleared-v2', '2026-10-22T20:01:00.000Z', NULL, NULL, '834a5ab308f81987b2313b153d236b4fae7cf19d1ba062134439a0abdae090b9');
INSERT INTO tracker_history (id, ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash) VALUES (2, 2, 'Todo', 'agents', 'cleared-v2', '2026-10-22T20:02:00.000Z', NULL, NULL, '947b91329f28f454d0f9c2901e684d4a2a727a3223f8597477160c49fa646d07');
INSERT INTO tracker_history (id, ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash) VALUES (3, 1, 'In Progress', 'agents', 'cleared-v2', '2026-10-22T20:03:00.000Z', NULL, NULL, NULL);
INSERT INTO tracker_history (id, ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash) VALUES (4, 1, 'In Review', 'agents', 'cleared-v2', '2026-10-22T20:04:00.000Z', NULL, NULL, NULL);
INSERT INTO tracker_comments (id, ticket, body, images, actor_kind, actor_id, created_at, edited_at, proof) VALUES (1, 2, 'Waiting for the plan.', '[]', 'agents', 'cleared-v2', '2026-10-22T20:05:00.000Z', NULL, NULL);
INSERT INTO flow_inbox (id, kind, ticket, project, session_id, request_id, since, state, handled_at, handled_by, payload) VALUES ('q1', 'question', 'LOCAL-1', 'guestbook', 's-author-1', 'q1', '2026-10-22T20:18:00.000Z', 'handled', '2026-10-22T20:19:00.000Z', 'u1', '{"questions":[{"question":"Which order?","options":[{"label":"Newest first"}]}]}');
INSERT INTO flow_inbox (id, kind, ticket, project, session_id, request_id, since, state, handled_at, handled_by, payload) VALUES ('plan-p1', 'plan', 'lead', 'guestbook', 's-lead-1', 'plan-p1', '2026-10-22T20:20:00.000Z', 'waiting', NULL, NULL, '{"planId":"p1"}');
INSERT INTO lead_messages (seq, project, at, by, user, text, kind, generation, question, plan_id, turn, turn_text) VALUES (1, 'guestbook', '2026-10-22T20:21:00.000Z', 'owner', 'u1', 'Make a long guestbook readable', 'message', NULL, NULL, NULL, NULL, NULL);
INSERT INTO plans (id, project, goal, title, summary, state, max_parallel, totals, proposed_at, approved_at, approved_by, ended_at) VALUES ('p1', 'guestbook', 'Make a long guestbook readable', 'Readable guestbook', 'Two tickets.', 'approved', 2, '{"minutes":50,"costUsd":1.4,"weekPercent":null,"samples":0}', '2026-10-22T20:14:00.000Z', '2026-10-22T20:15:00.000Z', 'u1', NULL);
INSERT INTO plan_items (plan_id, position, title, body, lane, size, after, estimate, ticket, state, put_backs, note, updated_at) VALUES ('p1', 1, 'Newest entry first', 'Show the newest entry at the top.', 'fast', 's', '[]', '{"minutes":20,"costUsd":0.6,"weekPercent":null,"samples":0}', 'LOCAL-1', 'running', 0, NULL, '2026-10-22T20:16:00.000Z');
INSERT INTO plan_items (plan_id, position, title, body, lane, size, after, estimate, ticket, state, put_backs, note, updated_at) VALUES ('p1', 2, 'Pages of 20 entries', 'Criteria: a next link.', 'full', 'm', '[1]', '{"minutes":30,"costUsd":0.8,"weekPercent":null,"samples":0}', 'LOCAL-2', 'waiting', 0, NULL, '2026-10-22T20:17:00.000Z');
