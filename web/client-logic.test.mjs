import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDelta, applySessionUpdate, cacheHitRate, composerShortcut, settingsPatch } from './client-logic.ts';

const session = {
  id: 's1',
  status: 'running',
  messages: [
    { id: 'u1', role: 'user', text: '你好', timestamp: 1 },
    { id: 'a1', role: 'assistant', text: '你', thinking: '正在', timestamp: 2 },
  ],
};

test('stream deltas append text and thinking to the named assistant only', () => {
  const result = appendDelta(session, { messageId: 'a1', text: '好', thinking: '思考' });
  assert.equal(result.messages[1].text, '你好');
  assert.equal(result.messages[1].thinking, '正在思考');
  assert.equal(result.messages[0], session.messages[0]);
  assert.equal(session.messages[1].text, '你');
  assert.equal(appendDelta(session, { messageId: 'u1', text: '不应修改' }), session);
});

test('an early delta with no assistant draft can be displayed until the next snapshot', () => {
  const result = appendDelta(session, { messageId: 'a2', thinking: '思考' }, 123);
  assert.deepEqual(result.messages.at(-1), {
    id: 'a2', role: 'assistant', state: 'running', text: '', thinking: '思考', timestamp: 123,
  });
  const idle = { ...session, status: 'idle' };
  assert.equal(appendDelta(idle, { messageId: 'a2', text: '过期分片' }), idle);
});

test('a live suffix keeps old messages and replaces provisional assistant text', () => {
  const complete = { ...session.messages[1], text: '你好', state: 'done' };
  const next = applySessionUpdate(session, { id: 's1', status: 'idle', messagesFrom: 1, messages: [complete] });
  assert.equal(next.messages[0], session.messages[0]);
  assert.equal(next.messages[1], complete);
  assert.ok(!('messagesFrom' in next));
  assert.equal(applySessionUpdate(next, { ...next, messagesFrom: 2, messages: [] }).messages, next.messages);
  assert.equal(applySessionUpdate(next, { ...next, messagesFrom: 3, messages: [] }), next);
});

test('key patch distinguishes preserving, clearing, and replacing the override', () => {
  const original = { model: 'old', contextWindow: 64000 };
  const edited = { ...original, model: 'new' };
  assert.deepEqual(settingsPatch(original, edited, '    ', false), { settings: { model: 'new' } });
  assert.deepEqual(settingsPatch(original, original, '', true), { settings: {}, apiKey: null });
  assert.deepEqual(settingsPatch(original, original, ' new-key ', false), { settings: {}, apiKey: 'new-key' });
});

test('keyboard shortcuts leave Chinese composition and multiline editing alone', () => {
  assert.equal(composerShortcut({ key: 'Enter', isComposing: true }), undefined);
  assert.equal(composerShortcut({ key: 'Enter', keyCode: 229 }), undefined);
  assert.equal(composerShortcut({ key: 'Escape', isComposing: true }), undefined);
  assert.equal(composerShortcut({ key: 'Enter', shiftKey: true }), undefined);
  assert.equal(composerShortcut({ key: 'Enter' }), 'send');
  assert.equal(composerShortcut({ key: 'Escape' }), 'cancel');
});

test('cache hit rate uses reported hits and misses only', () => {
  assert.equal(cacheHitRate({ hit: 12, miss: 4, unreported: 100 }), 0.75);
  assert.equal(cacheHitRate({ hit: 0, miss: 0, unreported: 100 }), undefined);
  assert.equal(cacheHitRate({ hit: 0, miss: 8 }), 0);
});
