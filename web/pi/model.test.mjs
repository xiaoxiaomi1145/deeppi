import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPiDeltas, compactPayload, promptPayload, settingsPatch, thinkingFor, visibleHistory } from './model.ts';

test('model changes only expose real thinking levels, including sparse levels', () => {
  assert.equal(thinkingFor(['off', 'low', 'high', 'max'], 'xhigh'), 'high');
  assert.equal(thinkingFor(['off'], 'max'), 'off');
  assert.equal(thinkingFor(['inherit', 'off', 'adaptive'], 'inherit'), 'inherit');
  assert.equal(thinkingFor(['off', 'high'], 'high'), 'high');
});

const user = { id: 'u', role: 'user', text: '开始', timestamp: 1 };
const state = { id: 'now', status: 'running', messages: [user] };

test('a batch preserves earlier messages, combines assistant chunks, and ignores stale or mismatched deltas', () => {
  const next = applyPiDeltas(state, [
    { messageId: 'u', text: 'ignore' }, { messageId: 'a', thinking: '想' },
    { messageId: 'a', thinking: '一想', text: '结' }, { messageId: 'a', text: '果' },
  ], 10);
  assert.equal(next.messages[0], user);
  assert.deepEqual(next.messages[1], { id: 'a', role: 'assistant', state: 'running', timestamp: 10, text: '结果', thinking: '想一想' });
  const idle = { ...next, status: 'idle' };
  assert.equal(applyPiDeltas(idle, [{ messageId: 'a', text: '迟到' }]), idle);
  const finalized = { ...next, messages: [...state.messages, { ...next.messages[1], state: 'done' }] };
  assert.equal(applyPiDeltas(finalized, [{ messageId: 'a', text: '迟到' }]), finalized);
});

test('send uses an explicit delivery mode only during streaming, preserving the optional skill', () => {
  assert.deepEqual(promptPayload('  继续\n  ', 'running', 'steer', 'notes'), { text: '继续', mode: 'steer', skill: 'notes' });
  assert.deepEqual(promptPayload('下一轮', 'running', 'followUp', ''), { text: '下一轮', mode: 'followUp' });
  assert.deepEqual(promptPayload('  普通消息 ', 'idle', 'followUp', ''), { text: '普通消息' });
  assert.equal(promptPayload('停止时不发送', 'stopping', 'steer', ''), null);
  assert.equal(promptPayload('压缩时不发送', 'compacting', 'steer', ''), null);
  assert.equal(promptPayload('  ', 'idle', 'steer', ''), null);
});

test('busy primary send queues, accelerated send steers, and native slash controls do not need a model', async () => {
  const { composerControl, inputToken, insertInputToken, inputSuggestions } = await import('./input-model.ts');
  assert.deepEqual(composerControl('running', true, false), { primary: 'send', label: '排队发送', alternate: true });
  assert.deepEqual(composerControl('running', false, false), { primary: 'stop', label: '停止当前操作', alternate: false });
  assert.deepEqual(composerControl('running', true, true), { primary: 'send', label: '执行指令', alternate: false });
  const commands = [{ name: 'model', kind: 'native' }, { name: 'login', kind: 'terminal' }, { name: 'skill:notes', kind: 'skill' }];
  assert.deepEqual(inputSuggestions(inputToken('/mo', 3), [], commands).map(x => x.name), ['model']);
  assert.equal(inputToken('/tmp/something', 14), null);
  assert.equal(inputToken('mail@example.org', 16), null);
  const draft = 'read @skills:no next';
  const token = inputToken(draft, 15);
  assert.deepEqual(inputSuggestions(token, [{ name: 'notes', description: 'Read notes' }], commands).map(x => x.name), ['notes']);
  assert.deepEqual(insertInputToken(draft, token, '@skills:notes'), { text: 'read @skills:notes next', caret: 19 });
});

test('settings patches do not overwrite unchanged terminal settings or depend on tool order', () => {
  const original = { title: '当前', systemPrompt: '旧', thinking: 'low', model: { provider: 'p', id: 'm' }, activeTools: ['a', 'b'] };
  assert.deepEqual(settingsPatch(original, { ...original, title: ' 新名称 ', activeTools: ['b', 'a'] }), { title: '新名称' });
  assert.deepEqual(settingsPatch(original, { ...original, systemPrompt: '', activeTools: [], model: { provider: 'other', id: 'm' } }), {
    systemPrompt: '', activeTools: [], model: { provider: 'other', id: 'm' },
  });
});

test('historical browsing never replaces Pi selection; the live switch clears its matching preview', () => {
  const preview = { id: 'archive' };
  assert.equal(visibleHistory(preview, 'now'), preview);
  assert.equal(visibleHistory(preview, 'archive'), null);
  assert.equal(visibleHistory(null, 'now'), null);
});

test('only an explicit enabled enhanced compression request includes the flag', () => {
  assert.deepEqual(compactPayload('  保留限制  ', true, false), { focus: '保留限制' });
  assert.deepEqual(compactPayload(' ', false, true), {});
  assert.deepEqual(compactPayload(' ', true, true), { enhanced: true });
});
