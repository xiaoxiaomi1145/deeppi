import { randomUUID } from 'node:crypto';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { azureProvider } from '@earendil-works/pi-ai/providers/azure';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { setTimeout as delay } from 'node:timers/promises';
import { estimateTokens, readCacheEvidence } from './context.mjs';
import { AppError, effectiveUrl, googleCloudMode, isLoopback, resolveKey } from './settings.mjs';

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const models = {
  deepseek: deepseekProvider().getModels(),
  'openai-compatible': openaiProvider().getModels(),
  anthropic: anthropicProvider().getModels(),
  google: googleProvider().getModels(),
  mistral: mistralProvider().getModels(),
  azure: azureProvider().getModels().filter(model => model.api === 'azure-openai-responses'),
};
const nativeApis = {
  anthropic: 'anthropic-messages',
  google: 'google-generative-ai',
  mistral: 'mistral-conversations',
  azure: 'azure-openai-responses',
};
const adapters = {
  'openai-completions': openAICompletionsApi(),
  'openai-responses': openAIResponsesApi(),
  'anthropic-messages': anthropicMessagesApi(),
  'google-generative-ai': googleGenerativeAIApi(),
  'mistral-conversations': mistralConversationsApi(),
  'azure-openai-responses': azureOpenAIResponsesApi(),
};

export function modelCatalog() {
  return Object.fromEntries(Object.entries(models).map(([provider, entries]) => [provider,
    entries.map(({ id, name, contextWindow, maxTokens, reasoning }) => ({ id, name, contextWindow, maxOutputTokens: maxTokens, reasoning })),
  ]));
}

const isAzureResource = hostname => /\.(?:openai|cognitiveservices|ai)\.azure\.com$/u.test(hostname);

function resolveRoute(settings, override, modelId = settings.model) {
  if (typeof modelId !== 'string' || !modelId.trim()) throw new AppError(400, '请先填写模型 ID。');
  const { provider } = settings;
  if (provider === 'google' && googleCloudMode()) {
    throw new AppError(400, 'Gemini 使用 Developer API，不支持 Vertex AI 模式；请关闭 GOOGLE_GENAI_USE_ENTERPRISE 和 GOOGLE_GENAI_USE_VERTEXAI。');
  }
  const isDemo = provider === 'demo';
  const baseUrl = effectiveUrl(settings);
  if (!isDemo && !baseUrl) throw new AppError(400, provider === 'azure'
    ? '请先填写有效的 Azure OpenAI 资源 Base URL。' : '服务商的环境 Base URL 无效，请更正或在设置中填写。');
  const endpoint = isDemo ? null : new URL(baseUrl);
  // Gateways can share model IDs without supporting their official capabilities.
  const known = models[provider]?.find(model => model.id === modelId && (model.baseUrl
    ? new URL(model.baseUrl).origin === endpoint.origin
    : provider === 'azure' && isAzureResource(endpoint.hostname)));
  let wireUrl = baseUrl;
  if (provider === 'mistral' && /\/v1\/*$/u.test(endpoint.pathname)) {
    // Pi adds /v1/chat/completions itself.
    endpoint.pathname = endpoint.pathname.replace(/\/v1\/*$/u, '');
    wireUrl = endpoint.href.replace(/\/+$/u, '');
  }
  const contextWindow = Math.min(settings.contextWindow, known?.contextWindow ?? Infinity);
  const model = {
    ...(known ?? {
      name: modelId, provider, api: nativeApis[provider] ?? 'openai-completions',
      reasoning: !['google', 'mistral', 'azure'].includes(provider), input: ['text'], cost: zeroCost,
    }),
    id: modelId, baseUrl: wireUrl, contextWindow,
    // Some official models advertise the entire context as output capacity.
    maxTokens: Math.min(settings.maxOutputTokens, known?.maxTokens ?? Infinity, contextWindow - 1024),
  };
  if (!known && provider === 'openai-compatible') {
    model.compat = { supportsStore: false, supportsStrictMode: false,
      maxTokensField: endpoint.hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens' };
  }
  const key = resolveKey(settings, override);
  const anonymous = !key && endpoint !== null && isLoopback(endpoint.hostname);
  const apiKey = key || (anonymous ? 'deeppi-local' : undefined);
  if (!isDemo && !apiKey) throw new AppError(400, '请先在会话设置填写 API Key，或配置默认服务商的环境变量。');
  return { model, isDemo, key, apiKey, anonymous, origin: endpoint?.origin };
}

function scopedFetch({ anonymous, origin, fetch = globalThis.fetch, signal, onStatus }) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    // SDK configuration and redirects must not carry credentials to a different origin.
    if (url.origin !== origin) throw new Error('请求地址与配置的服务商不匹配。');
    const options = { ...init, redirect: 'error' };
    if (signal) options.signal = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
    if (anonymous) {
      // Pi needs a nonempty key to initialize an SDK even for anonymous loopback calls.
      options.headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      for (const name of ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key']) options.headers.delete(name);
    }
    const response = await fetch(input, options);
    onStatus?.(response.status);
    return response;
  };
}

function azureOptions(model, env) {
  // Pi 1.6 forwards env through streamSimple, but not azureBaseUrl/azureDeploymentName.
  // A whitespace map suppresses its fallback to the process deployment map.
  return model.api === 'azure-openai-responses' ? { env: {
    ...env, AZURE_OPENAI_BASE_URL: model.baseUrl, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: ' ',
  } } : {};
}

export function createRoute(settings, override, modelId = settings.model) {
  const { model, isDemo, key, apiKey, anonymous, origin } = resolveRoute(settings, override, modelId);

  function stream(requestModel, context, options = {}, onUsage, source = 'main') {
    let evidence;
    let maxTokens = Math.min(requestModel.maxTokens, options.maxTokens ?? requestModel.maxTokens);
    if (source === 'child') {
      const messages = normalizeContext(context).messages;
      const tools = getCurrentTools(messages).map(tool => ({ content: tool }));
      const room = requestModel.contextWindow - estimateTokens(messages) - estimateTokens(tools) - 768;
      if (room < 1) throw new Error('子代理上下文过长。请先压缩父会话或缩短子任务。');
      maxTokens = Math.min(maxTokens, room);
    }
    // Deeppi already budgets each lane. Pi's zero-window convention skips
    // the SDK's second 4096-token reserve without changing provider encoding.
    const wireModel = { ...requestModel, contextWindow: 0, maxTokens };
    const original = isDemo
      ? streamDemo(requestModel, context, options.signal, source)
      : adapters[model.api].streamSimple(wireModel, context, {
        ...options,
        ...azureOptions(model, options.env),
        apiKey,
        fetch: scopedFetch({ anonymous, origin, fetch: options.fetch }),
        cacheRetention: source === 'compaction' ? 'none' : 'short',
        timeoutMs: 180_000,
        maxRetryDelayMs: 5000,
        maxTokens,
        ...(settings.temperature === null || source === 'compaction' ? {} : { temperature: settings.temperature }),
        onProviderStreamEvent(event) {
          const usage = event?.usage;
          const counters = readCacheEvidence(event) ?? readCacheEvidence({ usage: {
            cached_tokens: event?.response?.usage?.input_tokens_details?.cached_tokens ??
              event?.usageMetadata?.cachedContentTokenCount ??
              usage?.promptTokensDetails?.cachedTokens ?? usage?.promptTokenDetails?.cachedTokens ??
              usage?.prompt_token_details?.cached_tokens ?? usage?.numCachedTokens ?? usage?.num_cached_tokens,
          } });
          if (counters) evidence = { hit: counters.hit ?? evidence?.hit, miss: counters.miss ?? evidence?.miss };
        },
      });
    const result = original.result().then(message => {
      onUsage?.(message.usage, evidence, source);
      // Provider errors can contain portions of the request or the credential.
      if (message.errorMessage && key && message.errorMessage.includes(key)) {
        message.errorMessage = message.errorMessage.replaceAll(key, '[redacted]');
      }
      return message;
    });
    void result.catch(() => {});
    return { [Symbol.asyncIterator]: () => original[Symbol.asyncIterator](), result: () => result };
  }
  return { model, stream };
}

const textBlock = text => ({ type: 'text', text });
const PROBE_TIMEOUT_MS = 10_000;

export async function testConnection(settings, override, signal) {
  signal?.throwIfAborted();
  const { model, isDemo, apiKey, anonymous, origin } = resolveRoute(settings, override);
  if (isDemo) return { model: model.id }; // No network I/O in local demo mode.

  const deadline = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(probeSignal.reason);
    probeSignal.addEventListener('abort', onAbort, { once: true });
  });
  const maxTokens = Math.min(32, model.maxTokens);
  const wireModel = { ...model, contextWindow: 0, maxTokens };
  const context = { messages: [{ role: 'user', content: [textBlock('Reply with OK.')], timestamp: Date.now() }] };
  let upstreamStatus;
  try {
    const stream = adapters[model.api].streamSimple(wireModel, context, {
      ...azureOptions(model),
      apiKey,
      fetch: scopedFetch({ anonymous, origin, signal: probeSignal, onStatus: status => { upstreamStatus = status; } }),
      signal: probeSignal,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: 'none',
      disableContinuation: true,
      maxTokens,
      onPayload(params) {
        // Responses may omit the limit for subscription-style credentials.
        if (model.api === 'openai-responses') return { ...params, max_output_tokens: Math.max(16, maxTokens) };
        if (model.api === 'anthropic-messages' && params.fallbacks) {
          // Prove that the selected model works, not an allowed fallback.
          const { fallbacks, ...request } = params;
          return request;
        }
      },
    });
    const message = await Promise.race([stream.result(), interrupted]);
    probeSignal.throwIfAborted();
    // A reasoning-only model can spend this intentionally small cap before
    // emitting text. A valid terminal response with generated tokens still
    // demonstrates connectivity; a tool call or an empty stream does not.
    const generated = message.usage?.output > 0 || message.content.some(block =>
      (block.type === 'text' && block.text.trim()) || (block.type === 'thinking' && block.thinking.trim()));
    if ((message.stopReason === 'stop' || message.stopReason === 'length') && generated) return { model: model.id };
  } catch {
    // Do not include upstream error bodies, request values, or adapter errors.
  } finally {
    probeSignal.removeEventListener('abort', onAbort);
  }
  signal?.throwIfAborted();
  if (deadline.aborted) throw new AppError(504, '连接测试超时，请确认服务地址和网络后重试。');
  if (upstreamStatus === 401 || upstreamStatus === 403) throw new AppError(502, '上游拒绝请求，请检查 API Key 或模型权限。');
  if (upstreamStatus === 429) throw new AppError(502, '上游限制了请求，请检查配额或稍后重试。');
  throw new AppError(502, '未收到有效的模型回复，请检查服务地址、模型 ID 和接口兼容性。');
}

const toolCall = (name, args) => ({ type: 'toolCall', id: `demo_${randomUUID().replaceAll('-', '')}`, name, arguments: args });

function demoContent(context, source) {
  const history = context.messages.filter(message => message.role !== 'system');
  const last = history.at(-1);
  const text = last?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
  const tools = new Set(getCurrentTools(normalizeContext(context).messages).map(tool => tool.name));
  if (source === 'compaction') {
    const { previous, transcript, focus } = JSON.parse(text);
    const notes = transcript.filter(message => message.role === 'user').slice(-6).map(message => `- ${message.content.slice(0, 110)}`);
    return [textBlock([previous.slice(0, 400), '已讨论的请求：', ...notes, focus && `关注项：${focus.slice(0, 160)}`].filter(Boolean).join('\n'))];
  }
  if (source === 'child') return [textBlock(`已完成分工。${text.split('\n').at(-1)?.slice(0, 150) ?? ''}`)];
  if (last?.role === 'toolResult') {
    if (last.toolName === 'define_tool' && !last.isError && tools.has('run_tool')) {
      return [toolCall('run_tool', { name: 'say_hello', args: { who: 'Deeppi' } })];
    }
    return [textBlock(`执行结果\n\n${text.slice(0, 1000)}`)];
  }
  if (text.includes('演示 Bash')) {
    if (!tools.has('define_tool')) return [textBlock('在会话设置开启 Bash 后再次发送“演示 Bash”。')];
    return [toolCall('define_tool', {
      name: 'say_hello', description: '打印一行问候', parameters: [{ name: 'who', required: true }],
      script: 'printf "Hello, %s!\\n" "$1"',
    })];
  }
  if (text.includes('演示子代理') && tools.has('delegate')) {
    return [toolCall('delegate', { name: '接口', task: '核对接口返回结构。' }),
      toolCall('delegate', { name: '用法', task: '整理两条快速上手说明。' })];
  }
  return [textBlock(`这是 Deeppi 的本地演示。\n\n你可以发送 **演示 Bash** 或 **演示子代理**，查看真实工具循环。\n\n你刚发送：${text.slice(0, 200)}`)];
}

function streamDemo(model, context, signal, source) {
  const stream = createAssistantMessageEventStream();
  const usage = { input: Math.max(8, estimateTokens(context.messages)), output: 0, cacheRead: 0, cacheWrite: 0,
    totalTokens: 0, cost: { ...zeroCost, total: 0 } };
  const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage, stopReason: 'stop', timestamp: Date.now() };
  void (async () => {
    try {
      signal?.throwIfAborted();
      stream.push({ type: 'start', partial: message });
      for (const block of demoContent(context, source)) {
        const contentIndex = message.content.length;
        if (block.type === 'toolCall') {
          message.stopReason = 'toolUse';
          message.content.push(block);
          stream.push({ type: 'toolcall_start', contentIndex, partial: message });
          stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: message });
        } else {
          const partial = textBlock('');
          message.content.push(partial);
          stream.push({ type: 'text_start', contentIndex, partial: message });
          for (const delta of block.text.match(/[\s\S]{1,14}/gu) ?? []) {
            await delay(source === 'main' ? 14 : 1, undefined, { signal });
            partial.text += delta;
            stream.push({ type: 'text_delta', contentIndex, delta, partial: message });
          }
          stream.push({ type: 'text_end', contentIndex, content: block.text, partial: message });
        }
      }
      usage.output = estimateTokens([message]);
      usage.totalTokens = usage.input + usage.output;
      stream.push({ type: 'done', reason: message.stopReason, message });
    } catch (error) {
      message.stopReason = signal?.aborted ? 'aborted' : 'error';
      message.errorMessage = error.message;
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } finally {
      stream.end();
    }
  })();
  return stream;
}
