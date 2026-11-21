import assert from 'node:assert/strict';
import test from 'node:test';
import { addUsage, emptyCache, planCompaction, projectContext, readCacheEvidence } from '../server/context.mjs';

const message = (role, text) => ({ role, timestamp: 123, content: [{ type: 'text', text }] });

test('compaction advances only to a user boundary and leaves complete tool exchanges intact', () => {
  const first = [message('user', 'old request'), message('assistant', 'old answer'.repeat(120))];
  const second = [message('user', 'recent question'), {
    ...message('assistant', 'Inspecting.'), content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'pwd' } }],
  }, { ...message('toolResult', '/workspace'), toolCallId: 'c1' }];
  const all = [...first, ...second];
  const plan = planCompaction(all, { keepRecentTokens: 35 });
  assert.equal(plan.coveredMessages, 2);
  assert.deepEqual(plan.archived, first);
  const system = { role: 'system', content: 'Keep this exact prefix.', timestamp: 123 };
  const context = projectContext([system, ...all], { summary: 'Old request was answered.', coveredMessages: 2, at: 456 });
  assert.strictEqual(context[0], system);
  assert.match(context[1].content[0].text, /Old request was answered\./);
  assert.deepEqual(context.slice(2), second);
  assert.equal(all.length, 5);
  assert.equal(planCompaction(all, { covered: 2, keepRecentTokens: 1, force: true }), null);
});

test('manual compaction can summarize earlier rounds when the recent budget includes all turns', () => {
  const all = [message('user', 'a'), message('assistant', 'b'), message('user', 'c')];
  assert.equal(planCompaction(all, { keepRecentTokens: 4000 }), null);
  assert.equal(planCompaction(all, { keepRecentTokens: 4000, force: true }).coveredMessages, 2);
});

test('moves provider hits, misses, and unavailable cache data into separate totals', () => {
  const cache = emptyCache();
  const evidence = readCacheEvidence({ choices: [], usage: { prompt_tokens: 256, prompt_cache_hit_tokens: 192, prompt_cache_miss_tokens: 64 } });
  addUsage(cache, { input: 64, cacheRead: 192, output: 21 }, evidence, 'main');
  addUsage(cache, { input: 100, output: 5 }, readCacheEvidence({ usage: { prompt_tokens_details: { cached_tokens: 0 } } }), 'child');
  addUsage(cache, { input: 80, output: 7 }, undefined, 'compaction');
  assert.deepEqual(cache.last, { input: 80, hit: 0, miss: 0, unreported: 80, output: 7 });
  assert.equal(cache.requests, 3);
  assert.equal(cache.input, 436);
  assert.equal(cache.hit, 192);
  assert.equal(cache.miss, 164);
  assert.equal(cache.unreported, 80);
  assert.equal(cache.output, 33);
  assert.equal(cache.compactionInput, 80);
});

test('Anthropic cache creation is counted as input on a miss', () => {
  const cache = emptyCache();
  const evidence = readCacheEvidence({ type: 'message_start', message: { usage: { cache_creation_input_tokens: 88, cache_read_input_tokens: 128, input_tokens: 30 } } });
  addUsage(cache, { input: 30, cacheWrite: 88, cacheRead: 128, output: 4 }, evidence, 'main');
  assert.deepEqual(cache.last, { input: 246, hit: 128, miss: 118, unreported: 0, output: 4 });
});
