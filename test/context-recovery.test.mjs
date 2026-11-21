import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessions } from '../server/sessions.mjs';

function answer(res, delta, finish = 'stop') {
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 123, model: 'deepseek-flash' };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choices of [[{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }],
    [{ index: 0, delta: {}, finish_reason: finish }]]) {
    res.write(`data: ${JSON.stringify({ ...chunk, choices })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

const message = (role, text, details = {}) => ({
  role, timestamp: 123, content: [{ type: 'text', text }], ...details,
});
const assistant = (text, details) => message('assistant', text, {
  provider: 'deepseek', api: 'openai-completions', model: 'deepseek-flash', stopReason: 'stop',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, ...details,
});

async function fixture(t, respond, { history = [], settings = {}, bashAvailable = false } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'deeppi-recovery-'));
  const dataDir = join(workspace, 'state');
  const calls = [];
  const upstream = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    calls.push(body);
    respond(body, res, calls.length);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.close();
    upstream.closeAllConnections();
    await rm(workspace, { recursive: true, force: true });
  });
  const options = { workspace, dataDir, demo: false, bashAvailable };
  let sessions = createSessions(options);
  const { id } = sessions.create({});
  sessions.patch(id, { settings: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}`, contextWindow: 4096, maxOutputTokens: 256,
    maxSubagents: 0, keepRecentTokens: 256, ...settings,
  } });
  const path = join(dataDir, `${id}.json`);
  if (history.length) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.history = history.map(message => ({ id: randomUUID(), message }));
    await writeFile(path, JSON.stringify(record));
    sessions = createSessions(options);
  }
  return { sessions, id, calls, path, options };
}

function idle(sessions, id) {
  return new Promise(resolve => {
    const unsubscribe = sessions.subscribe(id, (event, data) => {
      if (event !== 'state' && event !== 'update') return;
      const view = JSON.parse(data);
      if (view.status === 'idle') {
        queueMicrotask(() => unsubscribe());
        resolve(sessions.get(id));
      }
    });
  });
}

const wireText = ({ content }) => typeof content === 'string' ? content : content.map(block => block.text).join('\n');
const isFold = request => /^Summarize previous dialogue/u.test(wireText(request.messages[0]));
const userTexts = view => view.messages.filter(({ role }) => role === 'user').map(({ text }) => text);

test('auto-compaction summarizes an archive with an oversized tool result in bounded ordered requests', { timeout: 10_000 }, async t => {
  const toolText = `BEGIN\n${'报😀\n"\\'.repeat(1900)}\nEND`;
  const folded = [];
  const { sessions, id, calls, options } = await fixture(t, (request, res) => {
    if (!isFold(request)) return answer(res, { content: 'continued' });
    const text = wireText(request.messages.at(-1));
    folded.push({ inputBytes: request.messages.reduce((sum, message) => sum + Buffer.byteLength(wireText(message)), 0),
      payload: JSON.parse(text), maxTokens: request.max_tokens });
    answer(res, { content: `summary ${folded.length}` });
  }, { history: [message('user', 'archived question'), assistant('', {
    stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool_1', name: 'bash', arguments: { command: 'printf example' } }],
  }), message('toolResult', toolText, { toolCallId: 'tool_1', toolName: 'bash', isError: false }), assistant('archived answer')] });
  const before = sessions.get(id).messages;
  sessions.prompt(id, { text: 'latest question' });
  const view = await idle(sessions, id);
  assert.equal(view.error, undefined);
  assert.ok(folded.length > 1);
  assert.equal(folded.flatMap(batch => batch.payload.transcript).filter(({ role }) => role === 'tool bash')
    .map(({ content }) => content).join(''), toolText);
  assert.ok(folded.every(batch => batch.maxTokens === 256 && batch.inputBytes + batch.maxTokens + 256 <= 4096));
  assert.deepEqual(folded.map(batch => batch.payload.previous), ['', ...folded.slice(1).map((_, i) => `summary ${i + 1}`)]);
  const main = calls.filter(request => !isFold(request));
  assert.equal(main.length, 1);
  assert.equal(main[0].max_tokens, 256);
  assert.deepEqual(main[0].messages.slice(1).map(({ role }) => role), ['user', 'user']);
  assert.match(wireText(main[0].messages[1]), new RegExp(`summary ${folded.length}\\b`, 'u'));
  assert.equal(wireText(main[0].messages[2]), 'latest question');
  assert.equal(view.context.coveredMessages, 4);
  assert.equal(view.compactions.length, 1);
  assert.deepEqual(view.messages.slice(0, 4), before);
  assert.deepEqual(createSessions(options).get(id).messages, view.messages);
});

test('after a fold the latest text is sent alone when the saved summary would still exceed the input budget', { timeout: 10_000 }, async t => {
  const latest = 'latest '.repeat(1400).trim();
  const { sessions, id, calls } = await fixture(t, (request, res) => {
    answer(res, { content: isFold(request) ? 'detail '.repeat(100) : 'continued' });
  }, { history: [message('user', 'old request'), assistant('large archive '.repeat(1000))] });
  const before = sessions.get(id).messages;
  sessions.prompt(id, { text: latest });
  const view = await idle(sessions, id);
  assert.equal(view.error, undefined);
  assert.equal(view.compactions.length, 1);
  assert.deepEqual(calls.filter(request => !isFold(request)).map(request => request.messages.slice(1).map(wireText)), [[latest]]);
  assert.deepEqual(view.messages.slice(0, 2), before);
  assert.deepEqual(userTexts(view), ['old request', latest]);
});

test('provider context overflow before streaming retries just the latest user text once', { timeout: 10_000 }, async t => {
  const { sessions, id, calls } = await fixture(t, (request, res, count) => {
    if (count > 1) return answer(res, { content: 'continued' });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model', code: 'context_length_exceeded' } }));
  }, { history: [message('user', 'earlier question'), assistant('earlier answer')] });
  const before = sessions.get(id).messages;
  sessions.prompt(id, { text: 'latest question' });
  const view = await idle(sessions, id);
  assert.equal(view.error, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].messages.slice(1).map(wireText), ['earlier question', 'earlier answer', 'latest question']);
  assert.deepEqual(calls[1].messages.slice(1).map(wireText), ['latest question']);
  assert.deepEqual(calls[1].messages[0], calls[0].messages[0]);
  assert.deepEqual(view.messages.slice(0, 2), before);
  assert.deepEqual(userTexts(view), ['earlier question', 'latest question']);
  assert.equal(view.messages.some(({ state }) => state === 'error'), false);
});

test('overflow on the isolated retry stops with actionable advice', { timeout: 10_000 }, async t => {
  const { sessions, id, calls } = await fixture(t, (_request, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model', code: 'context_length_exceeded' } }));
  }, { history: [message('user', 'earlier question'), assistant('earlier answer')] });
  sessions.prompt(id, { text: 'latest question' });
  const view = await idle(sessions, id);
  assert.equal(calls.length, 2);
  assert.match(view.error ?? '', /上下文预算.*缩短消息/u);
  assert.deepEqual(userTexts(view), ['earlier question', 'latest question']);
});

test('a delegated task keeps the recoverable prefix and the configured output budget at 4096 tokens', { timeout: 10_000 }, async t => {
  const { sessions, id, calls } = await fixture(t, (_request, res, count) => {
    if (count === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model', code: 'context_length_exceeded' } }));
    }
    if (count === 2) return answer(res, { tool_calls: [{ index: 0, id: 'delegate_1', type: 'function', function: {
      name: 'delegate', arguments: JSON.stringify({ name: 'check', task: 'Summarize the latest request.' }),
    } }] }, 'tool_calls');
    answer(res, { content: count === 3 ? 'child answered' : 'parent answered' });
  }, { history: [message('user', 'earlier question'), assistant('earlier answer')], settings: { maxSubagents: 1 } });
  sessions.prompt(id, { text: 'latest question' });
  const view = await idle(sessions, id);
  assert.equal(view.error, undefined);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(request => request.max_tokens === 256));
  const child = calls[2].messages.map(wireText);
  assert.equal(child[1], 'latest question');
  assert.match(child[2], /Summarize the latest request\./u);
  assert.equal(child.length, 3);
  assert.equal(view.agents[0]?.status, 'done');
  assert.equal(view.agents[0]?.result, 'child answered');
});

test('an oversized current tool turn stops before a model follow-up and keeps its complete tool output visible', { timeout: 10_000 }, async t => {
  const { sessions, id, calls } = await fixture(t, (_request, res, count) => {
    if (count > 1) return answer(res, { content: 'unexpected follow-up' });
    answer(res, { tool_calls: [{ index: 0, id: 'bash_1', type: 'function', function: {
      name: 'bash', arguments: JSON.stringify({ command: 'printf %12000s test' }),
    } }] }, 'tool_calls');
  }, { bashAvailable: true, settings: { allowBash: true, maxToolOutput: 15000 } });
  sessions.prompt(id, { text: 'run the sample' });
  const view = await idle(sessions, id);
  assert.match(view.error ?? '', /上下文.*(?:工具输出|窗口)/u);
  assert.equal(calls.length, 1);
  const tool = view.messages.find(({ role }) => role === 'tool');
  assert.match(tool.text, /test\n\[Bash exit code: 0\]/u);
  assert.ok(tool.text.length >= 12000);
});

test('startup Bash capability masks persisted settings and blocks the provider tool loadout', { timeout: 10_000 }, async t => {
  const { id, calls, path, options } = await fixture(t,
    (_request, res) => answer(res, { content: 'ok' }), { bashAvailable: true, settings: { allowBash: true } });
  const sessions = createSessions({ ...options, bashAvailable: undefined });
  assert.equal(sessions.info().bashAvailable, false);
  assert.equal(sessions.get(id).settings.allowBash, false);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).settings.allowBash, true);
  assert.throws(() => sessions.patch(id, { settings: { allowBash: true } }), { status: 403, message: /--allow-bash/u });
  sessions.prompt(id, { text: 'hello' });
  const view = await idle(sessions, id);
  assert.equal(view.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools?.length ?? 0, 0);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).settings.allowBash, false);
});
