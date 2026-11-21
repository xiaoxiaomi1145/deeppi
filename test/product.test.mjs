import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDeeppiServer } from '../server/index.mjs';
import { readEvents } from '../web/sse.ts';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await server.stopDeeppi?.();
    server.close();
    server.closeAllConnections();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, demo = true) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'deeppi-product-')));
  t.after(() => rm(workspace, { recursive: true }));
  const accessToken = 'product-fixture-access';
  async function open() {
    const base = await listen(t, createDeeppiServer({ workspace, demo, accessToken, dataDir: join(workspace, 'state') }));
    async function request(path, method = 'GET', body) {
      const response = await fetch(`${base}/api${path}`, {
        method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }
    return { base, accessToken, request };
  }
  return { workspace, open, ...await open() };
}

async function idle(request, id) {
  for (let i = 0; i < 150; i++) {
    const { data: { session } } = await request(`/sessions/${id}`);
    if (session.status === 'idle') return session;
    await delay(20);
  }
  assert.fail('Waiting for Pi to settle timed out');
}

function complete(res, request, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model: request.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 },
  })}\n\ndata: [DONE]\n\n`);
}

async function localModel(t, handle) {
  const requests = [];
  const origin = await listen(t, createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    requests.push({ path: req.url, authorization: req.headers.authorization, payload });
    handle(res, payload, requests.length);
  }));
  return { origin, requests };
}

test('workspace selection and defaults survive restart without moving existing chats', async t => {
  const { workspace, request, open } = await fixture(t);
  const project = join(workspace, '我的 项目');
  await mkdir(project);
  const old = (await request('/sessions', 'POST', {})).data.session;
  const listed = await request(`/directories?path=${encodeURIComponent(workspace)}`);
  assert.equal(listed.status, 200);
  assert.ok(listed.data.folders.some(folder => folder.path === project));
  const added = await request('/workspaces', 'POST', { action: 'save', path: project, name: '我的项目', activate: true });
  assert.equal(added.status, 200);
  assert.equal(added.data.defaults.cwd, project);
  assert.equal((await request('/settings', 'PATCH', { settings: { systemPrompt: '新会话的提示', maxTurns: 5 } })).status, 200);

  const fresh = await open();
  assert.equal((await fresh.request('/info')).data.defaults.cwd, project);
  const created = await fresh.request('/sessions', 'POST', { settings: { maxTurns: 3 } });
  assert.equal(created.status, 201);
  assert.equal(created.data.session.settings.cwd, project);
  assert.equal(created.data.session.settings.systemPrompt, '新会话的提示');
  assert.equal(created.data.session.settings.maxTurns, 3);
  const all = (await fresh.request('/sessions')).data.sessions;
  assert.equal(all.find(row => row.id === old.id).cwd, workspace);
  assert.equal(all.find(row => row.id === created.data.session.id).cwd, project);
  assert.equal((await fresh.request(`/sessions/${old.id}`)).data.session.settings.systemPrompt, '');
});

test('production startup sends real Pi probe and conversation through scoped defaults', async t => {
  const { request } = await fixture(t, false);
  const first = await localModel(t, (res, payload) => complete(res, payload, 'real fixture reply'));
  const second = await localModel(t, (res, payload) => complete(res, payload, 'other endpoint reply'));
  const settings = { provider: 'openai-compatible', baseUrl: `${first.origin}/v1`, model: 'production-fixture' };
  const configured = await request('/settings', 'PATCH', { settings, apiKey: 'primary-fixture-secret' });
  assert.equal(configured.status, 200);
  assert.equal(configured.data.hasDefaultKey, true);
  assert.doesNotMatch(JSON.stringify(configured.data), /primary-fixture-secret/u);
  assert.ok(configured.data.models.deepseek.some(model => model.id === 'deepseek-flash'));
  const probed = await request('/connection', 'POST', {});
  assert.equal(probed.status, 200);
  assert.equal(probed.data.model, 'production-fixture');
  assert.equal((await request('/sessions')).data.sessions.length, 0);
  const { data: { session } } = await request('/sessions', 'POST', {});
  assert.equal((await request(`/sessions/${session.id}/prompt`, 'POST', { text: '这是正常聊天。' })).status, 202);
  assert.ok((await idle(request, session.id)).messages.some(message => message.text === 'real fixture reply'));
  assert.equal(first.requests.length, 2);
  assert.equal(first.requests[0].path, '/v1/chat/completions');
  assert.ok(first.requests.every(call => call.authorization === 'Bearer primary-fixture-secret'));
  const customProbe = await request('/connection', 'POST', { sessionId: session.id, settings: { baseUrl: `${second.origin}/v1` } });
  assert.equal(customProbe.status, 200);
  assert.equal(second.requests.length, 1);
  assert.notEqual(second.requests[0].authorization, 'Bearer primary-fixture-secret');
});

test('Pi continues a failed response without submitting the prompt twice', async t => {
  const { request } = await fixture(t, false);
  const upstream = await localModel(t, (res, payload, count) => {
    if (count > 1) return complete(res, payload, '续答成功');
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture rejects the first request' } }));
  });
  const { data: { session } } = await request('/sessions', 'POST', {
    settings: { provider: 'openai-compatible', model: 'continue-fixture', baseUrl: `${upstream.origin}/v1` },
  });
  const path = `/sessions/${session.id}`;
  await request(`${path}/prompt`, 'POST', { text: '保留这条用户消息' });
  const interrupted = await idle(request, session.id);
  assert.equal(interrupted.canContinue, true);
  assert.equal((await request(`${path}/continue`, 'POST', {})).status, 202);
  const resumed = await idle(request, session.id);
  assert.equal(resumed.canContinue, false);
  assert.equal(resumed.error, undefined);
  assert.deepEqual(resumed.messages.filter(message => message.role === 'user').map(message => message.text), ['保留这条用户消息']);
  assert.equal(resumed.messages.at(-1).text, '续答成功');
  assert.equal(upstream.requests.length, 2);
  assert.equal((await request(`${path}/continue`, 'POST', {})).status, 409);
});

test('live updates append only the new timeline tail, while reconnects get a complete snapshot', async t => {
  const { base, accessToken, request } = await fixture(t);
  const { data: { session: { id } } } = await request('/sessions', 'POST', {});
  const path = `/sessions/${id}`;
  await request(`${path}/prompt`, 'POST', { text: 'old conversation marker' });
  const before = await idle(request, id);
  const abort = new AbortController();
  const seen = [];
  const response = await fetch(`${base}/api${path}/events`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: abort.signal });
  const stream = readEvents(response.body, (event, data) => seen.push({ event, data })).catch(error => {
    if (!abort.signal.aborted) throw error;
  });
  try {
    await request(`${path}/prompt`, 'POST', { text: 'new conversation marker' });
    await idle(request, id);
    for (let i = 0; i < 50 && !seen.some(row => row.event === 'update' && row.data.status === 'idle'); i++) await delay(20);
    assert.equal(seen[0].event, 'state');
    assert.deepEqual(seen[0].data.messages, before.messages);
    const updates = seen.filter(row => row.event === 'update');
    assert.ok(updates.length > 0);
    assert.ok(updates.every(row => row.data.messagesFrom >= before.messages.length));
    assert.ok(updates.some(row => row.data.messages.some(message => message.text === 'new conversation marker')));
    assert.doesNotMatch(JSON.stringify(updates.map(row => row.data.messages)), /old conversation marker/u);
  } finally {
    abort.abort();
    await stream;
  }
});
