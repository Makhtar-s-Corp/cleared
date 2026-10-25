// One tracker interface for orchestration code. Provider names and API calls
// live in adapters only. Unknown authors are never human approvals.
/**
 * @typedef {{kind:'human'|'agents'|'other', id:string}} ActionAuthor
 * @typedef {{status:string, by:ActionAuthor, at:string}} StatusChange
 * @typedef {Object} TicketTracker
 * @property {(options:{status?:string}) => Array<object>} listTickets
 * @property {(id:string) => object} getTicket
 * @property {(ticket:{title:string, body?:string, labels?:string[]}) => object} createTicket
 * @property {(id:string, status:string) => object} moveTicket
 * @property {(id:string) => StatusChange[]} history
 * @property {(id:string) => {labels:Object<string, ActionAuthor>, project:ActionAuthor|null}} labelActors who set each label and the project (throws when the tracker cannot say)
 * @property {(id:string, options?:{since?:string}) => Array<object>} comments
 * @property {(id:string, body:string, options?:{images?:string[]}) => object} comment
 * @property {(id:string, commentId:string, body:string) => object} editComment
 * @property {() => {kind:'agents'|'human'|'shared', id:string}} whoAmI
 * @property {(cursor?:string) => {events:Array<object>, cursor:string}} changesSince
 */
export type ActionAuthor = { kind: 'human' | 'agents' | 'other'; id: string };
export type Identity = { kind: 'agents' | 'human' | 'shared'; id: string };
export type StatusChange = { status: string; by: ActionAuthor; at: string; approvalContext?: string | null };
export type Ticket = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  body: string;
  labels: string[];
  project: string | null;
  state: string;
  status: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};
export type TicketChange = Ticket & { comments: TicketComment[]; agent: boolean; firstVisibleAt?: string };
export type TicketComment = {
  id: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  url: string;
  agent?: boolean;
  by: ActionAuthor;
  byOwner?: boolean;
  images?: string[];
};
export type PostedComment = { id?: string | number; url?: string; html_url?: string };
export type LabelActors = { labels: Record<string, ActionAuthor>; project: ActionAuthor | null };
export type NewTicket = { title: string; body?: string; labels?: string[]; project?: string | null };
export type TicketTracker = {
  listTickets(options?: { status?: string }): Ticket[];
  getTicket(id: string): Ticket | null;
  createTicket(ticket: NewTicket): Ticket | null;
  moveTicket(id: string, status: string): Ticket | null;
  history(id: string): StatusChange[];
  labelActors(id: string): LabelActors;
  comments(id: string, options?: { since?: string }): TicketComment[];
  comment(id: string, body: string, options?: { images?: string[] }): PostedComment | undefined;
  editComment(id: string, commentId: string, body: string): unknown;
  whoAmI(): Identity;
  changesSince(cursor?: string): { events: TicketChange[]; cursor: string };
  downloadCapture?(url: string): Buffer;
  upload?(path: string): string;
  approvalContext?(id: string): string | null;
  close?(): void;
};
export { createTracker } from './adapters/factory.ts';
