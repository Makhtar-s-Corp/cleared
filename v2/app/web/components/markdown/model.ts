// A ticket's text as a person reads it (the owner's request of 2026-10-30): the
// Markdown a ticket is written in, read into blocks and runs that the screen
// draws as elements, never as HTML. Headings, paragraphs, lists, fences, inline
// code, bold, italic and links with an http or https address; anything else
// stays the text it is. Pure, so the tests run it under Node.
export type Run =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong' | 'em'; readonly runs: readonly Run[] }
  | { readonly kind: 'link'; readonly href: string; readonly runs: readonly Run[] };

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly runs: readonly Run[] }
  | { readonly kind: 'paragraph'; readonly runs: readonly Run[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Run[])[] }
  | { readonly kind: 'code'; readonly text: string };

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index;
    const [whole, code, strong, strong2, em, em2, label, href] = match;
    if (label !== undefined && href !== undefined && !/^https?:\/\//i.test(href)) continue;     // another scheme stays text
    if (index > at) runs.push({ kind: 'text', text: text.slice(at, index) });
    if (code !== undefined) runs.push({ kind: 'code', text: code });
    else if (strong !== undefined || strong2 !== undefined) runs.push({ kind: 'strong', runs: runsOf((strong ?? strong2) as string) });
    else if (em !== undefined || em2 !== undefined) runs.push({ kind: 'em', runs: runsOf((em ?? em2) as string) });
    else runs.push({ kind: 'link', href: href as string, runs: runsOf(label as string) });
    at = index + whole.length;
  }
  if (at < text.length) runs.push({ kind: 'text', text: text.slice(at) });
  return runs;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const close = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', runs: runsOf(paragraph.join(' ')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const fence = FENCE.exec(line);
    if (fence) {
      close();
      const code: string[] = [];
      for (i += 1; i < lines.length && !(lines[i] as string).trimStart().startsWith(fence[1] as string); i += 1) code.push(lines[i] as string);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') { close(); continue; }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, runs: runsOf(heading[2] as string) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    if (bullet || number) {
      close();
      const ordered = number !== null && bullet === null;
      const pattern = ordered ? NUMBER : BULLET;
      const items: Run[][] = [];
      for (; i < lines.length; i += 1) {
        const item = pattern.exec(lines[i] as string);
        if (!item) break;
        items.push(runsOf(item[1] as string));
      }
      i -= 1;
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    paragraph.push(line.trim());
  }
  close();
  return blocks;
}
