import { randomUUID } from 'node:crypto';
import { AppError, plainObject } from '../settings.mjs';
import { assistantView, projectBranch, toolView, toolViewId } from './transcript.mjs';

const settingsEntry = 'deeppi-web-settings';
const defaultLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ok = { ok: true };
const copyModel = model => ({ provider: model.provider, id: model.id, name: model.name || model.id });

function text(value, limit, label, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new AppError(400, `${label}格式无效。`);
  const clean = value.trim();
  if (!optional && !clean) throw new AppError(400, `${label}不能为空。`);
  return clean;
}

export function createPiHost({ pi, addons, resources, catalog, hub, thinkingLevels, clampThinking, allowEnvironmentModel, qq }) {
  let ctx, commands, scheduled, draft, startTimer, exclusive;
  let status = 'idle';
  let systemPrompt = '', lastError;
  let memoLeaf, memoManager, memoBranch = [];
  const pendingTools = new Map();

  const id = () => ctx?.sessionManager.getSessionId();
  const levels = model => model ? thinkingLevels?.(model) ?? (model.reasoning ? defaultLevels : ['off']) : ['off'];
  const realStatus = () => status === 'idle' && !ctx.isIdle() ? 'running' : status;
  const requireModel = () => {
    if (!ctx.model) throw new AppError(400, '请先在 Pi 中选择并配置模型。');
    if (allowEnvironmentModel && !allowEnvironmentModel(ctx.model)) {
      throw new AppError(400, '此模型配置了配套环境端点；请在 Pi 中选择 Deeppi 环境端点模型。');
    }
    return ctx.model;
  };
  const requireIdle = () => {
    if (exclusive || realStatus() !== 'idle') throw new AppError(409, '请等待 Pi 当前操作完成。');
  };
  const modelChoices = () => {
    const scoped = (ctx.scopedModels ?? []).map(item => item.model).filter(Boolean);
    const eligible = ctx.modelRegistry.getAvailable();
    const available = scoped.length ? scoped : eligible;
    const choices = new Map();
    for (const model of [...available, ...(ctx.model ? [ctx.model] : [])]) {
      if (allowEnvironmentModel && !allowEnvironmentModel(model)) continue;
      choices.set(`${model.provider}\n${model.id}`, model);
    }
    return [...choices.values()];
  };
  function resolveQqRoute(configuration, signal) {
    signal.throwIfAborted();
    const explicit = configuration.model;
    const model = explicit ? modelChoices().find(candidate => candidate.provider === explicit.provider && candidate.id === explicit.id) : requireModel();
    if (!model) throw new AppError(400, '所选 QQ 模型不可用，请在 Pi 中检查模型和凭据。');
    const requested = configuration.thinking === 'inherit' ? ctx.thinkingLevel ?? pi.getThinkingLevel() : configuration.thinking;
    const registry = ctx.modelRegistry;
    return { model, thinking: clampThinking?.(model, requested) ?? (levels(model).includes(requested) ? requested : 'off'),
      stream: (request, context, options) => registry.streamSimple(request, context, options) };
  }
  function savedSettings() {
    const entry = ctx.sessionManager.getBranch().findLast(item => item.type === 'custom' && item.customType === settingsEntry);
    systemPrompt = typeof entry?.data?.systemPrompt === 'string' ? entry.data.systemPrompt.slice(0, 32_000) : '';
  }

  function messages() {
    const manager = ctx.sessionManager;
    const leaf = manager.getLeafId();
    if (manager !== memoManager || leaf !== memoLeaf) {
      memoManager = manager;
      memoLeaf = leaf;
      memoBranch = projectBranch(manager.getBranch());
    }
    const committed = new Set(memoBranch.map(message => message.id));
    return [...memoBranch, ...(draft ? [draft] : []), ...[...pendingTools.values()].filter(tool => !committed.has(tool.id))];
  }

  function snapshot() {
    const timeline = messages();
    const active = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().map(tool => ({ name: tool.name, description: tool.description ?? '',
      active: active.has(tool.name), exposure: typeof tool.exposure === 'string' ? tool.exposure : undefined }));
    const context = ctx.getContextUsage();
    return {
      id: id(), title: pi.getSessionName() || timeline.find(message => message.role === 'user')?.text.trim().replace(/\s+/gu, ' ').slice(0, 70) || '当前 Pi 会话',
      cwd: ctx.cwd, status: realStatus(), connected: true,
      model: ctx.model ? copyModel(ctx.model) : null,
      models: modelChoices().map(model => ({ ...copyModel(model), reasoning: Boolean(model.reasoning),
        contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens, levels: levels(model) })),
      thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(), levels: levels(ctx.model), systemPrompt, tools,
      ...resources.snapshot(ctx, tools), messages: timeline,
      context: { tokens: context?.tokens ?? null, window: context?.contextWindow ?? ctx.model?.contextWindow ?? null },
      addons: addons.snapshot(), error: lastError,
    };
  }

  function publish() {
    if (scheduled || !hub.isBound(host)) return;
    // Pi callbacks can run before the leaf and tool results have been committed.
    scheduled = setImmediate(() => {
      scheduled = undefined;
      if (hub.isBound(host)) hub.publishState(host);
    });
  }
  function idle() {
    clearTimeout(startTimer);
    status = 'idle';
    draft = undefined;
    pendingTools.clear();
    publish();
  }
  function attach(current) {
    ctx = current;
    savedSettings();
    hub.bind(host);
    return qq?.attach(resolveQqRoute);
  }
  function bindCommands(commandContext) {
    if (commandContext.sessionManager.getSessionId() === id()) commands = commandContext;
  }

  function prompt(input) {
    requireModel();
    if (exclusive || status === 'compacting' || status === 'stopping') throw new AppError(409, '请等待 Pi 当前操作完成。');
    const clean = text(input.text, 120_000, '消息');
    if (input.mode !== undefined && input.mode !== 'steer' && input.mode !== 'followUp') throw new AppError(400, '发送方式无效。');
    if (realStatus() !== 'idle' && !input.mode) throw new AppError(409, 'Pi 正在生成，请选择立即引导或下轮发送。');
    const skill = text(input.skill, 128, '技能', true);
    if (skill && !resources.skills().some(entry => entry.name === skill)) throw new AppError(400, '技能不属于当前 Pi 会话。');
    lastError = undefined;
    if (realStatus() === 'idle') {
      status = 'running';
      startTimer = setTimeout(() => {
        if (ctx.isIdle()) {
          lastError = 'Pi 未开始生成，请查看终端中的模型、凭据或输入处理状态。';
          idle();
        }
      }, 3500);
      startTimer.unref();
    }
    const value = skill ? `/skill:${skill} ${clean}` : clean;
    const options = { deliverAs: input.mode, expandPromptTemplates: Boolean(skill) };
    try {
      const sent = commands?.sendUserMessage ? commands.sendUserMessage(value, options) : pi.sendUserMessage(value, options);
      void sent?.catch(() => {
        if (!hub.isBound(host)) return;
        lastError = 'Pi 未能发送消息，请查看终端。';
        idle();
      });
    } catch {
      idle();
      throw new AppError(409, 'Pi 未接受此消息，请查看终端。');
    }
    publish();
    return ok;
  }

  function stop() {
    if (realStatus() !== 'idle') {
      status = 'stopping';
      ctx.abort();
      publish();
      // A preflight or native extension UI prompt may end without agent_settled.
      const timer = setTimeout(() => { if (hub.isBound(host) && status === 'stopping' && ctx.isIdle()) idle(); }, 400);
      timer.unref();
    }
    return ok;
  }

  function compact(input) {
    requireIdle();
    requireModel();
    const focus = text(input.focus, 8000, '压缩关注点', true);
    if (input.enhanced !== undefined && typeof input.enhanced !== 'boolean') throw new AppError(400, '压缩模式无效。');
    if (input.enhanced && !addons.snapshot().compact) throw new AppError(403, '请先启用 Deeppi 增强压缩。');
    lastError = undefined;
    status = 'compacting';
    try {
      ctx.compact({ customInstructions: input.enhanced ? addons.compactInstructions(focus) : focus,
        onComplete: idle, onError: () => { lastError = 'Pi 压缩失败或已停止，详情见终端。'; idle(); } });
    } catch { idle(); throw new AppError(409, 'Pi 无法压缩当前会话。'); }
    publish();
    return ok;
  }

  async function probe(signal) {
    const model = requireModel();
    const timeout = AbortSignal.timeout(10_000);
    const combined = AbortSignal.any([signal, timeout]);
    const messages = [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }];
    const aborted = () => {
      if (signal.aborted) signal.throwIfAborted();
      if (timeout.aborted) throw new AppError(504, 'Pi 模型连接测试超时。');
    };
    try {
      aborted();
      const answer = await ctx.modelRegistry.streamSimple(model, { messages }, { maxTokens: 32,
        reasoning: 'off', cacheRetention: 'none', timeoutMs: 10_000, maxRetryDelayMs: 0, maxRetries: 0, signal: combined }).result();
      aborted();
      if (answer.stopReason === 'error' || answer.stopReason === 'aborted') throw new Error('model rejected probe');
      return { model: model.id };
    } catch {
      aborted();
      throw new AppError(502, 'Pi 模型未通过连接测试。请检查终端中的认证和服务端点。');
    }
  }

  async function settings(patch) {
    const title = text(patch.title, 200, '标题', true);
    const promptText = text(patch.systemPrompt, 32_000, '系统提示词补充', true);
    let model;
    if (patch.model !== undefined) {
      if (!plainObject(patch.model)) throw new AppError(400, '模型不可用。');
      model = modelChoices().find(value => value.provider === patch.model.provider && value.id === patch.model.id);
      if (!model) throw new AppError(400, '模型不可用。');
    }
    if (patch.thinking !== undefined && !levels(model ?? ctx.model).includes(patch.thinking)) {
      throw new AppError(400, '当前模型不支持该思考强度。');
    }
    if (patch.activeTools !== undefined) {
      const names = new Set(pi.getAllTools().map(tool => tool.name));
      if (!Array.isArray(patch.activeTools) || patch.activeTools.length > names.size || patch.activeTools.some(name => !names.has(name))) {
        throw new AppError(400, '工具列表包含当前 Pi 会话未注册的名称。');
      }
    }
    if (model && !await pi.setModel(model)) throw new AppError(400, 'Pi 未能选择该模型，请检查认证。');
    if (patch.thinking !== undefined) pi.setThinkingLevel(patch.thinking);
    if (patch.activeTools) pi.setActiveTools([...new Set(patch.activeTools)]);
    if (title !== undefined) pi.setSessionName(title);
    if (promptText !== undefined) {
      pi.appendEntry(settingsEntry, { systemPrompt: promptText });
      systemPrompt = promptText;
    }
    return ok;
  }

  async function switchSession(input, signal) {
    const target = text(input.id, 120, '会话 ID');
    if (target === id()) return ok;
    if (!commands) throw new AppError(409, '请在当前 Pi 终端运行 /deeppi，授权网页切换会话。');
    const known = await catalog.resolve(ctx, target, signal);
    signal.throwIfAborted();
    if (!hub.isBound(host) || realStatus() !== 'idle') throw new AppError(409, 'Pi 会话已经改变或正在运行。');
    const changed = await commands.switchSession(known.path, { withSession: async replacement => hub.bindCommands(replacement) });
    if (changed.cancelled) throw new AppError(409, 'Pi 取消了会话切换。');
    return ok;
  }

  async function action(name, input, signal) {
    if (name === 'prompt') return prompt(input);
    if (name === 'stop') return stop();
    if (name === 'compact') return compact(input);
    if (name === 'probe') return probe(signal);
    if (name === 'qq' || name === 'qqprobe' || name === 'qqreset') {
      if (!qq) throw new AppError(503, 'QQ 附件未加载。');
      if (name === 'qqprobe') return qq.probe(signal);
      if (name === 'qqreset') return qq.reset(input.id);
      if (input.model && !modelChoices().some(model => model.provider === input.model.provider && model.id === input.model.id)) {
        throw new AppError(400, '所选 QQ 模型不在当前 Pi 模型目录中。');
      }
      return qq.update(input, signal);
    }
    if (!['settings', 'resources', 'addons', 'switch'].includes(name)) throw new AppError(404, '接口不存在。');
    requireIdle();
    exclusive = name;
    try {
      if (name === 'settings') return await settings(input);
      if (name === 'switch') return await switchSession(input, signal);
      if (name === 'resources') return await resources.apply(ctx, input);
      await addons.update(ctx, input);
      return ok;
    } finally { exclusive = undefined; publish(); }
  }

  const host = { snapshot, action, bindCommands, id, catalog: signal => catalog.list(ctx, signal), history: (target, signal) => catalog.history(ctx, target, signal),
    qqSnapshot: () => { if (!qq) throw new AppError(503, 'QQ 附件未加载。'); return qq.snapshot(); } };
  pi.on('session_start', (_event, current) => attach(current));
  pi.on('session_shutdown', event => {
    clearImmediate(scheduled);
    clearTimeout(startTimer);
    hub.detach(host, event.reason);
    return qq?.detach(resolveQqRoute, event.reason);
  });
  pi.on('session_tree', () => { savedSettings(); publish(); });
  pi.on('before_agent_start', event => {
    clearTimeout(startTimer);
    if (systemPrompt) {
      const options = event.systemPromptOptions;
      options.appendSystemPrompt = [options.appendSystemPrompt, systemPrompt].filter(Boolean).join('\n\n');
    }
  });
  pi.on('agent_start', () => { clearTimeout(startTimer); status = 'running'; lastError = undefined; publish(); });
  pi.on('message_start', ({ message }) => {
    if (message.role === 'assistant') draft = assistantView(message, `draft:${randomUUID()}`, true);
    publish();
  });
  pi.on('message_update', ({ message, assistantMessageEvent: chunk }) => {
    if (message.role !== 'assistant' || !draft) return;
    draft = assistantView(message, draft.id, true);
    if (chunk.type === 'text_delta' || chunk.type === 'thinking_delta') {
      hub.publish(host, 'delta', { messageId: draft.id, [chunk.type === 'text_delta' ? 'text' : 'thinking']: chunk.delta });
    }
  });
  pi.on('message_end', ({ message }) => {
    if (message.role === 'assistant') {
      draft = undefined;
      if (message.stopReason === 'error') lastError = 'Pi 生成失败，请查看终端中的服务商错误。';
    } else if (message.role === 'toolResult') pendingTools.delete(toolViewId(message.toolCallId));
    publish();
  });
  pi.on('tool_execution_start', event => {
    if (event.parentToolCallId) return;
    const view = toolView({ id: event.toolCallId, name: event.toolName, args: event.args, timestamp: Date.now(), state: 'running' });
    pendingTools.set(view.id, view);
    publish();
  });
  pi.on('tool_execution_end', event => {
    const view = pendingTools.get(toolViewId(event.toolCallId));
    if (view) pendingTools.set(view.id, { ...toolView({ id: event.toolCallId, name: view.name,
      timestamp: view.timestamp, content: event.result?.content, state: event.isError ? 'error' : 'done' }), args: view.args });
    publish();
  });
  pi.on('agent_settled', idle);
  pi.events.on('deeppi:addons-changed', publish);
  for (const event of ['session_info_changed', 'session_compact', 'session_compact_failed', 'model_select', 'thinking_level_select', 'mcp_servers_change']) pi.on(event, publish);
  return host;
}
