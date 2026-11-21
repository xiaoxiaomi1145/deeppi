import { AppError, isLoopback, plainObject } from '../settings.mjs';

export const qqId = value => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) return '';
  return (typeof value === 'string' || typeof value === 'number') && /^[1-9][0-9]{0,19}$/u.test(String(value)) ? String(value) : '';
};

const choices = {
  transport: ['ws', 'http'], privateEnabled: [true, false], groupEnabled: [true, false],
  enabled: [true, false], listen: [true, false], stickers: [true, false], compact: [true, false],
  groupTrigger: ['mention', 'prefix', 'all'], groupContext: ['shared', 'per-user'],
  userMode: ['all', 'allowlist'], groupMode: ['all', 'allowlist'],
  thinking: ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive'],
  cacheRetention: ['none', 'short', 'long'],
};
const bounds = {
  port: [0, 65_535], contextLimit: [4096, 262_144], compactThreshold: [512, 261_632],
  keepRecentTokens: [128, 131_072], maxOutputTokens: [128, 16_384], cooldownMs: [0, 60_000],
};
const idLists = new Set(['userAllow', 'userDeny', 'groupAllow', 'groupDeny', 'toolUsers']);
const extraToolIds = ['local_time', 'text_count'];
const secrets = ['wsToken', 'httpSecret', 'httpToken'];

export function defaultQqSettings() {
  return {
    enabled: false, listen: false, transport: 'ws', port: 6199, botId: '', httpApiUrl: '', wsToken: '', httpSecret: '', httpToken: '',
    model: null, thinking: 'inherit', privateEnabled: true, groupEnabled: false, groupTrigger: 'mention', prefix: '/ai', groupContext: 'shared',
    userMode: 'all', userAllow: [], userDeny: [], groupMode: 'allowlist', groupAllow: [], groupDeny: [], toolUsers: [], extraTools: [],
    systemPrompt: '', contextLimit: 16_384, compactThreshold: 11_264, keepRecentTokens: 4096, maxOutputTokens: 1024,
    compact: true, stickers: false, cacheRetention: 'short', cooldownMs: 1500,
  };
}

function fail(name) { throw new AppError(400, `QQ 设置「${name}」的值无效。`); }

function cleanText(value, limit, name) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) fail(name);
  return value.trim();
}

function apiUrl(value) {
  const raw = cleanText(value, 2048, 'HTTP API 地址');
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { fail('HTTP API 地址'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !isLoopback(url.hostname))) fail('HTTP API 地址，仅限 HTTPS 或本机 HTTP');
  return url.href.replace(/\/+$/u, '');
}

export function updateQqSettings(current, patch) {
  if (!plainObject(patch)) fail('配置');
  const next = { ...current };
  for (const [name, value] of Object.entries(patch)) {
    if (Object.hasOwn(choices, name)) {
      if (!choices[name].includes(value)) fail(name);
      next[name] = value;
    } else if (Object.hasOwn(bounds, name)) {
      const [min, max] = bounds[name];
      if (!Number.isInteger(value) || value < min || value > max) fail(`${name}（${min}–${max}）`);
      next[name] = value;
    } else if (idLists.has(name)) {
      if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !qqId(id))) fail(name);
      next[name] = [...new Set(value)];
    } else if (secrets.includes(name)) {
      const secret = cleanText(value, 512, name);
      if (secret && (secret.length < 8 || !/^[\x21-\x7e]+$/u.test(secret))) fail(`${name}（至少八位可见字符）`);
      next[name] = secret;
    } else if (name === 'botId') {
      const valueId = cleanText(value, 20, '机器人 QQ 号');
      if (valueId && !qqId(valueId)) fail('机器人 QQ 号');
      next.botId = valueId;
    } else if (name === 'httpApiUrl') {
      next.httpApiUrl = apiUrl(value);
    } else if (name === 'model') {
      if (value === null) next.model = null;
      else {
        if (!plainObject(value)) fail('模型');
        const provider = cleanText(value.provider, 200, '服务商');
        const id = cleanText(value.id, 300, '模型 ID');
        if (!provider || !id || /[\r\n]/u.test(provider + id)) fail('模型');
        next.model = { provider, id };
      }
    } else if (name === 'extraTools') {
      if (!Array.isArray(value) || value.length > extraToolIds.length || value.some(tool => !extraToolIds.includes(tool))) fail('额外工具');
      next.extraTools = extraToolIds.filter(tool => value.includes(tool));
    } else if (name === 'systemPrompt') {
      next.systemPrompt = cleanText(value, 4000, 'QQ 系统提示词');
    } else if (name === 'prefix') {
      const prefix = cleanText(value, 24, '群触发前缀');
      if (!prefix || /\s|[\x00-\x1f\x7f]/u.test(prefix)) fail('群触发前缀');
      next.prefix = prefix;
    } else {
      throw new AppError(400, 'QQ 设置包含不识别的字段。');
    }
  }
  if (next.listen || next.enabled) {
    if (!next.botId) throw new AppError(400, '监听前请填写机器人 QQ 号。');
    if (next.transport === 'ws' && !next.wsToken) throw new AppError(400, '监听反向 WebSocket 前请设置 Token。');
    if (next.transport === 'http' && (!next.httpSecret || !next.httpApiUrl)) {
      throw new AppError(400, '监听反向 HTTP 前请设置签名密钥和 OneBot HTTP API 地址。');
    }
    if (next.transport === 'http' && !isLoopback(new URL(next.httpApiUrl).hostname) && !next.httpToken) {
      throw new AppError(400, '使用非本机 OneBot HTTP API 时需要访问 Token。');
    }
  }
  // Clamp the dependent values when shrinking a window, without requiring a
  // separate edit for each slider or rejecting an otherwise valid configuration.
  next.maxOutputTokens = Math.min(next.maxOutputTokens, Math.floor(next.contextLimit / 2));
  next.compactThreshold = Math.min(next.compactThreshold, next.contextLimit - next.maxOutputTokens - 256);
  next.keepRecentTokens = Math.min(next.keepRecentTokens, next.compactThreshold);
  return next;
}

export function publicQqSettings(settings) {
  const { wsToken, httpSecret, httpToken, ...publicSettings } = settings;
  return { ...publicSettings, hasWsToken: Boolean(wsToken), hasHttpSecret: Boolean(httpSecret), hasHttpToken: Boolean(httpToken) };
}

export function transportSettings(settings) {
  const { transport, port, botId, wsToken, httpSecret, httpApiUrl, httpToken } = settings;
  return { transport, port, botId, wsToken, httpSecret, httpApiUrl, httpToken };
}
