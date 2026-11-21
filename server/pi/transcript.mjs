const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const cap = (text, n = 32_000) => text.length > n ? `${text.slice(0, n)}\n…（仅截断 Web 预览）` : text;

export function textContent(content, type = 'text') {
  if (typeof content === 'string') return type === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => {
    if (block?.type === type && typeof block[type] === 'string') return [block[type]];
    return type === 'text' && block?.type === 'image' ? ['[图片 · 在 Pi 中查看]'] : [];
  }).join('\n');
}

function safeValue(value, depth = 0) {
  if (typeof value === 'string') return cap(value, 3_000);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 4) return '[省略]';
  if (Array.isArray(value)) return value.slice(0, 24).map(item => safeValue(item, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key,
    /(?:api[-_]?key|secret|token|password|authorization|cookie)/iu.test(key) ? '[已隐藏]' : safeValue(item, depth + 1),
  ]));
  return undefined;
}

export const toolViewId = callId => `tool:${callId}`;
export function toolView({ id, name, args, timestamp, content, state }) {
  return { id: toolViewId(id), role: 'tool', name, args: isRecord(args) ? safeValue(args) : undefined,
    text: cap(textContent(content)), state, timestamp };
}

export function assistantView(message, id, running = false) {
  return { id, role: 'assistant', text: textContent(message.content), thinking: textContent(message.content, 'thinking'),
    state: running ? 'running' : message.stopReason === 'error' || message.stopReason === 'aborted' ? 'error' : 'done',
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now() };
}

export function projectBranch(entries) {
  const messages = [];
  const calls = new Map();
  for (const entry of entries) {
    const message = entry.type === 'message' ? entry.message : entry.type === 'custom_message' ? entry : undefined;
    if (!message) continue;
    const date = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
    const timestamp = Number.isFinite(date) ? date : 0;
    if (message.role === 'assistant') {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === 'toolCall' && typeof part.id === 'string') calls.set(part.id, part.arguments);
      }
      messages.push(assistantView({ ...message, timestamp }, entry.id));
    } else if (message.role === 'user') {
      messages.push({ id: entry.id, role: 'user', text: textContent(message.content), timestamp });
    } else if (message.role === 'toolResult') {
      messages.push(toolView({ id: message.toolCallId ?? entry.id, name: message.toolName,
        args: calls.get(message.toolCallId), timestamp, content: message.content, state: message.isError ? 'error' : 'done' }));
      calls.delete(message.toolCallId);
    } else if (message.role === 'bashExecution') {
      messages.push(toolView({ id: entry.id, name: 'bash', args: { command: message.command }, timestamp,
        content: message.output, state: message.cancelled || (message.exitCode != null && message.exitCode !== 0) ? 'error' : 'done' }));
    } else if ((entry.type === 'custom_message' || message.role === 'custom') && message.display === true) {
      messages.push({ id: entry.id, role: 'assistant', text: cap(textContent(message.content)), timestamp });
    }
  }
  return messages;
}
