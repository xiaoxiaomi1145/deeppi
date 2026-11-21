import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { staleStream, shouldWakeStream, retryAfter } from './stream-health.ts';

test('handshake times out despite bytes but established streams track heartbeats', () => {
  const opening = { startedAt: 100, lastActivity: 12_000, ready: false };
  assert.equal(staleStream(opening, 15_099), false);
  assert.equal(staleStream(opening, 15_100), true);
  assert.equal(staleStream({ ...opening, ready: true }, 49_999), false);
  assert.equal(staleStream({ ...opening, ready: true }, 57_000), true);
});

test('visibility resumes stale or missing streams, online resumes established streams, permanent closures never wake', () => {
  const healthy = { startedAt: 0, lastActivity: 50_000, ready: true };
  assert.equal(shouldWakeStream('visible', healthy, 50_001, true, false), false);
  assert.equal(shouldWakeStream('visible', healthy, 95_000, true, false), true);
  assert.equal(shouldWakeStream('online', healthy, 50_001, true, false), true);
  assert.equal(shouldWakeStream('online', { ...healthy, ready: false }, 1, true, false), false);
  assert.equal(shouldWakeStream('visible', undefined, 1, true, false), true);
  assert.equal(shouldWakeStream('visible', undefined, 1, false, false), false);
  assert.equal(shouldWakeStream('visible', undefined, 1, true, true), false);
});

test('retry uses bounded backoff', () => {
  assert.deepEqual([450, 900, 1800, 3600, 5000].map(retryAfter), [900, 1800, 3600, 5000, 5000]);
});
