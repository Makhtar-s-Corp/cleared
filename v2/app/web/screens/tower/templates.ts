// Ready-made tickets (P214, issue #330): Bug, Review, CI and Question in the
// bar. A pick puts the template's sections in the description when it is
// empty, or still as another template left it; a description the person wrote
// is kept, and the pick says so. The same pick again unpicks it. The ticket
// carries the template's type label (src/tickets/templates.ts).
import { typeLabel, type TicketTemplate } from '../../../../src/tickets/templates.ts';
import type { Translate } from '../../lib/i18n.ts';

export function templateBody(template: TicketTemplate, t: Translate): string {
  return t(`template_${template}_body`);
}

export function templateLabels(template: TicketTemplate | null): string[] {
  return template ? [typeLabel(template)] : [];
}

export type TemplatePick = { readonly template: TicketTemplate | null; readonly body: string; readonly kept: boolean };

export function pickTemplate(current: { readonly template: TicketTemplate | null; readonly body: string }, picked: TicketTemplate, t: Translate): TemplatePick {
  const text = current.body.trim();
  const untouched = !text || (current.template !== null && text === templateBody(current.template, t).trim());
  if (picked === current.template) return { template: null, body: untouched ? '' : current.body, kept: false };
  return untouched ? { template: picked, body: templateBody(picked, t), kept: false } : { template: picked, body: current.body, kept: true };
}
