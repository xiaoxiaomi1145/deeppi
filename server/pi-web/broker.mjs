import { randomUUID } from 'node:crypto';
import { AppError } from '../settings.mjs';
import { assistantView, projectBranch, textContent, toolView, toolViewId } from '../pi/transcript.mjs';
import { expandSkillMentions, webCommands } from '../pi/web-input.mjs';
import { archiveBranch, sessionTitle } from './catalog.mjs';
import { createPiRpcWorker } from './rpc-worker.mjs';

const commandNames = new Set(['context', 'settings', 'model', 'thinking', 'name', 'new', 'resume', 'compact', 'stop', 'help']);
const slashPattern = /^\/([\w][\w.:-]*)(?:\s+([\s\S]*))?$/u;
const brief = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const validModel = model => model && model.provider && model.id && !(model.provider === 'unknown' && model.id === 'unknown');
const publicModel = model => validModel(model) ? {
  provider: brief(model.provider, 256), id: brief(model.id, 256), name: brief(model.name, 256) || brief(model.id, 256),
  contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
} : null;
const stripFrontmatter = text => text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, '');

function replaceMessage(messages, message) {
  const index = messages.findLastIndex(item => item.id === message.id);
  return index < 0 ? [...messages, message] : messages.with(index, message);
}

export function createPiWebBroker({ catalog, cli, workerFactory = createPiRpcWorker, sessionDir, env = process.env }) {
  const listeners = new Set();
  const localCommands = webCommands([]).filter(command => commandNames.has(command.name));
  let active;
  let candidate;
  let transition = false;
  let closed = false;
  let shutdown;
  let view = {
    generation: 0, id: '', cwd: catalog.selected(), title: '', connected: false, switching: false, status: 'idle',
    model: null, models: [], thinking: 'off', levels: [], commands: localCommands, skills: [], messages: [],
    autoCompaction: true, pendingMessageCount: 0,
  };

  function emit(event, data) {
    for (const listener of listeners) listener(event, data);
  }
  function commit(patch) {
    view = { ...view, ...patch };
    if (!closed) emit('state', view);
  }
  function matches(slot) { return !closed && active === slot && !slot.exited; }
  function failed(slot) {
    slot.exited = true;
    if (active !== slot) return;
    active = undefined;
    commit({ connected: false, status: 'idle', pendingMessageCount: 0, error: 'Pi 进程已断开。可重新打开会话继续。' });
  }
  function assertIdle() {
    if (transition || view.status !== 'idle' || view.pendingMessageCount > 0 || active?.mutating) {
      throw new AppError(409, '请先结束当前 Pi 操作和排队消息。');
    }
  }
  function requireSlot(body) {
    if (transition) throw new AppError(409, 'Pi 正在切换会话。');
    if (!active || !view.connected) throw new AppError(409, '请先新建或打开一个 Pi 会话。');
    if (body.generation !== view.generation) throw new AppError(409, '当前会话已切换，请在新会话中重新操作。');
    return active;
  }
  function syncNative(state) {
    const status = state.isCompacting ? 'compacting' : state.isStreaming ? 'running' : 'idle';
    return { model: publicModel(state.model), status, pendingMessageCount: state.pendingMessageCount ?? 0,
      thinking: brief(state.thinkingLevel, 32) || 'off', autoCompaction: state.autoCompactionEnabled === true };
  }
  function loadedMessages(entries) {
    if (!Array.isArray(entries?.entries)) throw new AppError(502, 'Pi 未返回可读取的会话历史，请使用 Pi 1.6 或兼容版本。');
    return projectBranch(archiveBranch(entries.entries, entries.leafId));
  }
  function rememberFile(slot, state) {
    try { catalog.observeFile(slot.row.cwd, slot.row.id, state.sessionFile); }
    catch { /* The native archive remains available. Metadata can be refreshed on the next opening. */ }
  }
  async function reconcile(slot) {
    const serial = slot.serial;
    try {
      const state = await slot.worker.request('get_state');
      if (!matches(slot) || serial !== slot.serial) return;
      if (state.sessionId !== slot.row.id) {
        failed(slot);
        void slot.worker.close();
        return;
      }
      if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
        commit({ ...syncNative(state), status: state.isCompacting ? 'compacting' : 'running' });
        return;
      }
      const entries = await slot.worker.request('get_entries');
      if (!matches(slot) || serial !== slot.serial) return;
      rememberFile(slot, state);
      commit({ ...syncNative(state), title: brief(state.sessionName, 120) || view.title, messages: loadedMessages(entries) });
    } catch {
      if (matches(slot) && serial === slot.serial) commit({ status: 'idle', pendingMessageCount: 0, error: 'Pi 历史同步失败。可重新打开会话。' });
    }
  }

  function onEvent(slot, event) {
    if (!matches(slot)) return;
    const message = event.message;
    switch (event.type) {
      case 'agent_start':
        slot.serial++;
        commit({ status: 'running', error: undefined });
        break;
      case 'message_start': {
        slot.serial++;
        if (message?.role === 'user') commit({ status: 'running', messages: [...view.messages, {
          id: `live-${randomUUID()}`, role: 'user', text: textContent(message.content), timestamp: message.timestamp ?? Date.now(),
        }] });
        if (message?.role === 'assistant') {
          slot.draft = assistantView(message, `live-${randomUUID()}`, true);
          commit({ status: 'running', messages: [...view.messages, slot.draft] });
        }
        break;
      }
      case 'message_update': {
        const update = event.assistantMessageEvent;
        const field = update?.type === 'text_delta' ? 'text' : update?.type === 'thinking_delta' ? 'thinking' : null;
        if (!field || typeof update.delta !== 'string' || !slot.draft) break;
        slot.draft = { ...slot.draft, [field]: (slot.draft[field] ?? '') + update.delta };
        view = { ...view, messages: replaceMessage(view.messages, slot.draft) };
        emit('delta', { generation: view.generation, messageId: slot.draft.id, [field]: update.delta });
        break;
      }
      case 'message_end':
        if (message?.role === 'assistant' && slot.draft) {
          commit({ messages: replaceMessage(view.messages, assistantView(message, slot.draft.id)),
            ...(message.stopReason === 'error' && { error: 'Pi 模型请求失败。请检查当前模型和本机 Pi 配置。' }) });
          slot.draft = undefined;
        }
        break;
      case 'tool_execution_start':
        if (typeof event.toolCallId !== 'string') break;
        slot.calls.set(event.toolCallId, event.args);
        commit({ messages: replaceMessage(view.messages, toolView({ id: event.toolCallId, name: event.toolName,
          args: event.args, timestamp: Date.now(), state: 'running' })) });
        break;
      case 'tool_execution_end':
        if (typeof event.toolCallId !== 'string') break;
        commit({ messages: replaceMessage(view.messages, toolView({ id: event.toolCallId, name: event.toolName,
          args: slot.calls.get(event.toolCallId), content: event.result?.content, timestamp: Date.now(), state: event.isError ? 'error' : 'done' })) });
        slot.calls.delete(event.toolCallId);
        break;
      case 'auto_compaction_start':
        commit({ status: 'compacting' });
        break;
      case 'auto_compaction_end':
      case 'agent_settled':
        void reconcile(slot);
        break;
    }
  }

  async function launch(row) {
    const worker = workerFactory({ cli, cwd: row.cwd, sessionPath: row.path, sessionId: row.id, sessionDir, env });
    const slot = { worker, row, serial: 0, calls: new Map() };
    candidate = slot;
    worker.onExit(() => failed(slot));
    worker.onEvent(event => onEvent(slot, event));
    try {
      let native = await worker.request('get_state');
      if (native?.sessionId !== row.id) throw new AppError(502, 'Pi 未打开指定会话，请检查 Pi 版本和会话配置。');
      if (!row.path && row.title !== '新会话' && native.sessionName !== row.title) {
        await worker.request('set_session_name', { name: row.title });
        native = { ...native, sessionName: row.title };
      }
      const [{ models }, { levels }, { commands }, entries] = await Promise.all([
        worker.request('get_available_models'), worker.request('get_available_thinking_levels'),
        worker.request('get_commands'), worker.request('get_entries'),
      ]);
      if (closed || slot.exited) throw new AppError(503, 'Pi 进程已关闭。');
      slot.commands = Array.isArray(commands) ? commands : [];
      const available = webCommands(slot.commands).filter(command => command.kind !== 'native' || commandNames.has(command.name));
      const messages = loadedMessages(entries);
      rememberFile(slot, native);
      active = slot;
      commit({ ...syncNative(native), generation: view.generation + 1, id: row.id, cwd: row.cwd,
        title: brief(native.sessionName, 120) || row.title, connected: true, switching: false, error: undefined,
        models: Array.isArray(models) ? models.map(publicModel).filter(Boolean) : [],
        levels: Array.isArray(levels) ? levels.filter(value => typeof value === 'string') : [], commands: available,
        skills: available.filter(command => command.kind === 'skill').map(command => ({ name: command.name.replace(/^skill:/u, ''), description: command.description ?? '' })),
        messages,
      });
    } catch (error) {
      await worker.close();
      if (error instanceof AppError) throw error;
      throw new AppError(502, '无法初始化 Pi RPC 会话，请检查 Pi 版本和本机配置。');
    } finally { candidate = undefined; }
  }

  async function replace(rowFor) {
    if (closed) throw new AppError(503, 'Pi Web 正在关闭。');
    assertIdle();
    transition = true;
    commit({ switching: true });
    try {
      const row = await rowFor();
      if (closed) throw new AppError(503, 'Pi Web 正在关闭。');
      if (active?.row.id === row.id && active.row.cwd === row.cwd) return;
      const previous = active;
      active = undefined;
      await previous?.worker.close();
      try { await launch(row); }
      catch (error) {
        if (previous && !closed) {
          try { await launch(await catalog.resolve(previous.row.cwd, previous.row.id)); }
          catch { /* Retain the previous view as read-only if restarting it also fails. */ }
        }
        if (!active) commit({ connected: false, error: error.message });
        throw error;
      }
    } finally {
      transition = false;
      if (view.switching) commit({ switching: false });
    }
  }

  async function prompt(body) {
    const slot = requireSlot(body);
    if (slot.mutating || !['idle', 'running'].includes(view.status)) throw new AppError(409, 'Pi 当前操作结束后才能发送。');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 128_000) throw new AppError(400, '请输入 1–128000 个字符的消息。');
    if (body.mode !== undefined && !['steer', 'followUp'].includes(body.mode)) throw new AppError(400, '发送方式无效。');
    const text = body.text.trim();
    const slash = slashPattern.exec(text);
    if (slash && !view.commands.some(command => command.name === slash[1] && ['prompt', 'skill'].includes(command.kind))) {
      throw new AppError(400, '此指令需使用网页对应操作或 Pi 终端。');
    }
    if (!view.model) throw new AppError(409, '当前 Pi 没有可用模型。请在 Pi 配置服务商后重新打开会话。');
    slot.mutating = true;
    try {
      const message = await expandSkillMentions(text, slot.commands, stripFrontmatter);
      if (!matches(slot)) throw new AppError(409, '当前 Pi 会话已经切换。');
      const startedIdle = view.status === 'idle';
      if (startedIdle) commit({ status: 'running', error: undefined });
      try {
        const result = await slot.worker.request('prompt', { message, streamingBehavior: body.mode ?? 'followUp' });
        if (result?.disposition === 'handled') void reconcile(slot);
        else if (!startedIdle && matches(slot)) commit({ pendingMessageCount: view.pendingMessageCount + 1 });
      } catch (error) {
        if (matches(slot) && error.status !== 504 && startedIdle) await reconcile(slot);
        throw error;
      }
    } finally { slot.mutating = false; }
  }

  async function stop(body) {
    const slot = requireSlot(body);
    if (view.status === 'idle') return;
    commit({ status: 'stopping' });
    try {
      await slot.worker.request('clear_queue');
      await slot.worker.request('abort');
    } finally { if (matches(slot)) await reconcile(slot); }
  }

  async function compact(body) {
    const slot = requireSlot(body);
    assertIdle();
    if (!view.model) throw new AppError(409, '请先选择 Pi 模型。');
    if (body.focus !== undefined && (typeof body.focus !== 'string' || body.focus.length > 4000)) throw new AppError(400, '压缩重点最多 4000 字符。');
    slot.mutating = true;
    commit({ status: 'compacting', error: undefined });
    try { await slot.worker.request('compact', { customInstructions: body.focus?.trim() || undefined }, 180_000); }
    finally {
      slot.mutating = false;
      if (matches(slot)) await reconcile(slot);
    }
  }

  async function settings(body) {
    const slot = requireSlot(body);
    assertIdle();
    const name = body.title === undefined ? undefined : sessionTitle(body.title);
    if (body.model !== undefined && !view.models.some(model => model.provider === body.model?.provider && model.id === body.model?.id)) {
      throw new AppError(400, '模型须来自当前 Pi 的可用列表。');
    }
    if (body.thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive'].includes(body.thinking)) {
      throw new AppError(400, 'Pi 思考档位无效。');
    }
    if (body.autoCompaction !== undefined && typeof body.autoCompaction !== 'boolean') throw new AppError(400, '自动压缩选项无效。');
    slot.mutating = true;
    try {
      if (body.model) await slot.worker.request('set_model', { provider: body.model.provider, modelId: body.model.id });
      if (body.thinking !== undefined) await slot.worker.request('set_thinking_level', { level: body.thinking });
      if (typeof body.autoCompaction === 'boolean') await slot.worker.request('set_auto_compaction', { enabled: body.autoCompaction });
      if (name !== undefined) {
        await slot.worker.request('set_session_name', { name });
        catalog.renameDraft(slot.row.cwd, slot.row.id, name);
      }
    } finally {
      try {
        if (matches(slot)) {
          const next = await slot.worker.request('get_state');
          const { levels } = await slot.worker.request('get_available_thinking_levels');
          if (matches(slot)) commit({ ...syncNative(next), levels, title: brief(next.sessionName, 120) || view.title });
        }
      } finally { slot.mutating = false; }
    }
  }

  return {
    state: () => view,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    workspaces: signal => catalog.workspaces(signal),
    selected: () => catalog.selected(),
    sessions: (cwd, signal) => catalog.sessions(cwd, signal),
    history: (cwd, id, signal) => catalog.history(cwd, id, signal),
    browse: path => catalog.browse(path),
    workspace(body) { catalog.updateWorkspace(body); },
    create(body) { return replace(() => catalog.createDraft(body.cwd ?? catalog.selected(), body.title)); },
    open(body, signal) { return replace(() => catalog.resolve(body.cwd, body.id, signal)); },
    prompt, stop, compact, settings,
    close() {
      if (shutdown) return shutdown;
      closed = true;
      emit('closed', {});
      listeners.clear();
      shutdown = Promise.all([active?.worker.close(), candidate?.worker.close()]);
      return shutdown;
    },
  };
}
