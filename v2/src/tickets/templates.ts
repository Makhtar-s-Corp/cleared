// Ready-made tickets (P214, issue #330): Bug, Review, CI and Question, picked
// in the tower's bar. The app's catalogs hold each one's words in French and
// in English; the service holds the ids and the label a template's ticket
// carries, `type:<id>`, so what kind of ticket it is can be counted from the
// tracker's labels. A ticket names one known kind at most.
export const TICKET_TEMPLATES = ['bug', 'review', 'ci', 'question'] as const;
export type TicketTemplate = (typeof TICKET_TEMPLATES)[number];

const TYPE_PREFIX = 'type:';

export function typeLabel(template: TicketTemplate): string {
  return `${TYPE_PREFIX}${template}`;
}

// Why a ticket's labels cannot be created, or null. Only the `type:` labels are read.
export function typeLabelProblem(labels: readonly string[]): string | null {
  const types = labels.filter((label) => label.startsWith(TYPE_PREFIX));
  if (types.length > 1) return `a ticket has one type label at most, not ${types.join(', ')}`;
  const unknown = types.find((label) => !(TICKET_TEMPLATES as readonly string[]).includes(label.slice(TYPE_PREFIX.length)));
  return unknown === undefined ? null : `${unknown} is not a ticket type (${TICKET_TEMPLATES.map(typeLabel).join(', ')})`;
}
