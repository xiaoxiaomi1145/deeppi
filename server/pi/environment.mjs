import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { environmentRoute, googleCloudMode } from '../settings.mjs';

const providers = [
  ['deepseek', 'deepseek', 'openai-completions'],
  ['openai-compatible', 'openai', 'openai-completions'],
  ['anthropic', 'anthropic', 'anthropic-messages'],
  ['google', 'google', 'google-generative-ai'],
  ['mistral', 'mistral', 'mistral-conversations'],
  ['azure', 'azure', 'azure-openai-responses'],
];

export function registerPiEnvironment(pi, env = process.env) {
  const paired = new Map();
  for (const [provider, nativeName, api] of providers) {
    const route = environmentRoute(provider, env);
    if (!route.custom || !route.keyName || !env[route.keyName]?.trim()) continue;
    paired.set(nativeName, route.baseUrl);
    if (!route.baseUrl || (provider === 'google' && googleCloudMode())) continue;
    // Give environment gateways their own Pi provider IDs. Overriding a built-in
    // ID could route a stored /login credential or OAuth token to the gateway.
    const baseUrl = provider === 'mistral' ? route.baseUrl.replace(/\/v1$/u, '') : route.baseUrl;
    const models = getBuiltinModels(nativeName)
      .filter(model => provider !== 'azure' || model.api === api)
      .map(model => ({ id: model.id, name: `${model.name} · 环境端点`, api,
        reasoning: Boolean(model.reasoning), input: model.input, cost: model.cost,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        ...(api === 'openai-completions' ? { compat: provider === 'deepseek' ? model.compat : {
          supportsStore: false, supportsStrictMode: false, maxTokensField: 'max_tokens',
        } } : {}) }));
    pi.registerProvider(`deeppi-env-${nativeName}`, { name: `${nativeName} (Deeppi env)`, baseUrl, apiKey: `$${route.keyName}`, api, models });
  }
  return model => {
    if (!paired.has(model.provider)) return true;
    const baseUrl = paired.get(model.provider);
    // Only use the original native ID when Pi itself was deliberately configured
    // with that same endpoint. Otherwise require explicit selection of the alias.
    return Boolean(baseUrl && typeof model.baseUrl === 'string' && model.baseUrl.replace(/\/+$/u, '') === baseUrl);
  };
}
