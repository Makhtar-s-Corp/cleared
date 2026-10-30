// What `claude setup-token` prints, taken out of its terminal's output (issue
// #490). In Claude Code 2.1.306 the token is one coloured text of a column with
// a blank row after it, then "Store this token securely..."; a terminal wraps it
// on two lines or more, so the output is read without its escape sequences and
// the token's lines are joined. Nothing of the token goes on: from its first character it is held,
// then replaced by a mask, so that it reaches no browser and no terminal's
// kept output. Anything that is not the token passes as it came.
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\^_])/y;
const OPEN_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*)?$/;
const PREFIX = 'sk-ant-';
const API_KEY = 'sk-ant-api';                  // an API key is not what the adapter reads (setup/steps/model.ts)
export const TOKEN_MASK = '••••••••';

// The text without its escape sequences, each kept character with its place in the text.
function plainOf(text: string): { readonly plain: string; readonly at: readonly number[] } {
  let plain = '';
  const at: number[] = [];
  for (let i = 0; i < text.length;) {
    ESCAPE.lastIndex = i;
    const escape = text[i] === '\u001b' ? ESCAPE.exec(text) : null;
    if (escape) {
      // The sign-in screen draws a space as a move to the right, and may go to a new line by a move down.
      const move = /^\u001b\[[\d;]*([CBEHfd])$/.exec(escape[0])?.[1];
      if (move) { plain += move === 'C' ? ' ' : '\n'; at.push(i); }
      i += escape[0].length;
      continue;
    }
    plain += text[i];
    at.push(i);
    i += 1;
  }
  at.push(text.length);
  return { plain, at };
}

// Where the token starting at `start` ends, its characters joined, or nothing
// while a line of it may still be coming. A line goes on the token when it is
// one word of the token's characters alone: a blank line or a line of words ends it.
function tokenAt(plain: string, start: number, final: boolean): { readonly token: string; readonly end: number } | undefined {
  let token = '';
  let at = start;
  for (;;) {
    const word = /[A-Za-z0-9_-]*/y;
    word.lastIndex = at;
    token += word.exec(plain)?.[0] ?? '';
    at = word.lastIndex;
    const gap = /[ \t]*\r*\n[ \t]*/y;
    gap.lastIndex = at;
    const newline = gap.exec(plain);
    if (!newline) {
      if (at >= plain.length || /^[ \t]*\r*$/.test(plain.slice(at))) return final ? { token, end: plain.length } : undefined;
      return { token, end: at };
    }
    const next = plain.slice(gap.lastIndex);
    const line = /^([A-Za-z0-9_-]*)([ \t]*\r*)(\n|$)/.exec(next);
    if (!line) return { token, end: at };                                      // a line of words
    if (line[1] === '') {
      if (line[3] === '\n' || final) return { token, end: at };                // a blank line
      return undefined;
    }
    if (line[3] === '' && !final) return undefined;                            // the line may not be whole
    at = gap.lastIndex;
  }
}

export type TokenCatch = {
  // What may be shown of this output; a token found goes to onToken first.
  push(text: string): string;
  // The output paused or ended: what was held is decided as it stands.
  flush(): string;
  readonly holding: boolean;
};

export function tokenCatch(onToken: (token: string) => void): TokenCatch {
  let held = '';
  const read = (final: boolean): string => {
    let shown = '';
    for (;;) {
      // An escape not whole yet is no text: it waits at the end of what is held.
      const open = final ? null : OPEN_ESCAPE.exec(held);
      const body = open ? held.slice(0, open.index) : held;
      const tail = open ? open[0] : '';
      const { plain, at } = plainOf(body);
      const start = plain.indexOf(PREFIX);
      if (start >= 0 && plain.startsWith(API_KEY, start)) {
        // Not a token this step takes: passes as written.
        const after = at[start + PREFIX.length] ?? body.length;
        shown += body.slice(0, after);
        held = body.slice(after) + tail;
        continue;
      }
      if (start < 0) {
        // Only what might still become the token stays held.
        let keep = 0;
        if (!final) {
          for (let size = Math.min(PREFIX.length - 1, plain.length); size > 0; size -= 1) {
            if (PREFIX.startsWith(plain.slice(plain.length - size))) { keep = body.length - (at[plain.length - size] ?? body.length); break; }
          }
        }
        shown += body.slice(0, body.length - keep);
        held = body.slice(body.length - keep) + tail;
        return shown;
      }
      const found = tokenAt(plain, start, final);
      if (!found) {
        const from = at[start] ?? 0;
        shown += body.slice(0, from);
        held = body.slice(from) + tail;
        return shown;
      }
      shown += body.slice(0, at[start] ?? 0) + TOKEN_MASK;
      held = body.slice(at[found.end] ?? body.length) + tail;
      onToken(found.token);
    }
  };
  return {
    push(text) { held += text; return read(false); },
    flush() { return read(true); },
    get holding() { return held !== ''; },
  };
}
