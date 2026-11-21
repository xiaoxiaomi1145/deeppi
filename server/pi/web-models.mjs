import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../private-json.mjs';
import { AppError, isLoopback, plainObject } from '../settings.mjs';

const fileName = 'web-models.json';
const limit = 24;
const protocols = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const modelPattern = /^[A-Za-z0-9_][A-Za-z0-9_.:/@+\-]{0,255}$/u;
const providerId = (slug) => `deeppi-web-${slug}`;

function modelConfig(input, previous) {
  const { slug, protocol, modelId, contextWindow, maxOutputTokens, reasoning } = input;
  if (typeof slug !== 'string' || slug.length > 48 || !slugPattern.test(slug)) throw new AppError(400, '配置标识仅允许小写字母、数字和短横线。');
  if (!protocols.has(protocol)) throw new AppError(400, '请选择支持的模型协议。');
  if (typeof modelId !== 'string' || !modelPattern.test(modelId) || modelId.endsWith('/') || modelId.includes('..')) throw new AppError(400, '模型 ID 格式无效。');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/u.test(name)) throw new AppError(400, '请输入 1 至 120 字的显示名称。');
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 4096 || contextWindow > 2_000_000 || !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 128 || maxOutputTokens > 200_000 || maxOutputTokens >= contextWindow) {
    throw new AppError(400, '上下文窗口须在 4,096–2,000,000 token，最大输出须在 128–200,000 token 且小于窗口。');
  }
  if (typeof reasoning !== 'boolean') throw new AppError(400, '思考能力选项无效。');
  let url;
  if (typeof input.baseUrl === 'string' && input.baseUrl.length <= 2048 && !/[\x00-\x20\x7f]/u.test(input.baseUrl)) {
    try { url = new URL(input.baseUrl); } catch { /* reported below */ }
  }
  if (!url || url.username || url.password || url.search || url.hash || /[?#]/u.test(input.baseUrl) ||
      (url.protocol !== 'https:' && (url.protocol !== 'http:' || !isLoopback(url.hostname)))) {
    throw new AppError(400, 'Base URL 须为无账号、参数或片段的 HTTPS 地址，或本机 HTTP。');
  }
  const baseUrl = url.href.replace(/\/+$/u, '');
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new AppError(400, 'API Key 格式无效。');
  let apiKey = input.apiKey?.trim();
  if (!apiKey && previous && previous.baseUrl === baseUrl && previous.protocol === protocol) apiKey = previous.apiKey;
  if (!apiKey) throw new AppError(400, '增加配置或更换协议、Base URL 时须输入该端点的 API Key。');
  // Pi interprets leading ! and dollar substitutions in provider config. Accept literal keys only.
  if (apiKey.length > 4096 || apiKey.startsWith('!') || /[$\x00-\x20\x7f]/u.test(apiKey)) throw new AppError(400, 'API Key 必须为单个字面值，不能使用命令或环境变量表达式。');
  return { slug, protocol, modelId, name, baseUrl, contextWindow, maxOutputTokens, reasoning, apiKey };
}

const modelRef = record => ({ provider: providerId(record.slug), id: record.modelId });
const publicModel = ({ apiKey, ...record }) => ({ ...record, ...modelRef(record), hasKey: Boolean(apiKey) });

export function createWebModels({ pi, agentDir }) {
  const dir = join(agentDir, 'deeppi');
  const records = new Map();
  let error;
  function register(record) {
    pi.registerProvider(providerId(record.slug), {
      name: record.name, baseUrl: record.baseUrl, api: record.protocol, apiKey: record.apiKey,
      models: [{ id: record.modelId, name: record.name, contextWindow: record.contextWindow, maxTokens: record.maxOutputTokens,
        reasoning: record.reasoning, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
  }
  function load() {
    const stored = readPrivateJson(join(dir, fileName), 256 * 1024);
    if (stored === undefined) return;
    if (stored?.version !== 1 || !Array.isArray(stored.models) || stored.models.length > limit) throw new Error('Invalid model store');
    const parsed = stored.models.map(record => {
      if (!plainObject(record)) throw new Error('Invalid model entry');
      return modelConfig(record);
    });
    if (new Set(parsed.map(model => model.slug)).size !== parsed.length) throw new Error('Duplicate model entry');
    for (const record of parsed) { register(record); records.set(record.slug, record); }
  }
  try { load(); } catch { error = '自定义模型配置无法读取，请检查 Pi 数据目录中的私有文件；未覆盖现有内容。'; }

  function persist(next) {
    try { writePrivateJson(dir, fileName, { version: 1, models: [...next.values()] }); }
    catch { throw new AppError(500, '无法保存自定义模型，请检查 Pi 数据目录与权限。'); }
  }
  function snapshot() { return { models: [...records.values()].map(publicModel), ...(error && { error }) }; }
  async function apply(input, selected) {
    if (error) throw new AppError(409, error);
    const previous = records.get(input.slug);
    const selectedProfile = previous !== undefined && selected?.provider === providerId(previous.slug);
    const next = new Map(records);
    if (input.action === 'remove') {
      if (!previous) throw new AppError(404, '找不到此自定义模型。');
      if (selectedProfile) throw new AppError(409, '请先切换当前模型，再移除此配置。');
      next.delete(input.slug);
      pi.unregisterProvider(providerId(previous.slug));
      try { persist(next); } catch (cause) { register(previous); throw cause; }
      records.delete(input.slug);
      return null;
    }
    if (input.action !== 'save' || (input.editing !== undefined && typeof input.editing !== 'boolean')) throw new AppError(400, '模型配置操作无效。');
    if (!input.editing && previous) throw new AppError(409, '已存在同名配置，请编辑或更换标识。');
    if (input.editing && !previous) throw new AppError(404, '找不到要编辑的自定义模型。');
    if (!previous && next.size >= limit) throw new AppError(409, '最多可保存 24 个自定义模型。');
    const record = modelConfig(input, previous);
    if (selectedProfile && record.modelId !== previous.modelId) throw new AppError(409, '修改当前模型的 ID 前，请先切换到其他模型。');
    next.set(record.slug, record);
    try { register(record); }
    catch { throw new AppError(400, 'Pi 未接受此模型配置，请检查协议与地址。'); }
    try { persist(next); } catch (cause) {
      if (previous) register(previous); else pi.unregisterProvider(providerId(record.slug));
      throw cause;
    }
    records.set(record.slug, record);
    return modelRef(record);
  }
  return { snapshot, apply };
}
