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
export { createTracker } from './adapters/factory.ts';
