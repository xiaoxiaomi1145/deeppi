export async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void, onActivity?: () => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength) onActivity?.();
      pending += decoder.decode(value, { stream: true });
      // The local server emits LF-delimited frames, with JSON on a single data line.
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = frame.split('\n');
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const text = lines.find(line => line.startsWith('data:'))?.slice(5);
        if (event && text) onEvent(event, JSON.parse(text));
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
