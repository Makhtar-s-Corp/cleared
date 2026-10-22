// The fixture sources answer the web terminal's routes and the editor's
// save (lane 32), as the service does: through the app, on the tower's
// fixture source, a session taken over opens its terminal, `ls` and Enter
// come back in the stream, a save with the loaded hash writes, a stale hash
// is a 409 with the current one, and Give back closes the terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { signedIn, startApp } from '../support.ts';

test('the tower\'s fixture source: the terminal of a session taken over, its stream, the save and Give back', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie, csrf } = await signedIn(app);
    const write = { cookie, 'x-csrf-token': csrf, origin: app.origin, 'content-type': 'application/json' };
    const api = (path: string, init: { method?: string; body?: unknown } = {}) => fetch(`${app.base}/api/service${path}`, {
      method: init.method ?? 'GET', headers: init.method && init.method !== 'GET' ? write : { cookie }, body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const sessions = await (await api('/sessions')).json() as { id: string; role: string; ticket: string }[];
    const author = sessions.find((s) => s.role === 'author' && s.ticket === 'LOCAL-161');
    assert.ok(author);
    const id = encodeURIComponent(author.id);

    assert.equal((await api(`/sessions/${id}/terminal/open`, { method: 'POST', body: { cols: 80, rows: 24 } })).status, 409, 'not taken over');
    assert.equal((await api(`/sessions/${id}/takeover`, { method: 'POST' })).status, 200);
    // Take over opens the session's harness first (owner request of 2026-10-22 17:26), the shell on request.
    const harness = await api(`/sessions/${id}/terminal/open`, { method: 'POST', body: { cols: 100, rows: 30 } });
    assert.deepEqual(await harness.json(), { opened: true, cols: 100, rows: 30, mode: 'harness', name: 'Claude Code' });
    const again = await api(`/sessions/${id}/terminal/open`, { method: 'POST', body: { cols: 100, rows: 30, mode: 'shell' } });
    assert.equal(again.status, 409, 'one at a time');
    assert.equal((await again.json() as { mode: string }).mode, 'harness', 'the open says which terminal is open');
    assert.equal((await api(`/sessions/${id}/terminal/close`, { method: 'POST' })).status, 200);
    const opened = await api(`/sessions/${id}/terminal/open`, { method: 'POST', body: { cols: 100, rows: 30, mode: 'shell' } });
    assert.deepEqual(await opened.json(), { opened: true, cols: 100, rows: 30, mode: 'shell' });
    assert.equal((await api(`/sessions/${id}/terminal/input`, { method: 'POST', body: { data: 'ls\r' } })).status, 200);
    assert.equal((await api(`/sessions/${id}/terminal/input`, { method: 'POST', body: { data: 'x'.repeat(4097) } })).status, 413);

    // The stream: what was written, held open until Give back closes it.
    const stream = await fetch(`${app.base}/api/service/sessions/${id}/terminal/stream`, { headers: { cookie } });
    assert.equal(stream.status, 200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    while (!text.includes('upcoming.test.mjs')) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^id: 1\nevent: data\ndata: \{"seq":1,/);
    assert.match(text, /256 colours/);
    assert.doesNotMatch(text, /docker exec|on the server|claude --resume/);

    // The save: the loaded hash writes, the same hash again is stale.
    const path = 'src/engine/upcoming.mjs';
    const file = await (await api(`/sessions/${id}/files/${path}`)).json() as { text: string; hash: string };
    const saved = await api(`/sessions/${id}/files/${path}`, { method: 'PUT', body: { text: `${file.text}// by hand\n`, hash: file.hash } });
    assert.equal(saved.status, 200);
    const { hash } = await saved.json() as { hash: string };
    assert.notEqual(hash, file.hash);
    const stale = await api(`/sessions/${id}/files/${path}`, { method: 'PUT', body: { text: 'x', hash: file.hash } });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { hash: string }).hash, hash, 'the current hash');
    assert.equal((await (await api(`/sessions/${id}/files/${path}`)).json() as { hash: string }).hash, hash, 'the file as saved');

    assert.equal((await api(`/sessions/${id}/giveback`, { method: 'POST' })).status, 200);
    while (!text.includes('event: closed')) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    assert.match(text, /event: closed\ndata: \{"reason":"give_back"\}/);
  } finally {
    await app.close();
  }
});
