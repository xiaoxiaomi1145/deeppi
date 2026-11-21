import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultQqSettings, publicQqSettings } from '../../server/qq/settings.mjs';
import { draftOf, qqPatch } from './qq-model.ts';

const saved = publicQqSettings({ ...defaultQqSettings(), listen: true, wsToken: 'fixture-token', userAllow: ['200', '100'] });

test('editing QQ settings never re-sends saved secrets or changes receiver switches', () => {
  const draft = draftOf(saved);
  assert.equal('wsToken' in draft, false);
  assert.deepEqual(qqPatch(saved, draft, {}), {});
  assert.deepEqual(qqPatch(saved, { ...draft, contextLimit: '8192', userAllow: '100、200\n200' }, { httpToken: '' }),
    { contextLimit: 8192, httpToken: '' });
});

test('QQ IDs remain exact strings and invalid text cannot accidentally remove ACL entries', () => {
  const draft = draftOf(saved);
  assert.deepEqual(qqPatch(saved, { ...draft, toolUsers: '10000000000000000001，123;456' }, {}),
    { toolUsers: ['10000000000000000001', '123', '456'] });
  assert.throws(() => qqPatch(saved, { ...draft, userAllow: '100 @wrong' }, {}), /数字账号/u);
  assert.throws(() => qqPatch(saved, { ...draft, compactThreshold: '' }, {}), /整数/u);
});
