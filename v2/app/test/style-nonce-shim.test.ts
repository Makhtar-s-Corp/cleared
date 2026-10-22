// The page's style nonce for the web terminal (lane v2-j2-deps-xterm): a
// <style> element inserted by script gets the nonce, one in a fragment or
// with its own nonce does not, and uninstalling restores the page's methods;
// a script-set style attribute of colours only goes through the CSSOM, any
// other value through the native setAttribute. The browser's own check is
// the lane's probe (the pull request); these run on fake prototypes, since
// the repository has no DOM library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cssomColours, installStyleAttributeCssom, installStyleNonce } from '../web/lib/style-nonce.ts';

// Fresh constructors per test, since the shims patch their prototypes.
function fakes() {
  class FakeNode {
    readonly inserted: unknown[] = [];
    appendChild(node: unknown): unknown { this.inserted.push(node); return node; }
    insertBefore(node: unknown, _reference: unknown): unknown { this.inserted.push(node); return node; }
  }
  class FakeElement extends FakeNode {
    readonly attributes = new Map<string, string>();
    nativeSets = 0;
    append(...nodes: unknown[]): void { this.inserted.push(...nodes); }
    prepend(...nodes: unknown[]): void { this.inserted.unshift(...nodes); }
    setAttribute(name: string, value: string): void { this.nativeSets += 1; this.attributes.set(name, value); }
  }
  class FakeStyle extends FakeElement {
    get nonce(): string { return this.attributes.get('nonce') ?? ''; }
  }
  class FakeStyled extends FakeElement {
    readonly style = { cssText: '' };
  }
  class FakeFragment extends FakeNode {}
  return { Node: FakeNode, Element: FakeElement, HTMLStyleElement: FakeStyle, FakeStyled, FakeFragment };
}

test('a <style> element inserted by each of the four methods gets the nonce', (t) => {
  const scope = fakes();
  t.after(installStyleNonce('n0nce', scope));
  const parent = new scope.Element();
  const styles = [new scope.HTMLStyleElement(), new scope.HTMLStyleElement(), new scope.HTMLStyleElement(), new scope.HTMLStyleElement()];
  parent.appendChild(styles[0]);
  parent.insertBefore(styles[1], null);
  parent.append(styles[2]);
  parent.prepend(styles[3]);
  assert.deepEqual(styles.map((style) => style.nonce), ['n0nce', 'n0nce', 'n0nce', 'n0nce']);
  assert.equal(parent.inserted.length, 4, 'the original methods still insert');
});

test('a style element\'s own nonce is kept, and the reference node of insertBefore is not given one', (t) => {
  const scope = fakes();
  t.after(installStyleNonce('page', scope));
  const parent = new scope.Element();
  const own = new scope.HTMLStyleElement();
  own.setAttribute('nonce', 'its-own');
  parent.appendChild(own);
  assert.equal(own.nonce, 'its-own');
  const reference = new scope.HTMLStyleElement();
  const inserted = new scope.HTMLStyleElement();
  parent.insertBefore(inserted, reference);
  assert.equal(inserted.nonce, 'page');
  assert.equal(reference.nonce, '');
});

test('a style element inside a fragment, and an element that is not a style, get no nonce', (t) => {
  const scope = fakes();
  t.after(installStyleNonce('page', scope));
  const parent = new scope.Element();
  const fragment = new scope.FakeFragment();
  const nested = new scope.HTMLStyleElement();
  fragment.inserted.push(nested); // as the parser puts it there, with no insertion method
  parent.appendChild(fragment);
  assert.equal(nested.nonce, '', 'only the inserted node itself is looked at, never its descendants');
  const other = new scope.Element();
  parent.append(other);
  assert.equal(other.attributes.has('nonce'), false);
});

test('uninstalling restores the original methods, and installing again replaces the nonce without wrapping twice', () => {
  const scope = fakes();
  const originals = [scope.Node.prototype.appendChild, scope.Node.prototype.insertBefore, scope.Element.prototype.append, scope.Element.prototype.prepend];
  const first = installStyleNonce('first', scope);
  assert.notEqual(scope.Node.prototype.appendChild, originals[0]);
  const second = installStyleNonce('second', scope);
  const style = new scope.HTMLStyleElement();
  new scope.Element().appendChild(style);
  assert.equal(style.nonce, 'second');
  first();
  assert.notEqual(scope.Node.prototype.appendChild, originals[0], 'an old uninstall does not undo the current install');
  second();
  assert.deepEqual([scope.Node.prototype.appendChild, scope.Node.prototype.insertBefore, scope.Element.prototype.append, scope.Element.prototype.prepend], originals);
  const after = new scope.HTMLStyleElement();
  new scope.Element().appendChild(after);
  assert.equal(after.nonce, '');
});

test('an empty nonce is refused', () => {
  assert.throws(() => installStyleNonce('', fakes()), /style nonce/);
});

test('the colours the terminal writes are accepted, anything else is not', () => {
  for (const value of ['background-color:#fcfcfc;', 'color:#c81e28;', 'background-color:#0ac828;color:#c81e28;', 'color:#c81e28ff;', 'color: rgb(1, 2, 3)', 'background-color:rgba(1,2,3,0.5)']) {
    assert.equal(cssomColours(value), true, value);
  }
  for (const value of ['', ';', 'color', 'position:fixed', 'color:red', 'color:#fff;position:fixed', 'background-color:url(https://example.invalid/x)', 'color:#fff !important', 'color:expression(1)', 'background:#fff', 'color:rgb(1,2)']) {
    assert.equal(cssomColours(value), false, value);
  }
});

test('a style attribute of colours is written through the CSSOM, anything else through the native setAttribute', (t) => {
  const scope = fakes();
  t.after(installStyleAttributeCssom(scope));
  const cell = new scope.FakeStyled();
  cell.setAttribute('style', 'background-color:#0ac828;color:#c81e28;');
  assert.equal(cell.style.cssText, 'background-color:#0ac828;color:#c81e28;');
  assert.equal(cell.nativeSets, 0);
  cell.setAttribute('style', 'position:fixed');
  assert.equal(cell.nativeSets, 1);
  assert.equal(cell.attributes.get('style'), 'position:fixed');
  cell.setAttribute('class', 'xterm-fg-1');
  assert.equal(cell.nativeSets, 2);
  const bare = new scope.Element();
  bare.setAttribute('style', 'color:#fff');
  assert.equal(bare.nativeSets, 1, 'an element with no style property keeps the native call');
});

test('the CSSOM shim uninstalls, and installing it again does not wrap twice', () => {
  const scope = fakes();
  const original = scope.Element.prototype.setAttribute;
  const first = installStyleAttributeCssom(scope);
  const second = installStyleAttributeCssom(scope);
  first();
  const cell = new scope.FakeStyled();
  cell.setAttribute('style', 'color:#fff');
  assert.equal(cell.nativeSets, 0, 'the current install still converts');
  second();
  assert.equal(scope.Element.prototype.setAttribute, original);
  cell.setAttribute('style', 'color:#fff');
  assert.equal(cell.nativeSets, 1);
});
