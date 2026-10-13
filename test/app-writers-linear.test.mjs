// The second tracker, as the human. The fake server lives inside the test block: provider names belong
// to adapter tests only (see the first test of tracker.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bearer, body, box, listen, VERSIONS } from './app-box.mjs';

test('[Linear adapter] the three gestures use the human\'s own token and the history shows the human; the application of the agents is refused as an identity', async (t) => {
  const HUMAN = 'lin_oauth_humanhumanhuman1234';
  const APP = 'lin_oauth_agentsagentsagents99';
  const fake = async () => {
    const state = { state: 'Needs Approval', history: [], comments: [], tokens: new Set() };
    const viewer = (token) => (token === HUMAN ? { id: 'lin-human', app: false } : { id: 'lin-app', app: true });
    const server = await listen(async (request, response) => {
      const token = bearer(request); state.tokens.add(token);
      const { query, variables } = JSON.parse(await body(request));
      const reply = (data) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      if (!token) return response.writeHead(401).end('{}');
      if (query.includes('history(first')) return reply({ viewer: viewer(token), issue: { history: { nodes: state.history } } });
      if (query.includes('teams(filter')) return reply({ issue: { id: 'iid' }, teams: { nodes: [{ states: { nodes: ['Ready to Ship', 'In Progress', 'Needs Approval'].map((name) => ({ id: `id-${name}`, name })) } }] } });
      if (query.includes('viewer { id app }')) return reply({ viewer: viewer(token) });
      if (query.includes('state { name }')) return reply({ issue: { state: { name: state.state } } });
      if (query.includes('issueUpdate')) {
        const name = variables.input.stateId.replace(/^id-/, '');
        state.state = name;
        state.history.push({ createdAt: new Date().toISOString(), actorId: viewer(token).id, actor: { id: viewer(token).id, app: viewer(token).app }, botActor: null, toState: { name } });
        return reply({ issueUpdate: { success: true } });
      }
      if (query.includes('commentCreate')) { state.comments.push({ body: variables.input.body, by: viewer(token).id }); return reply({ commentCreate: { success: true } }); }
      return reply({ issue: { id: 'iid' } });
    });
    t.after(() => server.close());
    return { state, env: { CLEARED_APP_LINEAR_API: `http://127.0.0.1:${server.address().port}/graphql` } };
  };
  const scratch = () => box('linear', { owner: 'lin-human', ticket: 'ENG-12' });

  // The human's own token.
  let server = await fake(); let b = scratch();
  b.credentials(HUMAN); b.approvalRecord();
  const run = (request) => b.write(request, server.env);
  assert.equal((await run({ op: 'answer', ticket: b.ticket, text: 'No' })).ok, true);
  assert.deepEqual(server.state.comments, [{ body: 'No', by: 'lin-human' }]);
  assert.equal((await run({ op: 'approve', ticket: b.ticket, versions: [{ pr: 7, head: 'd'.repeat(40) }], at: b.at })).code, 'version');
  assert.equal(server.state.state, 'Needs Approval', 'a version that is not the one shown moves nothing');
  const approved = await run({ op: 'approve', ticket: b.ticket, versions: VERSIONS, at: b.at });
  assert.equal(approved.ok, true, JSON.stringify(approved)); assert.equal(approved.verified, true);
  assert.equal(server.state.state, 'Ready to Ship'); assert.equal(server.state.history.at(-1).actorId, 'lin-human');
  server.state.state = 'Needs Approval'; b.approvalRecord();
  const back = await run({ op: 'sendback', ticket: b.ticket, text: 'Round it.' });
  assert.equal(back.ok, true, JSON.stringify(back)); assert.equal(server.state.state, 'In Progress');
  assert.deepEqual(server.state.comments.at(-1), { body: 'Round it.', by: 'lin-human' });
  assert.deepEqual([...server.state.tokens], [HUMAN], 'only the human\'s token was ever presented');

  // The application of the agents: not the human, so nothing is written.
  server = await fake(); b = scratch();
  b.credentials(APP); b.approvalRecord();
  for (const request of [{ op: 'approve', ticket: b.ticket, versions: VERSIONS, at: b.at }, { op: 'sendback', ticket: b.ticket, text: 'x' }, { op: 'answer', ticket: b.ticket, text: 'x' }]) {
    const result = await b.write(request, server.env);
    assert.equal(result.ok, false); assert.equal(result.code, 'identity');
  }
  assert.deepEqual(server.state.comments, []); assert.equal(server.state.state, 'Needs Approval');
});
