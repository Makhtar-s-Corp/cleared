// What a handover proposes as knowledge (docs/v2/milestone-2-plan.md,
// decision 27, lane 24): the entries of its lessons sections (lane 19's
// headings, workspace/briefing.ts) and of its decisions sections (this
// file's), each at the level its heading names. The sections are read as
// lib/memory stored the handover, outside fenced code blocks
// (workspace/handover.ts).
//
// An entry is a top-level list item of a section, with its continuation
// lines; the text before a section's first item is one entry too, and a
// section with no list is one entry. The same entry twice at one level is
// proposed once.
import type { KnowledgeLevel } from '../api/types.ts';
import { DECISION_HEADINGS, LESSON_HEADINGS, sectionsOf } from '../workspace/handover.ts';

export { DECISION_HEADINGS };

// The longest entry the inbox shows, in characters; a longer one is cut and says so.
export const MAX_PROPOSAL = 4000;

export type ProposalKind = 'lesson' | 'decision';
export type Proposal = { readonly kind: ProposalKind; readonly level: KnowledgeLevel; readonly text: string };

const LEVELS = Object.keys(LESSON_HEADINGS) as KnowledgeLevel[];

// A top-level list item: `-`, `*` or `+`, or a number with `.` or `)`, at
// the start of the line, then a space.
const ITEM = /^(?:[-*+]|\d{1,9}[.)]) +(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function cut(text: string): string {
  return text.length <= MAX_PROPOSAL ? text : `${text.slice(0, MAX_PROPOSAL).trimEnd()} [cut at ${MAX_PROPOSAL} characters]`;
}

// The entries of one section's body, in order.
export function entriesOf(body: string): string[] {
  const entries: string[][] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const fenceRun = FENCE.exec(line)?.[1];
    if (fence === null) {
      const item = ITEM.exec(line);
      if (item) {
        entries.push(current);
        current = [item[1] as string];
        continue;
      }
      if (fenceRun) fence = fenceRun;
    } else if (fenceRun && fenceRun[0] === fence[0] && fenceRun.length >= fence.length && line.trim() === fenceRun) fence = null;
    current.push(line);
  }
  entries.push(current);
  return entries.map((lines) => lines.join('\n').trim()).filter((text) => text !== '');
}

export function proposalsOf(content: string): Proposal[] {
  const out: Proposal[] = [];
  const seen = new Set<string>();
  for (const section of sectionsOf(content)) {
    let found: { kind: ProposalKind; level: KnowledgeLevel } | undefined;
    for (const level of LEVELS) {
      if (section.heading === LESSON_HEADINGS[level]) found = { kind: 'lesson', level };
      if (section.heading === DECISION_HEADINGS[level]) found = { kind: 'decision', level };
    }
    if (!found) continue;
    for (const entry of entriesOf(section.body)) {
      const text = cut(entry);
      const key = `${found.level}\n${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...found, text });
    }
  }
  return out;
}
