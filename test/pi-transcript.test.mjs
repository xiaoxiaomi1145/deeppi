import assert from 'node:assert/strict';
import test from 'node:test';
import { projectBranch } from '../server/pi/transcript.mjs';

const txt = text => ({ type: 'text', text });
const entry = (id, message) => ({ type: 'message', id, message: { timestamp: 1, ...message } });

test('native Pi branch produces ordered views and joins a tool result to its invocation', () => {
  const branch = [
    entry('u', { role: 'user', content: [txt('look'), { type: 'image', data: 'private-base64' }] }),
    entry('a', { role: 'assistant', content: [{ type: 'thinking', thinking: 'reason' }, txt('reading'),
      { type: 'toolCall', id: '123', name: 'read', arguments: { path: 'foo' } }] }),
    entry('tr', { role: 'toolResult', toolCallId: '123', toolName: 'read', content: [txt('result')] }),
    { type: 'custom', customType: 'deeppi-settings', data: { neverProject: 'internal' } },
    { type: 'custom_message', id: 'c', display: false, content: 'should never render' },
    entry('err', { role: 'assistant', stopReason: 'error', errorMessage: 'secret', content: [] }),
  ];
  const out = projectBranch(branch);
  assert.deepEqual(out.map(({ id, role, state }) => [id, role, state]), [
    ['u','user',undefined], ['a','assistant','done'], ['tool:123','tool','done'], ['err','assistant','error'],
  ]);
  assert.equal(out[1].thinking, 'reason');
  assert.deepEqual(out[2].args, { path: 'foo' });
  assert.match(out[0].text, /图片/u);
  assert.doesNotMatch(JSON.stringify(out), /private-base64|internal|never render|secret/u);
});

test('history tool previews are bounded, and structured credential-like fields are not displayed', () => {
  const out = projectBranch([
    entry('a', { role: 'assistant', content: [{ type: 'toolCall', id: 'b', name: 'x', arguments: { authorization: 'secret-value', nested: { token: 'private' } } }] }),
    entry('tr', { role: 'toolResult', toolCallId: 'b', toolName: 'x', isError: true, content: [txt('a'.repeat(100_000))] }),
  ]);
  assert.equal(out[1].state, 'error');
  assert.ok(out[1].text.length < 33_000);
  assert.doesNotMatch(JSON.stringify(out), /secret-value|private/u);
});
