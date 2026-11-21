import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createDeeppiServer } from '../server/index.mjs';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, demo) {
  const root = await mkdtemp(join(tmpdir(), 'deeppi-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { dataDir: join(root, 'state'), workspace: root, demo, bashAvailable: true, accessToken: 'fixture-local-access' };
  async function start(overrides = {}) {
    const { accessToken, ...serverOptions } = { ...options, ...overrides };
    const base = await listen(t, createDeeppiServer({ ...serverOptions, accessToken }));
    return Object.assign(async (path, method = 'GET', body) => {
      const res = await fetch(`${base}/api${path}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    }, { base });
  }
  return { options, start, request: await start() };
}

async function idle(request, id) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { body: { session } } = await request(`/sessions/${id}`);
    if (session.status === 'idle') return session;
    await delay(25);
  }
  assert.fail('Session timeout');
}

test('the session API requires the launch credential, including the event stream', async t => {
  const { request, start, options } = await fixture(t, true);
  const { body: { session: { id } } } = await request('/sessions', 'POST', {});
  const events = `${request.base}/api/sessions/${id}/events`;
  for (const path of ['/api/info', '/api/sessions', `/api/sessions/${id}/events`]) {
    const res = await fetch(`${request.base}${path}`);
    const status = res.status;
    await res.body.cancel();
    assert.equal(status, 401);
  }
  const headers = { authorization: `Bearer ${options.accessToken}` };
  const wrongOrigin = await fetch(`${request.base}/api/info`, { headers: { ...headers, origin: 'http://localhost:9' } });
  assert.equal(wrongOrigin.status, 403);
  const stream = await fetch(events, { headers });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  try {
    let initial = '';
    while (!initial.includes('\n\n')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      initial += new TextDecoder().decode(chunk.value);
    }
    assert.match(initial, /^event: state\ndata: /u);
    assert.ok(initial.includes(id));
  } finally {
    await reader.cancel();
  }
  const granted = await request(`/sessions/${id}`, 'PATCH', { settings: { allowBash: true } });
  assert.equal(granted.body.session.settings.allowBash, true);
  const reopened = await start({ accessToken: 'fixture-fresh-access', bashAvailable: false });
  const invalid = await fetch(`${reopened.base}/api/info`, { headers });
  assert.equal(invalid.status, 401);
  assert.equal((await reopened('/info')).body.bashAvailable, false);
  assert.equal((await reopened(`/sessions/${id}`)).body.session.settings.allowBash, false);
  assert.equal((await reopened(`/sessions/${id}`, 'PATCH', { settings: { allowBash: true } })).status, 403);
  assert.equal((await reopened('/sessions', 'POST', { settings: { allowBash: true } })).status, 403);
});

test('Pi runs persisted Bash definitions, queues children, and compacts without losing the visible transcript', async t => {
  const { request, start } = await fixture(t, true);
  const { body: { session: { id } } } = await request('/sessions', 'POST', {});
  const endpoint = `/sessions/${id}`;
  assert.equal((await request(endpoint, 'PATCH', { settings: { allowBash: true, maxSubagents: 1 } })).status, 200);
  assert.equal((await request(`${endpoint}/prompt`, 'POST', { text: '演示 Bash' })).status, 202);
  let session = await idle(request, id);
  assert.equal(session.error, undefined);
  assert.deepEqual(session.tools.map(tool => tool.name), ['say_hello']);
  assert.ok(session.messages.some(message => message.role === 'tool' && message.name === 'run_tool' && /Hello, Deeppi!/.test(message.text)));
  await request(`${endpoint}/prompt`, 'POST', { text: '演示子代理' });
  session = await idle(request, id);
  assert.equal(session.error, undefined);
  assert.equal(session.agents.length, 2);
  assert.equal(session.agents.filter(child => child.status === 'done').length, 2);
  assert.equal(session.messages.filter(message => message.name === 'delegate').length, 2);
  const before = session.messages;
  assert.equal((await request(`${endpoint}/compact`, 'POST', { focus: 'Bash 的结果' })).status, 202);
  session = await idle(request, id);
  assert.equal(session.error, undefined);
  assert.deepEqual(session.messages, before);
  assert.equal(session.compactions.length, 1);
  assert.match(session.compactions[0].summary, /Bash 的结果/);
  assert.ok(session.compactions[0].beforeTokens > session.compactions[0].afterTokens);
  assert.ok(session.cache.compactionInput > 0);
  const reopened = await start();
  const loaded = (await reopened(endpoint)).body.session;
  assert.deepEqual(loaded.messages, before);
  assert.deepEqual(loaded.tools, session.tools);
  assert.equal(loaded.context.coveredMessages, session.context.coveredMessages);
});

test('system prompts and generation settings persist independently per session', async t => {
  const { request, start } = await fixture(t, true);
  const first = (await request('/sessions', 'POST', {})).body.session;
  const second = (await request('/sessions', 'POST', {})).body.session;
  const firstPatch = { systemPrompt: 'Use concise Chinese.', maxTurns: 3 };
  const secondPatch = { systemPrompt: 'Use formal English.', maxTurns: 8 };
  assert.equal((await request(`/sessions/${first.id}`, 'PATCH', { settings: firstPatch })).status, 200);
  assert.equal((await request(`/sessions/${second.id}`, 'PATCH', { settings: secondPatch })).status, 200);
  const reopened = await start();
  for (const [session, expected] of [[first, firstPatch], [second, secondPatch]]) {
    const { settings } = (await reopened(`/sessions/${session.id}`)).body.session;
    assert.equal(settings.systemPrompt, expected.systemPrompt);
    assert.equal(settings.maxTurns, expected.maxTurns);
  }
});

test('the DeepSeek adapter sends a stable system and tool prefix and reports real-shaped cache usage', async t => {
  const upstreamRequests = [];
  const upstream = await listen(t, createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    upstreamRequests.push({ headers: req.headers, body: JSON.parse(raw) });
    const common = { id: 'r1', object: 'chat.completion.chunk', created: 123, model: 'deepseek-flash' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: 'mock answer' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, choices: [], usage: { prompt_tokens: 220, completion_tokens: 20, prompt_cache_hit_tokens: 160, prompt_cache_miss_tokens: 60 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }));
  const { request, options } = await fixture(t, false);
  const { body: { session: { id } } } = await request('/sessions', 'POST', {});
  const endpoint = `/sessions/${id}`;
  const settings = { baseUrl: upstream, systemPrompt: 'Test-specific prompt.', allowBash: true };
  assert.equal((await request(endpoint, 'PATCH', { settings, apiKey: 'fixture-key' })).status, 200);
  for (const text of ['first round', 'second round']) {
    assert.equal((await request(`${endpoint}/prompt`, 'POST', { text })).status, 202);
    const session = await idle(request, id);
    assert.equal(session.error, undefined);
  }
  assert.equal(upstreamRequests.length, 2);
  const [first, second] = upstreamRequests;
  assert.equal(first.headers.authorization, 'Bearer fixture-key');
  assert.match(first.body.messages[0].content, /Test-specific prompt\./);
  assert.deepEqual(second.body.messages.slice(0, first.body.messages.length), first.body.messages);
  assert.deepEqual(second.body.tools, first.body.tools);
  assert.ok(first.body.tools.some(tool => tool.function.name === 'run_tool'));
  const { body: { session } } = await request(endpoint);
  assert.deepEqual(session.cache.last, { input: 220, hit: 160, miss: 60, unreported: 0, output: 20 });
  assert.equal(session.cache.hit, 320);
  assert.equal(session.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(session), /fixture-key/);
  assert.doesNotMatch(await readFile(join(options.dataDir, `${id}.json`), 'utf8'), /fixture-key/);
});
