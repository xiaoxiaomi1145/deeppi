import assert from 'node:assert/strict';
import test from 'node:test';

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { registerSessionResourceCleanup } from '@earendil-works/pi-ai/session-resources';
import { createDelegation } from '../server/delegation.mjs';

const model = {
  id: 'mock-model', name: 'Mock model', provider: 'mock', api: 'openai-completions',
  baseUrl: 'http://mock.local', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
};

const settings = {
  model: model.id, subagentModel: '', thinkingLevel: 'off', maxTurns: 4,
  maxSubagents: 2, allowBash: false,
};

const inherited = [
  { role: 'system', content: [{ type: 'text', text: 'inherited system prefix' }], timestamp: 0 },
  { role: 'user', content: [{ type: 'text', text: 'earlier request' }], timestamp: 1 },
];

function response(message) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end();
  });
  return stream;
}

function assistant(text, stopReason = 'stop', content = [{ type: 'text', text }]) {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function fixture(streamForTask, overrides = {}) {
  const calls = [];
  const children = [];
  const controller = new AbortController();
  const route = {
    model,
    stream(_requestModel, context, options) {
      calls.push({ context, sessionId: options.sessionId });
      return streamForTask(context, options);
    },
  };
  const delegation = createDelegation({
    settings: { ...settings, ...overrides }, mainRoute: route, override: undefined,
    sessionId: 'parent-session', systemPrompt: 'child system prompt', signal: controller.signal,
    seed: () => inherited.map(message => ({ ...message, content: message.content.map(block => ({ ...block })) })),
    bashTools: [], onChild: child => children.push({ ...child }),
  });
  return { calls, children, controller, delegation };
}

test('children use independent session IDs and preserve the inherited transcript', async () => {
  const { calls, delegation } = fixture(async context => {
    await new Promise(resolve => setTimeout(resolve, context.messages.at(-1)?.content?.[0]?.text.includes('first') ? 15 : 1));
    return response(assistant('done'));
  });
  const first = delegation.tool.execute('call-1', { name: 'first', task: 'first task' });
  const second = delegation.tool.execute('call-2', { name: 'second', task: 'second task' });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  await delegation.settle();

  assert.equal(firstResult.isError, undefined);
  assert.equal(secondResult.isError, undefined);
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map(call => call.sessionId)).size, 2);
  assert.ok(calls.every(call => call.sessionId.startsWith('parent-session-child-')));
  assert.deepEqual(calls[0].context.messages.slice(0, 2), inherited);
  assert.equal(calls[0].context.messages[0].content[0].text, 'inherited system prefix');
});

test('a length-truncated child result is rejected and its session resources are cleaned up', async t => {
  const cleaned = [];
  const unregister = registerSessionResourceCleanup(sessionId => cleaned.push(sessionId));
  t.after(unregister);
  const { delegation } = fixture(() => response(assistant('partial answer', 'length')));

  const result = await delegation.tool.execute('call-length', { name: 'length', task: 'length task' });
  await delegation.settle();

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /输出达到 token 上限/u);
  assert.equal(cleaned.length, 1);
  assert.match(cleaned[0], /^parent-session-child-[0-9a-f-]+$/u);
});

test('a child stopped at the tool-round limit reports an actionable error', async () => {
  const toolCall = { type: 'toolCall', id: 'unknown-tool-call', name: 'missing_tool', arguments: {} };
  const { delegation } = fixture(() => response(assistant('progress before limit', 'toolUse', [
    { type: 'text', text: 'progress before limit' }, toolCall,
  ])), { maxTurns: 1 });

  const result = await delegation.tool.execute('call-limit', { name: 'limit', task: 'limit task' });
  await delegation.settle();

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /工具调用轮次上限/u);
});
