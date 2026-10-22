// What a human types into the web terminal, cut into lines for the journal
// (docs/v2/milestone-2-plan.md, decision 32): a line ends at Enter (the
// browser's terminal sends a carriage return, a pasted text may carry line
// feeds), and the rest is given at the close. The keys that edit the line
// being typed are applied (Backspace, Ctrl-U); the other control keys and
// the escape sequences (the arrows, the function keys) are left out, and
// Ctrl-C and Ctrl-D are written as ^C and ^D. A line is kept whole until it
// ends, whatever posts it came in, so the cleaner sees a secret typed in
// several posts at once.
//
// This is what the keys were, not what the shell made of them: a line
// recalled from the history is journaled as the keys that recalled it.
export class TypedLines {
  #line = '';
  #escape: '' | 'esc' | 'csi' | 'ss3' | 'osc' = '';
  #lastWasCr = false;

  // The lines this input ends, in order.
  feed(data: string): string[] {
    const done: string[] = [];
    for (const char of data) {
      const cr = this.#lastWasCr;
      this.#lastWasCr = false;
      if (this.#escape === 'esc') {
        this.#escape = char === '[' ? 'csi' : char === 'O' ? 'ss3' : char === ']' ? 'osc' : '';
        continue;
      }
      if (this.#escape === 'csi') {
        if (char >= '@' && char <= '~') this.#escape = '';
        continue;
      }
      if (this.#escape === 'ss3') {
        this.#escape = '';
        continue;
      }
      if (this.#escape === 'osc') {
        if (char === '\u0007') this.#escape = '';
        else if (char === '\u001b') this.#escape = 'esc';
        continue;
      }
      if (char === '\u001b') this.#escape = 'esc';
      else if (char === '\r') {
        done.push(this.#take());
        this.#lastWasCr = true;
      } else if (char === '\n') {
        if (!cr) done.push(this.#take());
      } else if (char === '\u007f' || char === '\b') this.#line = [...this.#line].slice(0, -1).join('');
      else if (char === '\u0015') this.#line = '';
      else if (char === '\u0003') done.push(this.#take('^C'));
      else if (char === '\u0004') { if (this.#line !== '') this.#line += '^D'; }
      else if (char === '\t' || char >= ' ') this.#line += char;
    }
    return done;
  }

  // What was typed and not yet ended by an Enter: given at the close, or nothing.
  rest(): string | undefined {
    const line = this.#take();
    return line === '' ? undefined : line;
  }

  #take(suffix = ''): string {
    const line = this.#line + suffix;
    this.#line = '';
    return line;
  }
}
