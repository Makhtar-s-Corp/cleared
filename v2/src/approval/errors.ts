// Why an approval was refused, as a code the route maps to a status.
//   setup    no signing key, or no owner, is set up (npm run setup)
//   user     the user id is not a user of the app
//   owner    the user is not the owner of [tracker] owner_id
//   ticket   no such ticket
//   state    the ticket is not waiting for the owner
//   version  the request kept for the ticket is not the one shown
//   pending  an approval for this ticket is already held
export type ApprovalCode = 'setup' | 'user' | 'owner' | 'ticket' | 'state' | 'version' | 'pending';

export class ApprovalError extends Error {
  override name = 'ApprovalError';
  readonly code: ApprovalCode;
  constructor(code: ApprovalCode, message: string) {
    super(message);
    this.code = code;
  }
}
