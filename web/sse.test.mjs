import assert from 'node:assert/strict';
import test from 'node:test';
import { readEvents } from './sse.ts';

test('bearer SSE parsing preserves UTF-8, event boundaries, and heartbeat handling', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\n\nevent: state\ndata: {"title":"你好"}\n\nevent: delta\ndata: {"text":"世界"}\n\nevent: deleted\ndata: {}\n\n');
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const events = [];
  await readEvents(body, (event, data) => events.push([event, data]));
  assert.deepEqual(events, [['state', { title: '你好' }], ['delta', { text: '世界' }], ['deleted', {}]]);
});
