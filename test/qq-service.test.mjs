import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createQqService } from '../server/qq/service.mjs';

const token = 'qq-service-test-token';
const botId = '100001';
const credentials = { transport: 'ws', botId, wsToken: token, port: 0 };
const userId = '200001';
const raw = { post_type: 'message', message_type: 'private', self_id: botId, user_id: userId,
  message_id: '123', message: [{ type: 'text', data: { text: '你好' } }] };
const ok = data => ({ status: 'ok', retcode: 0, data });
const model = { provider: 'fixture', id: 'qq-chat', api: 'openai-completions', baseUrl: 'http://localhost', contextWindow: 16_384, maxTokens: 1024, reasoning: false };

function fakeRoute(observed) {
  return { model, thinking: 'off', stream(current, context) {
    observed.push(context);
    const reply = { role: 'assistant', api: current.api, provider: current.provider, model: current.id, timestamp: Date.now(),
      content: [{ type: 'text', text: '原生 Pi 回复' }], stopReason: 'stop', usage: { input: 5, output: 3, cacheRead: 10, cacheWrite: 0, totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'start', partial: reply });
    stream.push({ type: 'done', reason: 'stop', message: reply });
    stream.end(reply);
    return stream;
  } };
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'deeppi-qq-service-'));
  const service = createQqService({ dataDir });
  t.after(async () => { await service.detach(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir };
}

function oneBot(url) {
  const socket = new WebSocket(url, { headers: { 'X-Self-ID': botId, 'X-Client-Role': 'Universal', Authorization: `Bearer ${token}` } });
  socket.on('message', data => {
    const { action, params, echo } = JSON.parse(data);
    socket.send(JSON.stringify({ ...ok(action === 'get_login_info' ? { user_id: botId } : { message_id: 1234 }), echo }));
    socket.emit('action', { action, params });
  });
  return socket;
}

async function until(check) {
  for (let i = 0; i < 120; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('QQ integration did not reach the expected state');
}

test('listening and connected are independent of the explicit reply switch', async t => {
  const { service, dataDir } = await fixture(t);
  const observed = [];
  await service.attach(() => fakeRoute(observed));
  assert.equal(service.snapshot().settings.enabled, false);
  assert.equal(service.snapshot().status.listening, false);
  await assert.rejects(service.update({ ...credentials, enabled: true }), { status: 409 });
  await service.update({ ...credentials, listen: true });
  await assert.rejects(service.update({ enabled: true }), { status: 409 });
  const socket = oneBot(service.snapshot().status.wsUrl);
  await once(socket, 'open');
  socket.send(JSON.stringify(raw));
  await until(() => Boolean(service.snapshot().status.lastEventAt));
  assert.equal(observed.length, 0);
  assert.deepEqual(await service.probe(), { botId });
  await service.update({ enabled: true });
  const [reply] = await Promise.all([once(socket, 'action'), new Promise((resolve, reject) => socket.send(JSON.stringify(raw), error => error ? reject(error) : resolve()))]);
  assert.deepEqual(reply[0], { action: 'send_private_msg', params: { user_id: userId, message: [{ type: 'text', data: { text: '原生 Pi 回复' } }] } });
  await until(() => !service.snapshot().pending);
  const snapshot = service.snapshot();
  assert.equal(snapshot.usage.hit, 10);
  assert.equal(snapshot.conversations[0].messages, 2);
  assert(!JSON.stringify(snapshot).includes(token));
  assert.equal((await stat(join(dataDir, 'settings.json'))).mode & 0o777, 0o600);
  await service.update({ listen: false });
  assert.equal(service.snapshot().settings.enabled, false);
  assert.equal(service.snapshot().status.listening, false);
});

test('native session handoff preserves the listener, and quitting closes it', async t => {
  const { service } = await fixture(t);
  const first = () => fakeRoute([]), second = () => fakeRoute([]);
  await service.attach(first);
  await service.update({ ...credentials, listen: true });
  const url = service.snapshot().status.wsUrl;
  await service.detach(first, 'resume');
  assert.equal(service.snapshot().status.wsUrl, url);
  await service.attach(second);
  assert.equal(service.snapshot().status.wsUrl, url);
  await service.detach(first, 'quit');
  assert.equal(service.snapshot().status.listening, true);
  await service.detach(second, 'quit');
  assert.equal(service.snapshot().status.listening, false);
});

test('inaccessible/corrupt configuration stops QQ without overwriting it', async t => {
  const { service, dataDir } = await fixture(t);
  const file = join(dataDir, 'settings.json');
  await writeFile(file, '{invalid config', { mode: 0o600 });
  await service.attach(() => fakeRoute([]));
  assert.match(service.snapshot().status.lastError, /配置/u);
  await assert.rejects(service.update({ listen: true }), { status: 500 });
  assert.equal((await stat(file)).size, '{invalid config'.length);
});
