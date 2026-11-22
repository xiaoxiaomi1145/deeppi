import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCurrent, parseBrowserCommand, sessionKey, setDraftText, workspaceSelection } from './model.ts';

test('the workspace being browsed does not change the active session', () => {
  const workspaces = [{ cwd: '/alpha' }, { cwd: '/beta' }];
  assert.equal(workspaceSelection(workspaces, '/beta', '/alpha'), '/beta');
  assert.equal(workspaceSelection(workspaces, '/missing', '/alpha'), '/alpha');
  assert.equal(workspaceSelection([], '/missing', '/alpha'), '');
  assert.equal(isCurrent({ cwd: '/beta', id: 'same' }, { cwd: '/alpha', id: 'same' }), false);
  assert.notEqual(sessionKey('/alpha', 'same'), sessionKey('/beta', 'same'));
});

test('drafts stay with their native workspace/session across reconnect and browsing', () => {
  const alpha = sessionKey('/alpha', 'a');
  const beta = sessionKey('/beta', 'b');
  const initial = setDraftText(new Map(), alpha, 'still unsent');
  const other = setDraftText(initial, beta, 'write in beta');
  assert.equal(initial.has(beta), false);
  assert.equal(setDraftText(other, beta, '').get(alpha), 'still unsent');
  let drafts = other;
  for (let i = 0; i < 60; i++) drafts = setDraftText(drafts, sessionKey('/alpha', String(i)), 'test');
  assert.equal(drafts.size, 24);
});

test('slash dispatch recognizes only explicit local controls and leaves native prompts alone', () => {
  assert.deepEqual(parseBrowserCommand(' /new  Test title '), { name: 'new', args: 'Test title' });
  assert.deepEqual(parseBrowserCommand('/context'), { name: 'context', args: '' });
  assert.equal(parseBrowserCommand('/skill:fixture apply'), null);
  assert.equal(parseBrowserCommand('/unknown action'), null);
  assert.equal(parseBrowserCommand('path /new'), null);
});
