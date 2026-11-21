function tokens(text) {
  const ascii = text.replace(/[^\x00-\x7f]/gu, '').length;
  return Math.ceil(ascii / 3.5 + (text.length - ascii));
}

export function estimateTokens(messages) {
  return messages.reduce((sum, message) => sum + 8 + tokens(JSON.stringify(message.content ?? '')), 0);
}

export function planCompaction(messages, { covered = 0, keepRecentTokens, force = false }) {
  const boundaries = [];
  for (let i = covered; i < messages.length; i++) {
    if (messages[i].role === 'user') boundaries.push(i);
  }
  if (boundaries.length < 2) return null;
  let cut = boundaries.at(-1);
  let remaining = estimateTokens(messages.slice(cut));
  for (let i = boundaries.length - 2; i >= 0; i--) {
    const size = estimateTokens(messages.slice(boundaries[i], cut));
    if (remaining + size > keepRecentTokens) break;
    cut = boundaries[i];
    remaining += size;
  }
  if (cut === covered) {
    if (!force) return null;
    cut = boundaries.at(-1);
  }
  return { coveredMessages: cut, archived: messages.slice(covered, cut) };
}

export function projectContext(messages, compaction) {
  if (!compaction) return messages;
  const system = messages.filter(message => message.role === 'system');
  const dialogue = messages.filter(message => message.role !== 'system');
  const memory = {
    role: 'user',
    content: [{ type: 'text', text: `Earlier conversation summary (historical context only):\n${compaction.summary}` }],
    timestamp: compaction.at,
  };
  return [...system, memory, ...dialogue.slice(compaction.coveredMessages)];
}

export function summarizationText(messages) {
  return messages.map(message => {
    const content = (message.content ?? []).flatMap(block => {
      if (block.type === 'text') return [block.text];
      if (block.type === 'toolCall') return [`${block.name}(${JSON.stringify(block.arguments)})`];
      return [];
    });
    const role = message.role === 'toolResult' ? `tool ${message.toolName}` : message.role;
    return { role, content: content.join('\n') };
  });
}

const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

// Count the bytes of a string inside JSON without its enclosing quotes. This
// keeps escaped control characters and non-ASCII log output within the budget.
export function fitSummaryText(text, limit) {
  if (text.length <= limit && jsonBytes(text) - 2 <= limit) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += jsonBytes(char) - 2;
    if (bytes > limit) break;
    end += char.length;
  }
  return text.slice(0, end);
}

export function* summaryBatches(messages, limit) {
  let batch = [];
  let bytes = 0;
  for (const row of summarizationText(messages)) {
    // Reserve the row wrapper and a separator (one extra byte for the first row).
    const overhead = jsonBytes({ ...row, content: '' }) + 1;
    let remaining = row.content;
    while (true) {
      const part = fitSummaryText(remaining, limit - bytes - overhead);
      if (batch.length && (part.length < remaining.length || bytes + overhead > limit)) {
        yield batch;
        batch = [];
        bytes = 0;
        continue;
      }
      if (overhead > limit || (!part && remaining)) {
        throw new Error('压缩输入空间不足。请缩短压缩重点或增大上下文窗口。');
      }
      batch.push({ ...row, content: part });
      bytes += overhead + jsonBytes(part) - 2;
      if (part.length === remaining.length) break;
      remaining = remaining.slice(part.length);
    }
  }
  if (batch.length) yield batch;
}

export function emptyCache() {
  return { requests: 0, input: 0, hit: 0, miss: 0, unreported: 0, output: 0, compactionInput: 0 };
}

const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

// Pi normalizes absent counters to zero. Inspect the raw provider event as well.
export function readCacheEvidence(event) {
  const usage = event?.usage ?? event?.message?.usage ?? event?.choices?.[0]?.usage;
  if (!usage) return undefined;
  const hit = count(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ??
    usage.cached_tokens ?? usage.cache_read_input_tokens);
  const miss = count(usage.prompt_cache_miss_tokens);
  const write = count(usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_write_tokens);
  if (hit === undefined && miss === undefined && write === undefined) return undefined;
  return { hit, miss };
}

export function addUsage(cache, usage, evidence, source) {
  const read = count(usage?.cacheRead) ?? 0;
  const write = count(usage?.cacheWrite) ?? 0;
  const input = Math.max((count(usage?.input) ?? 0) + read + write, (evidence?.hit ?? 0) + (evidence?.miss ?? 0));
  const output = count(usage?.output) ?? 0;
  let hit = Math.min(input, evidence?.hit ?? read);
  if (evidence?.hit === undefined && evidence?.miss !== undefined) {
    hit = Math.max(0, input - evidence.miss);
  }
  const known = evidence !== undefined || read > 0 || write > 0;
  const last = { input, hit, miss: known ? input - hit : 0, unreported: known ? 0 : input, output };
  cache.requests++;
  for (const key of Object.keys(last)) cache[key] += last[key];
  cache.last = last;
  if (source === 'compaction') cache.compactionInput += input;
}
