import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { defaultQqSettings, updateQqSettings, publicQqSettings } from '../server/qq/settings.mjs';
import { normalizeQqEvent } from '../server/qq/event.mjs';
import { createQqEngine } from '../server/qq/engine.mjs';

const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', contextWindow: 65_536,
  maxTokens: 4096, reasoning: true, input: ['text'] };
const botId = '100001';
const user1 = '200001';
const user2 = '200002';
const group = '333333';
const text = value => ({ type: 'text', data: { text: value } });
const at = qq => ({ type: 'at', data: { qq } });
const image = { type: 'image', data: { url: 'https://gchat.qpic.cn/asset?server-secret=ignored', file: '123.jpg' } };
const makeEvent = (id, user = user1, message = [text('你好')], groupId) => ({ post_type: 'message', self_id: Number(botId), user_id: Number(user),
  message_type: groupId ? 'group' : 'private', group_id: groupId && Number(groupId), message_id: id, message });
const base = () => updateQqSettings(defaultQqSettings(), { enabled: true, botId, wsToken: 'local-fixture-token', cooldownMs: 0 });
const contentText = message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('');
const call = (name, args = {}, id = 'call-1') => ({ type: 'toolCall', id, name, arguments: args });
const assistantText = text => [{ type: 'text', text }];

async function temp(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'deeppi-qq-engine-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}
function fixture(answer) {
  const requests = [];
  return {
    requests,
    resolve: () => ({ model, thinking: 'low', stream(selected, context, options) {
      const messages = normalizeContext(context).messages;
      const request = { messages, options, model: selected, tools: getCurrentTools(messages).map(tool => tool.name) };
      requests.push(request);
      const output = answer(request, requests.length - 1);
      options.onProviderStreamEvent?.({ usage: { prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 12 } }, selected);
      const response = { role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
        stopReason: output.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop', content: output,
        usage: { input: 12, cacheRead: 8, cacheWrite: 0, output: 4, totalTokens: 24, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: response.stopReason, message: response });
      return stream;
    } }),
  };
}
function capture() {
  const calls = [];
  return { calls, send: async (action, params) => { calls.push({ action, params }); return { message_id: calls.length }; } };
}

test('disabled defaults, endpoint validation, credentials and private settings are fail-closed', () => {
  assert.equal(defaultQqSettings().enabled, false);
  assert.equal(defaultQqSettings().groupEnabled, false);
  assert.throws(() => updateQqSettings(defaultQqSettings(), { enabled: true, botId }), { status: 400 });
  assert.throws(() => updateQqSettings(base(), { httpApiUrl: 'https://bot:secret@invalid.example/' }), { status: 400 });
  assert.throws(() => updateQqSettings(base(), { extraTools: ['bash'] }), { status: 400 });
  assert.throws(() => updateQqSettings(base(), { port: 70000 }), { status: 400 });
  assert.throws(() => updateQqSettings(base(), { httpApiUrl: 'http://198.51.100.7:3000' }), { status: 400 });
  assert.throws(() => updateQqSettings(base(), { transport: 'http', httpApiUrl: 'http://127.0.0.1:3000' }), { status: 400 });
  const view = publicQqSettings(base());
  assert.equal(view.hasWsToken, true);
  assert(!JSON.stringify(view).includes('local-fixture-token'));
  assert(!Object.hasOwn(view, 'wsToken'));
});

test('deny wins, group trigger is exact, routing ignores self, notices and unknown bots', () => {
  const settings = updateQqSettings(base(), { groupEnabled: true, groupMode: 'allowlist', groupAllow: [group],
    userMode: 'allowlist', userAllow: [user1, user2], userDeny: [user2], toolUsers: [user1], groupContext: 'per-user' });
  assert.equal(normalizeQqEvent(makeEvent(1, user1, [at('all'), text('hi')], group), settings), null);
  assert.equal(normalizeQqEvent(makeEvent(2, user2, [at(botId), text('hi')], group), settings), null);
  assert.equal(normalizeQqEvent(makeEvent(3, user1, [at(botId), text('hi')], '444444'), settings), null);
  assert.equal(normalizeQqEvent(makeEvent(4, botId), settings), null);
  assert.equal(normalizeQqEvent({ ...makeEvent(5), post_type: 'notice' }, settings), null);
  assert.equal(normalizeQqEvent({ ...makeEvent(6), self_id: 87654321 }, settings), null);
  const match = normalizeQqEvent(makeEvent(7, user1, `[CQ:at,qq=${botId}] hello &#91;hi&#93;`, group), settings);
  assert.equal(match.scope, `${botId}:g:${group}:u:${user1}`);
  assert.equal(match.text, 'hello [hi]');
  const prefix = updateQqSettings(settings, { groupTrigger: 'prefix', prefix: '/ai' });
  assert.equal(normalizeQqEvent(makeEvent(8, user1, [text('/air hi')], group), prefix), null);
  assert.equal(normalizeQqEvent(makeEvent(9, user1, [text('/ai hi')], group), prefix).text, 'hi');
});

test('real Pi executes only current-sender tools and reuses a stable cache lane and plain-text prefix', async t => {
  const engine = createQqEngine({ dataDir: await temp(t) });
  const settings = updateQqSettings(base(), { groupEnabled: true, groupAllow: [group], toolUsers: [user1], extraTools: ['text_count'], compact: false });
  const route = fixture((request, index) => index === 0 || index === 2 ? [call('text_count', { text: '测试' })] : assistantText(index === 1 ? '已统计' : '[CQ:at,qq=all] 普通回复'));
  const { calls, send } = capture();
  for (const [id, user, value] of [[1, user1, '权限用户'], [2, user2, '普通用户'], [3, user1, '回到原权限用户']]) {
    await engine.accept(makeEvent(id, user, [at(botId), text(value)], group), send, settings, route.resolve);
  }
  assert.deepEqual(route.requests[0].tools, ['text_count']);
  assert.equal(route.requests[1].messages.at(-1).isError, false);
  assert.match(contentText(route.requests[1].messages.at(-1)), /2/);
  assert.deepEqual(route.requests[2].tools, []);
  assert.equal(route.requests[3].messages.at(-1).isError, true);
  assert.equal(route.requests[0].options.sessionId, route.requests.at(-1).options.sessionId);
  assert.notEqual(route.requests[0].options.sessionId, route.requests[2].options.sessionId);
  assert.equal(contentText(route.requests[0].messages[0]), contentText(route.requests.at(-1).messages[0]));
  assert.equal(contentText(route.requests[0].messages[1]), contentText(route.requests.at(-1).messages[1]));
  assert.deepEqual(calls[1], { action: 'send_group_msg', params: { group_id: group, message: [text('[CQ:at,qq=all] 普通回复')] } });
  assert.equal(engine.snapshot().conversations.length, 1);
  assert.equal(engine.snapshot().usage.hit, 8 * route.requests.length);
});

test('sticker tools bind to original event image and current destination without leaking source URLs', async t => {
  const events = [];
  const stickerStore = {
    save: async (scope, inbound, note) => { events.push({ scope, inbound, note }); return { id: 1, note, bytes: 14 }; },
    list: async () => [{ id: 1, note: '挥手', bytes: 14 }],
    read: async (scope, id) => { events.push({ scope, id }); return { segment: { type: 'image', data: { file: 'base64://fixture' } } }; },
  };
  const engine = createQqEngine({ dataDir: await temp(t), stickerStore });
  const settings = updateQqSettings(base(), { stickers: true });
  const route = fixture((_req, index) => index === 0 ? [call('qq_save_sticker', { image: 1, note: '挥手' })]
    : index === 1 ? [call('qq_send_sticker', { id: 1 }, 'call-2')] : assistantText(''));
  const { calls, send } = capture();
  await engine.accept(makeEvent(4, user2, [text('请保存再发回给我'), image]), send, settings, route.resolve);
  assert.deepEqual(events, [{ scope: `${botId}:p:${user2}`, inbound: image.data, note: '挥手' }, { scope: `${botId}:p:${user2}`, id: 1 }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { action: 'send_private_msg', params: { user_id: user2,
    message: [{ type: 'image', data: { file: 'base64://fixture' } }] } });
  assert(!JSON.stringify(route.requests.map(request => request.messages)).includes('server-secret'));
  assert(!JSON.stringify(route.requests.map(request => request.messages)).includes('base64://fixture'));
});

test('automatic folding keeps recent rounds and independent replies; event IDs survive restart', async t => {
  const dataDir = await temp(t);
  let engine = createQqEngine({ dataDir });
  const settings = updateQqSettings(base(), { contextLimit: 4096, compactThreshold: 1150, keepRecentTokens: 420, maxOutputTokens: 700 });
  const { calls, send } = capture();
  const route = fixture(request => request.options.cacheRetention === 'none' ? assistantText('历史摘要已生成。') : assistantText('回答'));
  const past = `旧轮次 ${'甲'.repeat(750)}`;
  await engine.accept(makeEvent(20, user1, [text(past)]), send, settings, route.resolve);
  await engine.accept(makeEvent(21, user1, [text(`新轮次 ${'乙'.repeat(450)}`)]), send, settings, route.resolve);
  assert.equal(engine.snapshot().conversations[0].compactions, 1);
  assert(engine.snapshot().usage.compactionInput > 0);
  assert(!route.requests.at(-1).messages.some(message => contentText(message).includes('甲'.repeat(50))));
  assert(route.requests.at(-1).messages.some(message => contentText(message).includes('历史摘要已生成。')));
  engine = createQqEngine({ dataDir });
  await engine.accept(makeEvent(21, user1, [text('duplicate')]), send, settings, route.resolve);
  assert.equal(calls.length, 2);
  await engine.accept(makeEvent(22, user2, [text('另一个用户')]), send, settings, route.resolve);
  assert(!JSON.stringify(route.requests.at(-1).messages).includes('历史摘要已生成。'));
  const original = engine.snapshot().conversations.find(item => item.label.includes(user1));
  engine.reset(original.id);
  assert.equal(engine.snapshot().conversations.length, 1);
});
