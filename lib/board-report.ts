// What the owner reads of a team's work: its report to the user (the
// sections Done, Remaining work and Questions for the user, written in the
// owner's language), and the question it ended on. Never the handover, which
// is the team's internal note for its next session.
//
// Pure functions: the collector reads the files and the ledger, these only
// read text. Everything returned is filtered by scrub (no path, secret or
// amount).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scrub } from './board-scrub.ts';

// What flow-lanes.sh keeps of the questions a team ended on (the lane_asks
// event): up to four questions of the size the app shows (1 500 characters
// each), counted in characters, never cut inside a character.
export const QUESTION_MAX = 1500;
export const ASKED_MAX = 4 * QUESTION_MAX;
export const ASKED_LINES = 40;
export function clipAsked(text: unknown): string {
  const lines = String(text ?? '').replace(/\s+$/, '').split('\n').slice(0, ASKED_LINES).join('\n');
  return [...lines].slice(0, ASKED_MAX).join('');
}

// The body of a lane report (lib/contract.sh): between "## Report" (or
// "## Compte rendu") and "## Changed files" (or "## Fichiers modifiés").
export function reportBody(text: unknown): string {
  const all = String(text ?? '');
  const start = /^## (?:Report|Compte rendu)[ \t]*$/m.exec(all);
  if (!start) return '';
  const rest = all.slice(start.index + start[0].length);
  const end = /^## (?:Changed files|Fichiers modifiés)[ \t]*$/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}
// The outcome a report states in its front matter ("outcome: done").
export const reportOutcome = (text: unknown): string | null => /^outcome:[ \t]*(\S+)/m.exec(String(text ?? '').split(/^---[ \t]*$/m)[1] ?? '')?.[1] ?? null;

type Section = 'done' | 'remaining' | 'questions';
export type Sections = Record<Section | 'other', string[]>;
const HEADINGS: [Section, string][] = [
  ['done', 'done|fait|ce qui est fait|réalisé|travail fait|terminé|what was done|completed'],
  ['remaining', 'remaining work|remaining|left to do|still to do|next steps|reste à faire|travail restant|ce qui reste|à faire|prochaines étapes'],
  ['questions', 'questions? (?:for|to|pour|à) [^:*#\\n]{1,40}|questions?'],
];
// A line that opens a section: "## Done", "**Fait**", "Fait :", "### Questions pour l'utilisateur : none".
const heading = (line: string) => {
  for (const [name, words] of HEADINGS) {
    const match = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(?:${words})\\s*(?:\\*\\*|__)?\\s*(?:[:：]\\s*(?:\\*\\*|__)?\\s*(.*))?$`, 'iu').exec(line);
    if (match) return { name, rest: (match[1] ?? '').trim() };
  }
  return null;
};
const NOTHING = /^(?:none|nothing|no questions?|n\/a|aucune?|rien|néant|pas de questions?)\b[\s.!]*$/iu;
const MARK = /^\s*(?:[-*•+]|\d{1,2}[.)]|[A-Da-d][.)])\s+/;
// Markdown that means nothing on the page: emphasis, code ticks, images (their address is a path), links (their text stays).
const plain = (line: unknown) => String(line).replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ').replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
  .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

// The three sections of a report body, as lists of items (a list item and the
// lines that continue it make one item). Lines before any heading are kept as
// "other". Each item is filtered; at most ten per section.
export function reportSections(body: unknown): Sections {
  const out: Sections = { done: [], remaining: [], questions: [], other: [] };
  let current: keyof Sections = 'other', item: true | null = null;
  const push = (text: string) => {
    const list = out[current];
    if (item && !MARK.test(text) && list.length) { list[list.length - 1] = `${list[list.length - 1]} ${plain(text)}`; return; }
    const value = plain(text.replace(MARK, ''));
    if (value) { list.push(value); item = true; }
  };
  for (const line of String(body ?? '').split('\n')) {
    if (!line.trim()) { item = null; continue; }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) continue;
    const head = heading(line);
    if (head) { current = head.name; item = null; if (head.rest) push(head.rest); continue; }
    push(line);
  }
  for (const key of Object.keys(out) as (keyof Sections)[]) {
    out[key] = out[key].filter((x) => !NOTHING.test(x)).map((x) => scrub(x, 600).trim()).filter(Boolean).slice(0, 10);
  }
  return out;
}
export const hasSections = (sections: Sections | null | undefined) => Boolean(sections && (sections.done.length || sections.remaining.length || sections.questions.length));

// Where a recommendation starts: an explicit word of the team, at the start of
// a line or of a sentence. Nothing else is ever taken for one.
const REC_WORDS = "je recommande|nous recommandons|l['’]équipe recommande|je conseille|nous conseillons|ma recommandation|notre recommandation|recommandation|i recommend|we recommend|the team recommends|my recommendation|our recommendation|recommendation|recommended";
const REC_AT_START = new RegExp(`^(?:\\(\\s*)?(?:${REC_WORDS})\\b`, 'iu');
const REC_INLINE = new RegExp(`(?:[.?!…;]\\s+|\\s[—–-]\\s+|\\(\\s*)(?=(?:${REC_WORDS})\\b)`, 'iu');
const splitRecommendation = (text: string) => {
  if (REC_AT_START.test(text)) return { before: '', rec: text };
  const match = REC_INLINE.exec(text);
  if (!match) return { before: text, rec: '' };
  const cut = match.index + match[0].length;
  // The sentence end stays with the question; an opening parenthesis goes with what it opens.
  const before = text.slice(0, cut).replace(/[\s(—–-]+$/, '').trim();
  return { before, rec: text.slice(cut).replace(/\)\s*$/, '').trim() };
};
const isQuestion = (text: string) => /[?？]/.test(text);

// The questions a team ended on (the "Questions for the user" lines that
// flow-lanes.sh keeps in the lane_asks event, or the report section): each
// with its full text, the team's recommendation when it states one, and the
// choices it put under it (lines like "- text", "1. text", "A) text", short,
// without a question mark, four at most). A numbered line that asks something
// is a question, not a choice. A block that opens with its recommendation
// ("I recommend keeping the button (who knows?) as it is.") keeps it as the
// recommendation; its question is the next line that is not one, or failing
// that the ticket's title (`fallback`). Nothing is said twice.
type Draft = { text: string; recommendation: string | null; options: string[]; item?: boolean };
export type Question = { text: string; recommendation: string | null; options: string[] };
export function questionsOf(text: unknown, { max = 4, fallback = '' }: { max?: number; fallback?: unknown } = {}): Question[] {
  const out: Draft[] = [];
  let current: Draft | null = null, last: string | null = null;
  const addRec = (rec: string) => { current!.recommendation = current!.recommendation ? `${current!.recommendation} ${rec}` : rec; last = 'rec'; };
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim()) continue;
    const head = heading(raw);
    if (head && head.name !== 'questions') break; // the next section of a report
    const line = plain(head ? head.rest : raw);
    if (!line || NOTHING.test(line.replace(MARK, ''))) continue;
    const marked = MARK.test(line);
    const body = line.replace(MARK, '').trim();
    const { before, rec } = splitRecommendation(body);
    if (!before && rec) {
      // A whole line of recommendation: it goes with the question at hand, or opens the next one (a new item after a recommendation).
      if (current && !(marked && current.recommendation && current.text)) { addRec(rec); continue; }
      current = { text: '', recommendation: rec, options: [], item: marked };
      out.push(current); last = 'rec';
      continue;
    }
    // The question of a block that opened with its recommendation. A list item that is only a
    // recommendation never borrows the next item: that one is its own question.
    if (current && !current.text && !(marked && current.item) && !(marked && body.length <= 80 && !isQuestion(before))) {
      current.text = before; last = 'text';
      if (rec) addRec(rec);
      continue;
    }
    // A line that asks, or that carries its own recommendation, opens a question.
    if (!current || isQuestion(before) || (rec && before)) {
      current = { text: before || body, recommendation: rec || null, options: [] };
      out.push(current); last = rec ? 'rec' : 'text';
      continue;
    }
    if (marked && body.length <= 80) { if (current.options.length < 4) current.options.push(body); last = 'option'; continue; }
    if (last === 'rec') current.recommendation = `${current.recommendation} ${body}`;
    else current.text = `${current.text} ${body}`;
  }
  return out.slice(0, max).map((q) => {
    // No question of its own: the ticket's title asks it; without one, the recommendation is said once, as the text.
    const own = q.text || scrub(fallback, 1500).trim();
    const [text, recommendation] = own ? [own, q.recommendation] : [q.recommendation ?? '', null];
    return { text: scrub(text, QUESTION_MAX).trim(), recommendation: recommendation ? scrub(recommendation, 600).trim() : null,
      options: q.options.map((o) => scrub(o, 80).trim()).filter(Boolean) };
  }).filter((q) => q.text);
}
// The first sentence of a question: what a card shows in full, whatever its length.
export function leadOf(text: unknown): string {
  const value = String(text ?? '').trim();
  const match = /^[^?？]*[?？]/u.exec(value) ?? /^[\s\S]*?[!.](?=\s|$)/u.exec(value);
  return (match ? match[0] : value).trim();
}

// node lib/board-report.ts clip-asked < questions: what the lane_asks event keeps.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'clip-asked') {
  process.stdout.write(clipAsked(readFileSync(0, 'utf8')));
}
