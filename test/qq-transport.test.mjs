import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { createOneBotTransport } from '../server/qq/transport.mjs';

const botId = '100001';
const token = 'reverse-ws-test-token';
const secret = 'callback-test-secret';
const apiToken = 'outbound-test-token';
const event = { time: 12345, self_id: 100001, post_type: 'message', message_type: 'private',
  message_id: 15, user_id: 200001, message: [{ type: 'text', data: { text: '你好' } }] };
const reply = { user_id: '200001', message: [{ type: 'text', data: { text: '回复' } }] };
const ok = data => ({ status: 'ok', retcode: 0, data });
const response = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};
const wsConfig = (overrides = {}) => ({ transport: 'ws', port: 0, botId, wsToken: token, ...overrides });
const httpConfig = (origin, overrides = {}) => ({ transport: 'http', port: 0, botId, httpSecret: secret,
  httpApiUrl: `${origin}/adapter/`, httpToken: apiToken, ...overrides });

function mailbox() {
  const items = [];
  const listeners = [];
  return {
    items,
    push(item) { const waiting = listeners.shift(); if (waiting) waiting(item); else items.push(item); },
    next() { return items.length ? Promise.resolve(items.shift()) : new Promise(resolve => listeners.push(resolve)); },
  };
}

async function fixture(t, config, onEvent) {
  const received = mailbox();
  const transport = createOneBotTransport({ onEvent: onEvent ?? ((raw, send) => received.push({ raw, send })) });
  t.after(() => transport.stop());
  await transport.start(config);
  return { transport, received, status: transport.snapshot() };
}

function connect(t, url, { role = 'Universal', id = botId, auth = token } = {}) {
  const socket = new WebSocket(url, { headers: { 'X-Self-ID': id, 'X-Client-Role': role, Authorization: `Bearer ${auth}` } });
  const actions = mailbox();
  socket.on('message', frame => actions.push(JSON.parse(frame.toString())));
  t.after(() => { if (socket.readyState === WebSocket.OPEN) socket.terminate(); });
  return { socket, actions, opened: once(socket, 'open') };
}

function rejectedSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => { socket.terminate(); reject(new Error('unauthorized connection upgraded')); });
    socket.once('error', reject);
  });
}

async function oneBotHttp(t, handle) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, method: req.method, authorization: req.headers.authorization,
      params: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    calls.push(call);
    handle(res, call);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, origin: `http://127.0.0.1:${server.address().port}` };
}

const sign = raw => `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`;
function deliver(url, raw, { signature = sign(raw), id = botId } = {}) {
  return fetch(url, { method: 'POST', headers: { 'x-signature': signature, 'x-self-id': id,
    'content-type': 'application/json; charset=utf-8' }, body: raw });
}

const cases = { timeout: 10_000 };

test('Universal reverse WebSocket validates bearer and identity and correlates concurrent actions', cases, async t => {
  const { transport, received, status } = await fixture(t, wsConfig());
  assert.match(status.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/onebot\/v11\/ws$/u);
  assert.equal(status.listening, true);
  assert.equal(status.connected, false);
  const headers = { 'X-Self-ID': botId, 'X-Client-Role': 'Universal' };
  assert.equal(await rejectedSocket(status.wsUrl, headers), 401);
  assert.equal(await rejectedSocket(status.wsUrl, { ...headers, 'X-Self-ID': '100002', Authorization: `Bearer ${token}` }), 403);
  const { socket, actions, opened } = connect(t, status.wsUrl);
  await opened;
  assert.equal(transport.snapshot().connected, true);
  socket.send(JSON.stringify({ ...event, self_id: 100002 }));
  socket.send(JSON.stringify(event));
  const { raw, send } = await received.next();
  assert.deepEqual(raw, event);
  assert(Number.isFinite(transport.snapshot().lastEventAt));
  await assert.rejects(async () => send('delete_msg', {}), { status: 403 });

  const sending = send('send_private_msg', reply);
  const probing = transport.probe();
  const request = await actions.next();
  const probe = await actions.next();
  assert.equal(request.action, 'send_private_msg');
  assert.deepEqual(request.params, reply);
  assert.equal(probe.action, 'get_login_info');
  assert.notEqual(request.echo, probe.echo);
  socket.send(JSON.stringify({ ...ok({ user_id: 100001, nickname: 'bot' }), echo: probe.echo }));
  socket.send(JSON.stringify({ ...ok({ message_id: 9001 }), echo: request.echo }));
  assert.deepEqual(await probing, { botId, nickname: 'bot' });
  assert.deepEqual(await sending, { message_id: 9001 });
  assert.equal(received.items.length, 0);
  assert(!JSON.stringify(transport.snapshot()).includes(token));
});

test('split reverse WebSocket dispatches Event traffic and sends actions only on API socket', cases, async t => {
  const { transport, received, status } = await fixture(t, wsConfig());
  const events = connect(t, status.wsUrl, { role: 'Event' });
  await events.opened;
  assert.equal(transport.snapshot().connected, false);
  const api = connect(t, status.wsUrl, { role: 'API' });
  await api.opened;
  assert.equal(transport.snapshot().connected, true);
  api.socket.send(JSON.stringify({ ...event, message_id: 99 }));
  events.socket.send(JSON.stringify(event));
  const { raw, send } = await received.next();
  assert.equal(raw.message_id, 15);
  const task = send('send_group_msg', { group_id: '300001', message: reply.message });
  const payload = await api.actions.next();
  assert.equal(payload.action, 'send_group_msg');
  events.socket.send(JSON.stringify({ ...ok({ message_id: 99 }), echo: payload.echo }));
  api.socket.send(JSON.stringify({ ...ok({ message_id: 13 }), echo: payload.echo }));
  assert.deepEqual(await task, { message_id: 13 });
  assert.equal(events.actions.items.length, 0);

  const pending = send('send_private_msg', reply);
  const rejected = assert.rejects(pending, { status: 503 });
  await api.actions.next();
  await Promise.all([transport.stop(), transport.stop()]);
  await rejected;
  assert.equal(transport.snapshot().listening, false);
  assert.equal(transport.snapshot().connected, false);
  await assert.rejects(async () => send('send_private_msg', reply), { status: 503 });
});

test('HTTP authenticates exact callback bytes and acknowledges without waiting for the agent', cases, async t => {
  const api = await oneBotHttp(t, (res, { path }) => response(res,
    ok(path.endsWith('/get_login_info') ? { user_id: 100001, nickname: 'bot' } : { message_id: 71 })));
  const received = mailbox();
  let settle;
  const held = new Promise(resolve => { settle = resolve; });
  t.after(settle);
  const { transport, status } = await fixture(t, httpConfig(api.origin), async (raw, send) => {
    received.push({ raw, send });
    await held;
  });
  const raw = `${JSON.stringify(event, null, 2)}\n`;
  assert.match(status.httpUrl, /^http:\/\/127\.0\.0\.1:\d+\/onebot\/v11\/event$/u);
  assert.equal((await deliver(status.httpUrl, raw, { signature: sign(JSON.stringify(event)) })).status, 401);
  assert.equal((await deliver(status.httpUrl, raw, { id: '101010' })).status, 403);
  assert.equal((await deliver(status.httpUrl, '{ invalid')).status, 400);
  assert.equal((await deliver(status.httpUrl, JSON.stringify({ ...event, self_id: 100002 }))).status, 403);
  const accepted = await deliver(status.httpUrl, raw);
  assert.equal(accepted.status, 204);
  assert.equal(await accepted.text(), '');
  const delivered = await received.next();
  assert.deepEqual(delivered.raw, event);
  assert.equal(received.items.length, 0);
  assert.equal(transport.snapshot().connected, true);
  assert(Number.isFinite(transport.snapshot().lastEventAt));
  assert.deepEqual(await delivered.send('send_private_msg', reply), { message_id: 71 });
  assert.deepEqual(await delivered.send('send_private_msg', reply), { message_id: 71 });
  assert.deepEqual(await transport.probe(), { botId, nickname: 'bot' });
  assert.deepEqual(api.calls, [
    { path: '/adapter/get_login_info', method: 'POST', authorization: `Bearer ${apiToken}`, params: {} },
    { path: '/adapter/send_private_msg', method: 'POST', authorization: `Bearer ${apiToken}`, params: reply },
    { path: '/adapter/send_private_msg', method: 'POST', authorization: `Bearer ${apiToken}`, params: reply },
    { path: '/adapter/get_login_info', method: 'POST', authorization: `Bearer ${apiToken}`, params: {} },
  ]);
  const serialized = JSON.stringify(transport.snapshot());
  assert(!serialized.includes(secret) && !serialized.includes(apiToken));
  settle();
});

test('HTTP probe fails closed on redirects, mismatched identity, and excessive callback body', cases, async t => {
  const target = await oneBotHttp(t, res => response(res, ok({ user_id: 100001 })));
  const redirect = await oneBotHttp(t, res => {
    res.writeHead(307, { location: `${target.origin}/capture` });
    res.end();
  });
  const wrong = await oneBotHttp(t, res => response(res, ok({ user_id: 999999, nickname: apiToken })));
  const { transport, received } = await fixture(t, httpConfig(redirect.origin));
  await assert.rejects(transport.probe(), { status: 502 });
  assert.equal(target.calls.length, 0);
  assert.equal(transport.snapshot().connected, false);
  await transport.start(httpConfig(wrong.origin));
  await assert.rejects(transport.probe(), { status: 502 });
  assert.equal(transport.snapshot().connected, false);
  assert(!JSON.stringify(transport.snapshot()).includes(apiToken));
  const oversized = JSON.stringify({ ...event, message: 'x'.repeat(1_048_577) });
  assert.equal((await deliver(transport.snapshot().httpUrl, oversized)).status, 413);
  assert.equal(received.items.length, 0);
});

test('an authenticated HTTP event cannot send through an API logged into another QQ account', cases, async t => {
  let apiUser = 100001;
  const api = await oneBotHttp(t, (res, { path }) => response(res,
    ok(path.endsWith('/get_login_info') ? { user_id: apiUser } : { message_id: 71 })));
  const { transport, received, status } = await fixture(t, httpConfig(api.origin));
  assert.equal((await deliver(status.httpUrl, JSON.stringify(event))).status, 204);
  const { send } = await received.next();

  apiUser = 999999;
  await assert.rejects(send('send_private_msg', reply), { status: 502, message: /机器人 QQ 号不匹配/u });
  assert.deepEqual(api.calls.map(({ path }) => path), ['/adapter/get_login_info']);
  assert.equal(transport.snapshot().connected, false);

  apiUser = 100001;
  assert.deepEqual(await transport.probe(), { botId });
  assert.equal(transport.snapshot().connected, true);
  assert.deepEqual(await send('send_private_msg', reply), { message_id: 71 });
  assert.deepEqual(api.calls.map(({ path }) => path), [
    '/adapter/get_login_info', '/adapter/get_login_info', '/adapter/send_private_msg',
  ]);
});

test('aborting an action removes its echo without breaking the reverse WebSocket', cases, async t => {
  const { transport, received, status } = await fixture(t, wsConfig());
  const peer = connect(t, status.wsUrl);
  await peer.opened;
  peer.socket.send(JSON.stringify(event));
  const { send } = await received.next();
  const controller = new AbortController();
  const initial = send('send_private_msg', reply, { signal: controller.signal });
  const rejected = assert.rejects(initial, { name: 'AbortError' });
  const first = await peer.actions.next();
  controller.abort();
  await rejected;
  peer.socket.send(JSON.stringify({ ...ok({ message_id: 30 }), echo: first.echo }));
  const next = transport.probe();
  const valid = await peer.actions.next();
  peer.socket.send(JSON.stringify({ ...ok({ user_id: 100001 }), echo: valid.echo }));
  assert.deepEqual(await next, { botId });
});
