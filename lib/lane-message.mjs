// What a lane may not be told through tell-lane.sh: to merge, or to force a
// push. A net, not the control: the control is what the lead is allowed to
// run and the written agreement of the user. The net reads clause by clause.
// A clause that names a merge or a forced push is refused, unless it says not
// to (« ne fusionne pas »), says what the lead or a script will do itself
// (« je fusionnerai »), or says what is done (« #12 est fusionnée »). A
// refused message is reworded by its author; nothing is sent meanwhile.
//
//   lane-message.mjs < message      exit 1 and the refused clause when there is one
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLAUSES = /[.;:!?,\n]+|\s+(?:et|puis|mais|donc|alors|ensuite|car|après|and|then|but|so|because|after)\s+/iu;
const NAMED = /(?<![\p{L}\p{N}_-])(fusionn\p{L}*|merg\p{L}*|force[ -]?push\p{L}*|--force[\w-]*|push\s+-f(?![\p{L}\p{N}]))/giu;
// Done, or to be done by someone who is not the lane.
const NOT_AN_ORDER = /^(?:(?:fusionn|merg)(?:é|ée|és|ées|erai|era|eront|able|ables)|merged)$/iu;
const BY_THE_LEAD = /(?<!\p{L})(?:(?:je|j['’])\s*(?:(?:la|le|les|l['’]|vais|viens|de|peux|pourrai|dois|devrai|ne|n['’]|pas|encore)\s*)*|moi\s+qui\s+(?:(?:la|le|les|l['’])\s*)?|(?:I|we|the lead|the script)\s+(?:(?:will|can|must|may|am going to|are going to|have|has|already|not|never|the|this|that|it)\s*)*)$/iu;
// A negation bears on what follows it closely: at most three words further.
const NEGATED = /(?<!\p{L})(?:(?:ne|sans|jamais|ni|pas\s+de|aucune?|interdit\p{L}*|no|never|without|avoid|forbidden|do\s+not|does\s+not|don['’]t|must\s+not|cannot|can['’]t)(?!\p{L})|n['’]|pas\s+d['’])(?:\s*\S+){0,3}\s*$/iu;
// « N'hésite pas à fusionner » is an order, whatever its negation.
const INVITES = /(?<!\p{L})(?:hésite|tarde|attend|empêche|oublie|manque|hesitate|wait|delay|forget|fail|hold\s+back)/iu;

export function refusedOrder(text) {
  for (const clause of String(text).split(CLAUSES)) {
    if (!clause) continue;
    for (const found of clause.matchAll(NAMED)) {
      const before = clause.slice(0, found.index);
      if (NOT_AN_ORDER.test(found[0]) || BY_THE_LEAD.test(before)) continue;
      if (NEGATED.test(before) && !INVITES.test(before)) continue;
      return clause.trim();
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const refused = refusedOrder(readFileSync(0, 'utf8'));
  if (refused) { console.log(refused); process.exit(1); }
}
