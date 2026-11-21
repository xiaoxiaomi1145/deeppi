import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const PROVIDERS = {
  deepseek: { url: 'https://api.deepseek.com', key: 'DEEPSEEK_API_KEY' },
  'openai-compatible': { url: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  anthropic: { url: 'https://api.anthropic.com', key: 'ANTHROPIC_API_KEY' },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta', key: 'GEMINI_API_KEY', fallbackKey: 'GOOGLE_API_KEY' },
  mistral: { url: 'https://api.mistral.ai', key: 'MISTRAL_API_KEY' },
  azure: { url: '', key: 'AZURE_OPENAI_API_KEY' },
  demo: { url: '', key: '' },
};

export const isLoopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

export function defaults(workspace, demo) {
  return {
    provider: demo ? 'demo' : 'deepseek',
    baseUrl: '',
    model: demo ? 'deeppi-demo' : 'deepseek-flash',
    systemPrompt: '',
    cwd: workspace,
    thinkingLevel: 'off',
    temperature: null,
    contextWindow: 65_536,
    maxOutputTokens: 8192,
    maxTurns: 16,
    autoCompact: true,
    keepRecentTokens: 12_000,
    allowBash: false,
    bashTimeoutMs: 60_000,
    maxToolOutput: 12_000,
    maxSubagents: 2,
    subagentModel: '',
  };
}

export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function directory(path) {
  if (typeof path === 'string' && isAbsolute(path)) {
    try {
      const resolved = realpathSync(path);
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Report the setting name without exposing any internal error details.
    }
  }
  throw new AppError(400, '工作目录必须是存在且可访问的绝对路径。');
}

const integers = {
  contextWindow: [4096, 2_000_000],
  maxOutputTokens: [256, 200_000],
  maxTurns: [1, 64],
  keepRecentTokens: [256, 500_000],
  bashTimeoutMs: [100, 900_000],
  maxToolOutput: [256, 100_000],
  maxSubagents: [0, 8],
};
const textFields = { model: 256, subagentModel: 256, systemPrompt: 32_000, cwd: 4096, baseUrl: 2048 };

function parseBaseUrl(value) {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))) return url;
  } catch { /* invalid URL */ }
  return undefined;
}

const formatBaseUrl = url => url.href.replace(/\/+$/u, '');

const envGroups = {
  deepseek: ['DEEPSEEK'], 'openai-compatible': ['OPENAI'], anthropic: ['ANTHROPIC'],
  google: ['GEMINI', 'GOOGLE'], mistral: ['MISTRAL'], azure: ['AZURE_OPENAI'],
};
const envValue = (env, name) => typeof env[name] === 'string' ? env[name].trim() : '';

// A URL and its key form a credential scope. Never fall back to the official host
// when a nonempty configured URL is invalid, or reuse the Gemini key for a Google gateway.
export function environmentRoute(provider, env = process.env) {
  if (!Object.hasOwn(PROVIDERS, provider) || provider === 'demo') return { baseUrl: '', custom: false };
  const info = PROVIDERS[provider];
  for (const prefix of envGroups[provider]) {
    const names = ['BASE_URL', 'API_BASE_URL', 'API_URL', 'API_BASE'].map(suffix => `${prefix}_${suffix}`);
    if (provider === 'azure') names.push('AZURE_OPENAI_ENDPOINT');
    const configured = names.map(name => envValue(env, name)).find(Boolean);
    if (configured) {
      const url = parseBaseUrl(configured);
      const valid = url && (provider !== 'azure' || (url.protocol === 'https:' && !isLoopback(url.hostname)));
      return { baseUrl: valid ? formatBaseUrl(url) : '', keyName: `${prefix}_API_KEY`, custom: true };
    }
  }
  if (provider === 'azure') {
    const resource = envValue(env, 'AZURE_OPENAI_RESOURCE_NAME').toLowerCase();
    const baseUrl = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(resource)
      ? `https://${resource}.openai.azure.com/openai/v1` : '';
    return { baseUrl, keyName: info.key, custom: Boolean(resource) };
  }
  const keyName = envValue(env, info.key) || !info.fallbackKey ? info.key : info.fallbackKey;
  return { baseUrl: info.url, keyName, custom: false };
}

export const effectiveUrl = settings => settings.baseUrl || environmentRoute(settings.provider).baseUrl;
export const credentialScope = settings => `${settings.provider}\n${effectiveUrl(settings)}`;

export function updateSettings(current, patch, demo) {
  if (!plainObject(patch)) throw new AppError(400, '设置必须是一个对象。');
  const next = { ...current };
  for (const [name, value] of Object.entries(patch)) {
    if (Object.hasOwn(integers, name)) {
      const [min, max] = integers[name];
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new AppError(400, `${name} 必须是 ${min} 到 ${max} 的整数。`);
      }
    } else if (Object.hasOwn(textFields, name)) {
      if (typeof value !== 'string' || value.length > textFields[name] || value.includes('\0')) {
        throw new AppError(400, `${name} 格式无效。`);
      }
    } else if (name === 'provider') {
      if (!Object.hasOwn(PROVIDERS, value) || (value === 'demo' && !demo) || typeof value !== 'string') {
        throw new AppError(400, '服务商无效。');
      }
    } else if (name === 'thinkingLevel') {
      if (!['off', 'low', 'medium', 'high', 'max'].includes(value)) throw new AppError(400, '思考强度无效。');
    } else if (name === 'allowBash' || name === 'autoCompact') {
      if (typeof value !== 'boolean') throw new AppError(400, `${name} 必须是布尔值。`);
    } else if (name === 'temperature') {
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 2)) {
        throw new AppError(400, '采样温度必须在 0 到 2 之间。');
      }
    } else {
      throw new AppError(400, `未知设置：${name}`);
    }
    next[name] = value;
  }
  next.model = next.model.trim();
  next.subagentModel = next.subagentModel.trim();
  if (!next.model || /[\x00-\x20\x7f]/u.test(next.model) || /[\x00-\x20\x7f]/u.test(next.subagentModel)) {
    throw new AppError(400, '请输入有效的模型 ID。');
  }
  if (Object.hasOwn(patch, 'cwd')) next.cwd = directory(next.cwd);
  next.baseUrl = next.baseUrl.trim();
  if (next.baseUrl) {
    const url = parseBaseUrl(next.baseUrl);
    if (!url) throw new AppError(400, 'Base URL 需要使用 HTTPS，或使用 HTTP 连接本机地址。');
    next.baseUrl = formatBaseUrl(url);
  }
  if (next.maxOutputTokens + 1024 > next.contextWindow) {
    throw new AppError(400, '上下文窗口至少应比输出上限多 1024 tokens。');
  }
  return next;
}

export function updateCredential(current, next, key, patch) {
  if (!Object.hasOwn(patch, 'apiKey')) return credentialScope(current) === credentialScope(next) ? key : undefined;
  if (patch.apiKey === null) return undefined;
  const candidate = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (!candidate || candidate.length > 4096 || /[\x00-\x20\x7f]/u.test(candidate)) {
    throw new AppError(400, 'API Key 格式无效。');
  }
  return candidate;
}

export function googleCloudMode() {
  // Match the Node GenAI SDK's precedence; Pi does not override these flags.
  return (process.env.GOOGLE_GENAI_USE_ENTERPRISE ?? process.env.GOOGLE_GENAI_USE_VERTEXAI)
    ?.trim().toLowerCase() === 'true';
}

export function connectionStatus(settings, override) {
  if (settings.provider === 'demo') return 'demo';
  if (settings.provider === 'google' && googleCloudMode()) return 'missing';
  const url = parseBaseUrl(effectiveUrl(settings));
  return url && (resolveKey(settings, override) || isLoopback(url.hostname)) ? 'configured' : 'missing';
}

export function resolveKey(settings, override) {
  if (settings.provider === 'demo') return undefined;
  const endpoint = parseBaseUrl(effectiveUrl(settings));
  if (!endpoint) return undefined;
  if (override) return override;
  // An environment credential is only valid at the administrator's configured origin.
  const { baseUrl, keyName } = environmentRoute(settings.provider);
  if (!keyName || endpoint.origin !== parseBaseUrl(baseUrl)?.origin) return undefined;
  return envValue(process.env, keyName) || undefined;
}
