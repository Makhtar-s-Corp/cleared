#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadConf } from '../conf.mjs';
import { createTracker } from './contract.mjs';

const conf = loadConf();
const tracker = createTracker(conf);
const [command, ...args] = process.argv.slice(2);
const setting = (key) => conf.sections.tracker?.[key];
const output = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value));
const body = (file) => file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');

try {
  switch (command) {
    case 'identity': output(tracker.whoAmI().kind === 'agents' ? 'app' : 'shared'); break;
    case 'issue': {
      const ticket = tracker.getTicket(args[0]);
      if (!ticket) throw new Error(`No such ticket: ${args[0]}`);
      output(ticket); break;
    }
    case 'state': output(tracker.getTicket(args[0])?.status || ''); break;
    case 'list': output(tracker.listTickets({ status: args[0] })); break;
    case 'waiting': output(tracker.listTickets({ status: setting('validate_state') }).map((ticket) => ({
      identifier: ticket.identifier, title: ticket.title, url: ticket.url, since: ticket.updatedAt,
    }))); break;
    case 'comments': output(tracker.comments(args[0])); break;
    case 'changes': output(tracker.changesSince(args[0]).events); break;
    case 'history': output(tracker.history(args[0])); break;
    case 'move': {
      const allowed = ['progress_state', 'review_state', 'validate_state', 'done_state'].map(setting).includes(args[1]);
      if (!allowed || args[1] === setting('go_state')) throw new Error(`Scripts cannot move a ticket to ${args[1]}`);
      const ticket = tracker.moveTicket(args[0], args[1]); output(`${ticket.identifier} -> ${ticket.status}`); break;
    }
    case 'moved-by-owner': {
      const ticket = tracker.getTicket(args[0]);
      if (!ticket || ticket.status !== args[1]) { process.exitCode = 5; break; }
      const last = tracker.history(args[0]).at(-1);
      if (!last || last.status !== args[1]) { process.exitCode = 7; break; }
      if (last.by.kind !== 'human' || last.by.id !== setting('owner_id')) { process.exitCode = 6; break; }
      if (conf.sections.tracker?.adapter === 'local' && (!last.approvalContext || last.approvalContext !== tracker.approvalContext(args[0]))) {
        process.exitCode = 8; break;
      }
      if (args[2] && (!Number.isFinite(Date.parse(args[2])) || Date.parse(last.at) <= Date.parse(args[2]))) { process.exitCode = 8; break; }
      break;
    }
    case 'create': {
      if (args.length !== 4) throw new Error('usage: tracker.sh create <project> <label> <title> <file>');
      const ticket = tracker.createTicket({ project: args[0], labels: [args[1]], title: args[2], body: body(args[3]) });
      output(`${ticket.identifier} ${ticket.url}`); break;
    }
    case 'comment': {
      const result = tracker.comment(args[0], body(args[1]));
      output(result.url || result.html_url); break;
    }
    case 'comment-json': {
      const result = tracker.comment(args[0], body(args[1]));
      output({ id: String(result.id), url: result.url || result.html_url }); break;
    }
    case 'edit-comment': output(tracker.editComment(args[0], args[1], body(args[2]))); break;
    case 'upload': output(tracker.upload(args[0])); break;
    default: throw new Error('usage: tracker.sh issue|list|create|move|history|comments|comment|edit-comment|identity|changes|waiting|state|moved-by-owner');
  }
} catch (error) { console.error(`tracker: ${error.message}`); process.exitCode = 1; }
finally { tracker.close?.(); }
