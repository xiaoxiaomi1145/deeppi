import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { azureProvider } from '@earendil-works/pi-ai/providers/azure';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import * as provider from '../server/provider.mjs';
import { connectionStatus, defaults, effectiveUrl, resolveKey, updateSettings } from '../server/settings.mjs';

const settings = (provider, overrides = {}) => ({ ...defaults(process.cwd(), false), provider, ...overrides });
const knownProviders = { deepseek: deepseekProvider, 'openai-compatible': openaiProvider, anthropic: anthropicProvider,
  google: googleProvider, mistral: mistralProvider, azure: azureProvider };
const fixtureKey = 'sk-test-not-a-real-credential';

for (const [route, factory] of Object.entries(knownProviders)) {
  test(`modelCatalog lists Pi's public ${route} chat models as serializable metadata`, () => {
    const catalog = provider.modelCatalog();
    const models = factory().getModels().filter(model => route !== 'azure' || model.api === 'azure-openai-responses');
    assert.ok(models.length > 0);
    assert.deepEqual(catalog[route], models.map(({ id, name, contextWindow, maxTokens, reasoning }) => ({
      id, name, contextWindow, maxOutputTokens: maxTokens, reasoning,
    })));
    assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
  });
}

test('official DeepSeek uses catalog metadata, preserves the configured path, and respects tighter user budgets', () => {
  const known = deepseekProvider().getModels().find(model => model.id === 'deepseek-flash');
  const config = settings('deepseek', { model: known.id, baseUrl: 'https://api.deepseek.com/v1', contextWindow: 2_000_000, maxOutputTokens: 8192 });
  const { model } = provider.createRoute(config, fixtureKey);
  assert.equal(model.name, known.name);
  assert.equal(model.baseUrl, config.baseUrl);
  assert.equal(model.contextWindow, known.contextWindow);
  assert.equal(model.maxTokens, config.maxOutputTokens);
  assert.equal(model.reasoning, known.reasoning);
  assert.deepEqual(model.input, known.input);
  assert.deepEqual(model.compat, known.compat);
});

test('recognized official OpenAI models use Responses with real reasoning and output limits', () => {
  const known = openaiProvider().getModels().find(model => model.id === 'gpt-4o-mini');
  const config = settings('openai-compatible', { model: known.id, contextWindow: 200_000, maxOutputTokens: 40_000 });
  const { model } = provider.createRoute(config, fixtureKey);
  assert.equal(model.api, known.api);
  assert.equal(model.provider, known.provider);
  assert.equal(model.name, known.name);
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, known.contextWindow);
  assert.equal(model.maxTokens, known.maxTokens);
  assert.deepEqual(model.cost, known.cost);
});

test('old official models with a shared-sized output ceiling still reserve input space', () => {
  const { model } = provider.createRoute(settings('openai-compatible', { model: 'gpt-4' }), fixtureKey);
  assert.equal(model.contextWindow, openaiProvider().getModels().find(model => model.id === 'gpt-4').contextWindow);
  assert.ok(model.maxTokens > 0 && model.contextWindow - model.maxTokens >= 1024);
});

test('official Anthropic preserves Pi compatibility and uses the requested child model ID', () => {
  const known = anthropicProvider().getModels().find(model => model.id === 'claude-opus-4-7');
  const config = settings('anthropic', { model: 'claude-sonnet-4-6', maxOutputTokens: 6144 });
  const { model } = provider.createRoute(config, fixtureKey, known.id);
  assert.equal(model.id, known.id);
  assert.equal(model.api, known.api);
  assert.equal(model.contextWindow, config.contextWindow);
  assert.equal(model.maxTokens, config.maxOutputTokens);
  assert.deepEqual(model.compat, known.compat);
  assert.deepEqual(model.promptCache, known.promptCache);
});

test('custom origin with a familiar ID and manual ID on the official origin retain configured routing', () => {
  const baseUrl = 'http://127.0.0.1:31899/proxy/custom';
  const limits = { contextWindow: 240_000, maxOutputTokens: 50_000 };
  const config = settings('openai-compatible', { baseUrl, model: 'gpt-4o-mini', ...limits });
  const { model } = provider.createRoute(config);
  assert.equal(model.provider, 'openai-compatible');
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.id, config.model);
  assert.equal(model.baseUrl, baseUrl);
  assert.equal(model.contextWindow, limits.contextWindow);
  assert.equal(model.maxTokens, limits.maxOutputTokens);
  assert.equal(model.compat.maxTokensField, 'max_tokens');
  const manual = provider.createRoute({ ...config, baseUrl: '', model: 'manual-future-id' }, fixtureKey).model;
  assert.equal(manual.api, 'openai-completions');
  assert.equal(manual.id, 'manual-future-id');
  assert.equal(manual.compat.maxTokensField, 'max_completion_tokens');
  assert.equal(manual.contextWindow, limits.contextWindow);
});

function chatCompletion(response, { model }) {
  const common = { id: 'probe', object: 'chat.completion.chunk', created: 123, model };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const choice of [
    { index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: 'stop' },
  ]) response.write(`data: ${JSON.stringify({ ...common, choices: [choice] })}\n\n`);
  response.end('data: [DONE]\n\n');
}

function responsesCompletion(response, { model }) {
  const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const events = [
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', model, status: 'completed', output: [item], usage: {
      input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 },
    } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function anthropicCompletion(response, { model }) {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function fixture(t, reply = chatCompletion) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    try {
      for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      requests.push({ url: request.url, method: request.method, headers: request.headers, body });
      reply(response, body);
    } catch {
      response.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

function replaceEnv(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function forwardOfficialFetch(t, fromOrigin, fixtureOrigin) {
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, fromOrigin);
    return fetch(`${fixtureOrigin}${url.pathname}${url.search}`, init);
  });
}

test('probe sends one short stateless Pi request to the configured path and model with its explicit credential', async t => {
  const { origin, requests } = await fixture(t);
  const config = settings('openai-compatible', {
    baseUrl: `${origin}/proxy/v9`, model: 'gateway-chosen-id', systemPrompt: 'Do not send this private system prompt.',
    allowBash: true, thinkingLevel: 'max', temperature: 1.7,
  });
  assert.deepEqual(await provider.testConnection(config, fixtureKey), { model: config.model });
  assert.equal(requests.length, 1);
  const [{ method, url, headers, body }] = requests;
  assert.equal(method, 'POST');
  assert.equal(url, '/proxy/v9/chat/completions');
  assert.equal(headers.authorization, `Bearer ${fixtureKey}`);
  assert.equal(headers['x-session-id'], undefined);
  assert.equal(headers['x-client-request-id'], undefined);
  assert.equal(body.model, config.model);
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 64);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map(({ role }) => role), ['user']);
  assert.doesNotMatch(JSON.stringify(body), /private system prompt/);
  assert.equal(body.tools, undefined);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test('anonymous loopback never sends the official environment key or a dummy auth header', async t => {
  replaceEnv(t, 'OPENAI_API_KEY', fixtureKey);
  const { origin, requests } = await fixture(t);
  const config = settings('openai-compatible', { baseUrl: `${origin}/local`, model: 'gpt-4o-mini' });
  assert.deepEqual(await provider.testConnection(config), { model: config.model });
  const { model, stream } = provider.createRoute(config);
  const result = await stream(model, { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }).result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(requests.length, 2);
  for (const { url, headers } of requests) {
    assert.equal(url, '/local/chat/completions');
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-api-key'], undefined);
  }
});

test('Anthropic loopback works without an API key and preserves its native message path', async t => {
  replaceEnv(t, 'ANTHROPIC_API_KEY', fixtureKey);
  const { origin, requests } = await fixture(t, anthropicCompletion);
  const config = settings('anthropic', { baseUrl: `${origin}/gateway`, model: 'manual-claude' });
  assert.deepEqual(await provider.testConnection(config), { model: config.model });
  const [{ url, headers, body }] = requests;
  assert.equal(new URL(url, origin).pathname, '/gateway/v1/messages');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(body.model, config.model);
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 64);
  assert.deepEqual(body.messages.map(({ role }) => role), ['user']);
  assert.equal(body.tools, undefined);
});

test('an official Anthropic probe tests the selected model instead of requesting catalog fallbacks', async t => {
  const known = anthropicProvider().getModels().find(model => model.compat?.allowedFallbackModels?.length);
  assert.ok(known);
  const { origin, requests } = await fixture(t, anthropicCompletion);
  forwardOfficialFetch(t, 'https://api.anthropic.com', origin);
  const config = settings('anthropic', { model: known.id });
  assert.deepEqual(await provider.testConnection(config, fixtureKey), { model: known.id });
  const [{ body }] = requests;
  assert.equal(body.model, known.id);
  assert.equal(body.fallbacks, undefined);
});

test('native Responses uses the scoped official environment key and preserves cache evidence, even a reported zero', async t => {
  replaceEnv(t, 'OPENAI_API_KEY', fixtureKey);
  const { origin, requests } = await fixture(t, responsesCompletion);
  forwardOfficialFetch(t, 'https://api.openai.com', origin);
  const config = settings('openai-compatible', { baseUrl: 'https://api.openai.com/fixture/v1', model: 'gpt-4o-mini' });
  assert.deepEqual(await provider.testConnection(config), { model: config.model });
  const { model, stream } = provider.createRoute(config);
  let reported;
  const context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] };
  await stream(model, context, { sessionId: 'fixture-session' }, (usage, evidence) => { reported = { usage, evidence }; }).result();
  assert.equal(requests.length, 2);
  const [{ url, headers, body }, main] = requests;
  assert.equal(url, '/fixture/v1/responses');
  assert.equal(headers.authorization, `Bearer ${fixtureKey}`);
  assert.equal(body.model, config.model);
  assert.ok(body.max_output_tokens > 0 && body.max_output_tokens <= 64);
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.prompt_cache_key, undefined);
  assert.deepEqual(body.input.map(({ role }) => role), ['user']);
  assert.equal(main.body.prompt_cache_key, 'fixture-session');
  assert.equal(reported.usage.input, 10);
  assert.equal(reported.evidence.hit, 0);
});

function geminiCompletion(response) {
  const event = {
    responseId: 'gemini-fixture', modelVersion: 'fixture-gemini',
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 0 },
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify(event)}\n\n`);
}

const conversation = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] };

function assertProbe(request, authHeader, expectedKey) {
  assert.equal(request.method, 'POST');
  assert.equal(request.headers[authHeader], expectedKey);
  assert.equal(request.body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(request.body), /Session prompt must not be sent/);
}

test('Gemini streams native generateContent and probes with a bounded, stateless request', async t => {
  // Fail closed if the SDK attempts a request outside the actual local fixture.
  replaceEnv(t, 'GOOGLE_GENAI_USE_ENTERPRISE', 'false');
  replaceEnv(t, 'GOOGLE_GENAI_USE_VERTEXAI', undefined);
  const { origin, requests } = await fixture(t, geminiCompletion);
  forwardOfficialFetch(t, origin, origin);
  const config = updateSettings(defaults(process.cwd(), false), {
    provider: 'google', model: 'fixture-gemini', baseUrl: `${origin}/proxy/v1beta/`,
    systemPrompt: 'Session prompt must not be sent', maxOutputTokens: 512,
  }, false);
  assert.deepEqual(await provider.testConnection(config, fixtureKey), { model: config.model });
  const { model, stream } = provider.createRoute(config, fixtureKey);
  let reported;
  const result = await stream(model, conversation, {}, (usage, evidence) => { reported = { usage, evidence }; }).result();
  assert.equal(result.api, 'google-generative-ai');
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content.map(block => block.text), ['OK']);
  assert.deepEqual([reported.usage.input, reported.usage.output, reported.evidence.hit], [10, 2, 0]);
  const [probe, chat] = requests;
  assert.equal(requests.length, 2);
  for (const [request, text, tokens] of [[probe, 'Reply with OK.', 32], [chat, 'Hello', 512]]) {
    assert.equal(request.url, '/proxy/v1beta/models/fixture-gemini:streamGenerateContent?alt=sse');
    assert.equal(request.headers['x-goog-api-key'], fixtureKey);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.body.generationConfig.maxOutputTokens, tokens);
    assert.deepEqual(request.body.contents, [{ role: 'user', parts: [{ text }] }]);
  }
  assertProbe(probe, 'x-goog-api-key', fixtureKey);
  assert.equal(probe.body.systemInstruction, undefined);
});

test('the Gemini Developer API route rejects inherited Vertex mode before sending requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No request should be sent'); });
  replaceEnv(t, 'GOOGLE_GENAI_USE_ENTERPRISE', undefined);
  replaceEnv(t, 'GOOGLE_GENAI_USE_VERTEXAI', ' True ');
  const config = settings('google', { model: 'gemini-2.5-flash' });
  assert.equal(connectionStatus(config, fixtureKey), 'missing');
  await assert.rejects(provider.testConnection(config, fixtureKey), { status: 400, message: /Vertex AI/ });
  assert.throws(() => provider.createRoute(config, fixtureKey), { status: 400, message: /Vertex AI/ });
  assert.equal(fetch.mock.callCount(), 0);
  process.env.GOOGLE_GENAI_USE_ENTERPRISE = 'false';
  assert.equal(connectionStatus(config, fixtureKey), 'configured');
  assert.equal(provider.createRoute(config, fixtureKey).model.api, 'google-generative-ai');
});

test('Mistral uses native chat completions and disables prompt affinity on its probe', async t => {
  const { origin, requests } = await fixture(t);
  forwardOfficialFetch(t, origin, origin);
  const config = updateSettings(defaults(process.cwd(), false), {
    provider: 'mistral', model: 'fixture-mistral', baseUrl: `${origin}/gateway/v1/`,
    systemPrompt: 'Session prompt must not be sent', maxOutputTokens: 768,
  }, false);
  assert.deepEqual(await provider.testConnection(config, fixtureKey), { model: config.model });
  const { model, stream } = provider.createRoute(config, fixtureKey);
  const result = await stream(model, conversation, { sessionId: 'fixture-affinity' }).result();
  assert.equal(result.api, 'mistral-conversations');
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content.map(block => block.text), ['OK']);
  assert.equal(requests.length, 2);
  const [probe, chat] = requests;
  for (const request of requests) {
    assert.equal(request.url, '/gateway/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    assert.equal(request.body.model, config.model);
    assert.equal(request.body.stream, true);
  }
  assertProbe(probe, 'authorization', `Bearer ${fixtureKey}`);
  assert.equal(probe.body.max_tokens, 32);
  assert.deepEqual(probe.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }]);
  assert.equal(probe.body.prompt_cache_key, undefined);
  assert.equal(probe.headers['x-affinity'], undefined);
  assert.equal(chat.body.max_tokens, 768);
  assert.equal(chat.body.prompt_cache_key, 'fixture-affinity');
  assert.equal(chat.headers['x-affinity'], 'fixture-affinity');
});

test('Azure uses its native Responses endpoint and explicit resource despite SDK environment defaults', async t => {
  replaceEnv(t, 'AZURE_OPENAI_BASE_URL', 'https://different-resource.openai.azure.com');
  replaceEnv(t, 'AZURE_OPENAI_API_VERSION', 'v1');
  replaceEnv(t, 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP', 'my-gpt-deployment=a-different-deployment');
  const { origin, requests } = await fixture(t, responsesCompletion);
  forwardOfficialFetch(t, origin, origin);
  const config = updateSettings(defaults(process.cwd(), false), {
    provider: 'azure', model: 'my-gpt-deployment', baseUrl: `${origin}/gateway/openai/v1/`,
    systemPrompt: 'Session prompt must not be sent', maxOutputTokens: 1024,
  }, false);
  assert.deepEqual(await provider.testConnection(config, fixtureKey), { model: config.model });
  const { model, stream } = provider.createRoute(config, fixtureKey);
  let reported;
  const result = await stream(model, conversation, { sessionId: 'azure-session' }, (usage, evidence) => { reported = { usage, evidence }; }).result();
  assert.equal(result.api, 'azure-openai-responses');
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(result.content.map(block => block.text), ['OK']);
  assert.deepEqual([reported.usage.input, reported.usage.output, reported.evidence.hit], [10, 2, 0]);
  assert.equal(requests.length, 2);
  const [probe, chat] = requests;
  for (const request of requests) {
    assert.equal(request.url, '/gateway/openai/v1/responses?api-version=v1');
    assert.equal(request.headers['api-key'], fixtureKey);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.body.model, config.model);
    assert.equal(request.body.reasoning, undefined);
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
  }
  assertProbe(probe, 'api-key', fixtureKey);
  assert.equal(probe.body.max_output_tokens, 32);
  assert.deepEqual(probe.body.input.map(({ role }) => role), ['user']);
  assert.match(JSON.stringify(probe.body.input), /Reply with OK\./);
  assert.equal(probe.body.prompt_cache_key, undefined);
  assert.equal(probe.body.previous_response_id, undefined);
  assert.equal(chat.body.max_output_tokens, 1024);
  assert.equal(chat.body.prompt_cache_key, 'azure-session');
});

for (const [route, key, reply] of [
  ['google', 'GEMINI_API_KEY', geminiCompletion], ['mistral', 'MISTRAL_API_KEY', chatCompletion],
  ['azure', 'AZURE_OPENAI_API_KEY', responsesCompletion],
]) {
  test(`${route} loopback never receives ambient credentials or a dummy API key`, async t => {
    replaceEnv(t, key, fixtureKey);
    if (route === 'google') {
      replaceEnv(t, 'GOOGLE_API_KEY', undefined);
      replaceEnv(t, 'GOOGLE_GENAI_USE_ENTERPRISE', 'false');
    }
    if (route === 'azure') replaceEnv(t, 'AZURE_OPENAI_BASE_URL', 'https://resource.openai.azure.com');
    const { origin, requests } = await fixture(t, reply);
    forwardOfficialFetch(t, origin, origin);
    const config = updateSettings(defaults(process.cwd(), false), { provider: route, model: `local-${route}`, baseUrl: origin }, false);
    assert.equal(connectionStatus(config), 'configured');
    assert.equal(resolveKey(config), undefined);
    assert.deepEqual(await provider.testConnection(config), { model: config.model });
    assert.equal(requests.length, 1);
    const { url, headers } = requests[0];
    assert.ok(!new URL(url, origin).searchParams.has('key'));
    for (const header of ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']) assert.equal(headers[header], undefined);
    assert.throws(() => updateSettings(config, { baseUrl: 'http://example.test/v1' }, false), { status: 400 });
  });
}

test('Gemini and Mistral default environment keys are limited to their official origins', async t => {
  replaceEnv(t, 'GEMINI_API_KEY', 'test-gemini-primary');
  replaceEnv(t, 'GOOGLE_API_KEY', 'test-google-alias');
  replaceEnv(t, 'MISTRAL_API_KEY', 'test-mistral');
  const google = settings('google');
  const mistral = settings('mistral');
  assert.equal(effectiveUrl(google), 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(effectiveUrl(mistral), 'https://api.mistral.ai');
  assert.equal(resolveKey(google), 'test-gemini-primary');
  delete process.env.GEMINI_API_KEY; // replaceEnv restores the original value after this test.
  assert.equal(resolveKey(google), 'test-google-alias');
  assert.equal(resolveKey(mistral), 'test-mistral');
  for (const route of [google, mistral]) {
    const custom = { ...route, baseUrl: 'https://another-gateway.example.test/api' };
    assert.equal(connectionStatus(custom), 'missing');
    assert.equal(resolveKey(custom, fixtureKey), fixtureKey);
  }
});

test('Azure only uses an ambient key for its configured HTTPS resource, and probes the environment-backed endpoint', async t => {
  replaceEnv(t, 'AZURE_OPENAI_BASE_URL', undefined);
  replaceEnv(t, 'AZURE_OPENAI_ENDPOINT', undefined);
  replaceEnv(t, 'AZURE_OPENAI_RESOURCE_NAME', undefined);
  replaceEnv(t, 'AZURE_OPENAI_API_KEY', fixtureKey);
  replaceEnv(t, 'AZURE_OPENAI_API_VERSION', 'v1');
  const { origin, requests } = await fixture(t, responsesCompletion);
  forwardOfficialFetch(t, 'https://owned-resource.openai.azure.com', origin);
  const config = settings('azure', { model: 'my-deployment' });
  assert.equal(connectionStatus(config, fixtureKey), 'missing');
  await assert.rejects(provider.testConnection(config, fixtureKey), { status: 400 });
  assert.equal(requests.length, 0);
  process.env.AZURE_OPENAI_RESOURCE_NAME = 'owned-resource';
  assert.equal(connectionStatus(config), 'configured');
  assert.equal(resolveKey({ ...config, baseUrl: 'https://other-resource.openai.azure.com' }), undefined);
  assert.deepEqual(await provider.testConnection(config), { model: config.model });
  assert.equal(requests[0].url, '/openai/v1/responses?api-version=v1');
  assert.equal(requests[0].headers['api-key'], fixtureKey);
  process.env.AZURE_OPENAI_ENDPOINT = 'https://owned-resource.openai.azure.com/alternate/openai/v1/';
  assert.equal(effectiveUrl(config), 'https://owned-resource.openai.azure.com/alternate/openai/v1');
  process.env.AZURE_OPENAI_BASE_URL = 'http://localhost:12345/openai/v1';
  assert.equal(connectionStatus(config), 'missing');
  assert.equal(resolveKey({ ...config, baseUrl: 'http://localhost:12345/openai/v1' }), undefined);
});

test('credential and malformed upstream responses become sanitized 502 errors, and a retryable rejection is not retried', async t => {
  const secretInBody = 'unrelated-provider-secret';
  const { origin, requests } = await fixture(t, (response, body) => {
    const status = body.model === 'rejected-key' ? 401 : body.model === 'retryable' ? 429 : 200;
    response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '120' });
    response.end(JSON.stringify({ error: { message: `leak ${fixtureKey} and ${secretInBody}` } }));
  });
  for (const model of ['rejected-key', 'retryable', 'malformed']) {
    const config = settings('openai-compatible', { baseUrl: origin, model });
    await assert.rejects(provider.testConnection(config, fixtureKey), error => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(`${error.stack}\n${JSON.stringify(error)}`, new RegExp(`${fixtureKey}|${secretInBody}`));
      if (model === 'rejected-key') assert.match(error.message, /API Key/);
      return true;
    });
  }
  assert.deepEqual(requests.map(({ body }) => body.model), ['rejected-key', 'retryable', 'malformed']);
});

test('a redirect is not followed with the upstream credential', async t => {
  const other = await fixture(t);
  const first = await fixture(t, response => response.writeHead(307, { location: `${other.origin}/redirect-target` }).end());
  const config = settings('openai-compatible', { baseUrl: first.origin, model: 'redirected' });
  await assert.rejects(provider.testConnection(config, fixtureKey), { status: 502 });
  assert.equal(first.requests.length, 1);
  assert.equal(other.requests.length, 0);
});

test('missing credentials fail with 400 without a provider request; demo makes a local check', async t => {
  replaceEnv(t, 'DEEPSEEK_API_KEY', undefined);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No request should be sent'); });
  await assert.rejects(provider.testConnection(settings('deepseek')), { status: 400 });
  await assert.rejects(provider.testConnection(settings('deepseek', { model: '' }), fixtureKey), { status: 400 });
  assert.deepEqual(await provider.testConnection(defaults(process.cwd(), true)), { model: 'deeppi-demo' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('the explicit deadline covers the whole response body, and caller aborts are propagated', { timeout: 15_000 }, async t => {
  let received;
  const stalled = () => new Promise(resolve => { received = resolve; });
  let started = stalled();
  const { origin } = await fixture(t, response => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    received();
  });
  const deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', ms => {
    assert.ok(ms > 0 && ms <= 15_000);
    return deadline.signal;
  });
  const config = settings('openai-compatible', { baseUrl: origin, model: 'stalls' });
  const probe = provider.testConnection(config, fixtureKey);
  const timedOut = assert.rejects(probe, { status: 504 });
  await started;
  deadline.abort(new DOMException('deadline test', 'TimeoutError'));
  await timedOut;
  assert.ok(timeout.mock.callCount() >= 1);
  timeout.mock.restore();

  const caller = new AbortController();
  const reason = new DOMException('caller disconnected', 'AbortError');
  started = stalled();
  const aborted = assert.rejects(provider.testConnection(config, fixtureKey, caller.signal), error => error === reason);
  await started;
  caller.abort(reason);
  await aborted;
  await assert.rejects(provider.testConnection(config, fixtureKey, caller.signal), error => error === reason);
});
