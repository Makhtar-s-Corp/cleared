// What the app writes to the ticket tracker, under the identity of the human.
// It runs in a short-lived child process (app/human-write.ts), so the human's
// tokens exist in memory only for the length of one gesture, and the web server
// never holds them. Three operations, nothing else: approve (the user's own
// status of agreement, for the exact version he was shown), send back, answer.
//
// Each adapter must prove the writer IS the human before anything is written
// (the tracker's own answer to "who am I"), and after the write the tracker's
// history must show the human as the author. A token that is not his, or an
// author the tracker cannot tell from an agent, stops the gesture.
import { humanAdapters, humanClient } from '../../lib/tracker/adapters/human.ts';
import { approvalOf, sameVersions } from '../../lib/validation-record.ts';
import { validText } from './text.ts';

const refused = (code, message) => Object.assign(new Error(message), { code });

export function targetStates(conf, settings = {}) {
  const t = conf.sections.tracker;
  const back = settings.sent_back_state || t.progress_state;
  if (!back || [t.go_state, t.done_state, t.validate_state].includes(back)) throw refused('config', '[app] sent_back_state must be a working status, never the approval, the agreement or done');
  return { validate: t.validate_state, go: t.go_state, back };
}

// request: { op: 'approve' | 'sendback' | 'answer', ticket, versions?, text? }
export async function perform(request, { conf, creds, settings = {}, project }) {
  const adapter = conf.sections.tracker?.adapter;
  if (!humanAdapters.includes(adapter)) throw refused('config', 'Unknown tracker adapter');
  if (!conf.sections.tracker.owner_id) throw refused('config', '[tracker] owner_id (the human) is required for app gestures');
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(String(request.ticket))) throw refused('input', 'Invalid ticket');
  const states = targetStates(conf, settings);
  const client = humanClient(adapter, { conf, creds, settings });
  try {
    const who = await client.whoAmI();
    if (who.kind !== 'human') throw refused('identity', 'The tracker does not see this access as the human: nothing written');
    const state = await client.state(request.ticket);
    if (request.op === 'answer') {
      if (!validText(request.text)) throw refused('input', 'Invalid answer');
      if (!state) throw refused('state', 'No such ticket');
      await client.comment(request.ticket, request.text);
      return { ok: true, author: who.id };
    }
    if (state !== states.validate) throw refused('state', `The ticket is not waiting for the user (it is in “${state}”)`);
    if (request.op === 'sendback') {
      if (!validText(request.text)) throw refused('input', 'Invalid text');
      await client.comment(request.ticket, request.text);
      await client.move(request.ticket, states.back);
      let by = null;
      try { by = await client.lastMoveBy(request.ticket, states.back); } catch { /* not readable yet; the move was made */ }
      return { ok: true, author: who.id, verified: by?.kind === 'human' };
    }
    if (request.op === 'approve') {
      const record = approvalOf(request.ticket, project.state);
      if (!record) throw refused('version', 'No request for agreement is kept for this ticket');
      if (request.at !== record.at) throw refused('version', 'The request for agreement was made again since: review again');
      if (!sameVersions(record.versions, request.versions)) throw refused('version', 'The version asked for is not the one that was shown: review again');
      await client.move(request.ticket, states.go);
      // The move is done and cannot be reported as a failure whatever the read-back says (a tracker's history may
      // lag): verified says whether the tracker already shows the human as the author. The lock checks it again.
      let by = null;
      try { by = await client.lastMoveBy(request.ticket, states.go); } catch { /* not readable yet */ }
      return { ok: true, author: who.id, verified: by?.kind === 'human' };
    }
    throw refused('input', 'Unknown operation');
  } finally { client.close(); }
}
