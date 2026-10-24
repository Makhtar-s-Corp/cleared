// Open in an editor as HTML (docs/v2/complement-devin.md item 19, matrix
// C19, P120 to P125): the button in the thread's header, the two links it
// reveals (VS Code, Cursor) as plain anchors the person's own browser opens,
// the note when the checkout is on a server reached over SSH, nothing when
// the service gives no link, and the screen accepting only an editor's
// address from the service's answer; in both languages, with no inline style.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { OpenInEditor } from '../../screens/session/Tabs.tsx';
import { editorOffer } from '../../screens/session/tabs.ts';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

const LOCAL = { mode: 'local', links: [{ editor: 'vscode', url: 'vscode://file/work/T-1' }, { editor: 'cursor', url: 'cursor://file/work/T-1' }] } as const;
const REMOTE = {
  mode: 'ssh',
  links: [{ editor: 'vscode', url: 'vscode://vscode-remote/ssh-remote+dev.example.invalid/work/T-1' }, { editor: 'cursor', url: 'cursor://vscode-remote/ssh-remote+dev.example.invalid/work/T-1' }],
} as const;

test('the button, closed: one button that names the editors, and no link yet', () => {
  const markup = html(<OpenInEditor t={en} offer={LOCAL} />);
  assert.match(markup, /<button[^>]*id="open-editor"[^>]*aria-expanded="false"/);
  assert.ok(visibleText(markup).includes('Open in an editor'));
  assert.doesNotMatch(markup, /<a /, 'no link until it is opened');
  assert.doesNotMatch(markup, /\sstyle=|<style/);
});

test('the button, open: a link per editor, the address as given, to be followed by the person\'s own browser', () => {
  const markup = html(<OpenInEditor t={en} offer={LOCAL} expanded />);
  assert.match(markup, /<button[^>]*aria-expanded="true"/);
  const anchors = [...markup.matchAll(/<a [^>]*>[^<]*<\/a>/g)].map((m) => m[0]);
  assert.equal(anchors.length, 2);
  assert.match(anchors[0] as string, /href="vscode:\/\/file\/work\/T-1"/);
  assert.match(anchors[0] as string, /data-editor="vscode"/);
  assert.match(anchors[1] as string, /href="cursor:\/\/file\/work\/T-1"/);
  assert.match(anchors[1] as string, /data-editor="cursor"/);
  assert.deepEqual(anchors.map((a) => visibleText(a)), ['VS Code', 'Cursor']);
  assert.doesNotMatch(markup, /target=/, 'an editor\'s address opens no tab');
  assert.doesNotMatch(markup, /through SSH/i, 'no SSH note for this machine');
  assert.doesNotMatch(markup, /\sstyle=|<style/);
});

test('over SSH the screen says so, and the links are the remote ones', () => {
  const markup = html(<OpenInEditor t={en} offer={REMOTE} expanded />);
  assert.match(markup, /href="vscode:\/\/vscode-remote\/ssh-remote\+dev\.example\.invalid\/work\/T-1"/);
  assert.match(markup, /href="cursor:\/\/vscode-remote\/ssh-remote\+dev\.example\.invalid\/work\/T-1"/);
  assert.ok(visibleText(markup).includes('through SSH'));
});

test('in French: the button, the editors and the SSH note, with a no-break space before the colon', () => {
  const closed = html(<OpenInEditor t={fr} offer={LOCAL} />);
  assert.ok(visibleText(closed).includes('Ouvrir dans un éditeur'));
  const markup = html(<OpenInEditor t={fr} offer={REMOTE} expanded />);
  assert.ok(visibleText(markup).includes('VS Code') && visibleText(markup).includes('Cursor'));
  assert.ok(visibleText(markup).includes('par SSH'));
  assert.doesNotMatch(visibleText(markup), /[a-zé] [:;?!»]/, 'no ordinary space before a French mark');
});

test('without a link there is nothing to show', () => {
  assert.equal(html(<OpenInEditor t={en} offer={null} />), '');
  assert.equal(html(<OpenInEditor t={en} offer={null} expanded />), '');
});

test('the screen takes an editor\'s address from the service\'s answer and nothing else', () => {
  assert.deepEqual(editorOffer(LOCAL), LOCAL);
  assert.deepEqual(editorOffer(REMOTE), REMOTE);
  const bad = [
    null, undefined, 'text', [], {}, { mode: 'local' }, { mode: 'ftp', links: LOCAL.links }, { mode: 'local', links: [] },
    { mode: 'local', links: [{ editor: 'vscode', url: 'javascript:alert(1)' }] },
    { mode: 'local', links: [{ editor: 'vscode', url: 'https://example.invalid/work/T-1' }] },
    { mode: 'local', links: [{ editor: 'cursor', url: 'vscode://file/work/T-1' }] },             // another editor's scheme
    { mode: 'local', links: [{ editor: 'vim', url: 'vim://file/work/T-1' }] },
    { mode: 'local', links: [{ editor: 'vscode', url: 'vscode://file/work/T-1"onmouseover="x' }] },
    { mode: 'local', links: [{ editor: 'vscode', url: 'vscode://file/work/T-1 ' }] },
    { mode: 'local', links: [{ editor: 'vscode', url: 42 }] },
  ];
  for (const answer of bad) assert.equal(editorOffer(answer), null, JSON.stringify(answer));
});
