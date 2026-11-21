import { join } from 'node:path';
import { AppError, plainObject } from '../settings.mjs';
import { createQqEngine } from './engine.mjs';
import { readPrivateJson, writePrivateJson } from './local-state.mjs';
import { defaultQqSettings, publicQqSettings, transportSettings, updateQqSettings } from './settings.mjs';
import { createStickerStore } from './stickers.mjs';
import { createOneBotTransport } from './transport.mjs';

const file = 'settings.json';
const storageError = 'QQ 配置或会话文件不可读取，请检查本机数据目录与权限。';
const startError = 'OneBot 无法启动监听，请检查本机端口。';
const sameTransport = (a, b) => JSON.stringify(transportSettings(a)) === JSON.stringify(transportSettings(b));

export function createQqService({ dataDir, cleanupSession }) {
  let settings, engine, owner, fault, startup;
  let jobs = new AbortController();
  let serial = Promise.resolve();
  const transport = createOneBotTransport({ onEvent(event, send) {
    if (!owner || !settings?.enabled || !transport.snapshot().connected || fault) return;
    return engine.accept(event, send, settings, owner, jobs.signal);
  } });

  function enqueue(run) {
    const result = serial.then(run);
    serial = result.catch(() => {});
    return result;
  }
  function initialize() {
    if (settings || fault) return;
    try {
      const saved = readPrivateJson(join(dataDir, file), 256 * 1024);
      if (saved !== undefined && (saved.version !== 1 || !plainObject(saved.settings))) throw new Error('Unsupported QQ settings file');
      const current = updateQqSettings(defaultQqSettings(), saved?.settings ?? {});
      engine = createQqEngine({ dataDir, stickerStore: createStickerStore({ dataDir }), cleanupSession });
      settings = { ...current, listen: current.listen || current.enabled };
    } catch { fault = storageError; }
  }
  function cancelJobs() {
    jobs.abort();
    jobs = new AbortController();
  }

  function attach(resolveRoute) {
    return enqueue(async () => {
      initialize();
      if (owner !== resolveRoute) cancelJobs();
      owner = resolveRoute;
      if (fault || !settings.listen) return;
      try { await transport.start(transportSettings(settings)); startup = undefined; }
      catch { startup = startError; }
    });
  }
  function detach(resolveRoute, reason = 'quit') {
    // Invalidate old Pi bindings before a replacement can take over. Keep the
    // authenticated receiver bound across a session switch, but stop all jobs.
    if (!resolveRoute || owner === resolveRoute) {
      owner = undefined;
      cancelJobs();
    }
    return enqueue(async () => {
      if (owner === resolveRoute && owner) { owner = undefined; cancelJobs(); }
      if (owner || (resolveRoute && reason !== 'quit' && reason !== 'reload')) return;
      await transport.stop();
      engine?.clearLanes();
    });
  }

  function requireReady() {
    initialize();
    if (fault) throw new AppError(500, fault);
    if (!owner) throw new AppError(503, 'Pi 当前会话尚未连接，稍后重试。');
  }
  function snapshot() {
    initialize();
    const { lastError, ...history } = engine?.snapshot() ?? { conversations: [], usage: {}, pending: 0 };
    const status = transport.snapshot();
    return { settings: publicQqSettings(settings ?? defaultQqSettings()),
      status: { ...status, lastError: fault ?? startup ?? status.lastError ?? lastError }, ...history };
  }

  function update(patch, signal) {
    return enqueue(async () => {
      signal?.throwIfAborted();
      requireReady();
      const before = settings;
      const currentOwner = owner;
      let next = updateQqSettings(before, patch);
      const changingConnection = !sameTransport(before, next);
      const recheck = patch.enabled === true && (!before.enabled || changingConnection || !before.listen);
      if (patch.listen === false) next = { ...next, enabled: false };
      else if (changingConnection && patch.enabled !== true) next = { ...next, enabled: false };
      if (next.enabled && recheck) {
        if (changingConnection || !before.listen || !transport.snapshot().connected) {
          throw new AppError(409, '请先保存连接、开启监听并确认 OneBot 已连接，再开启 QQ 回复。');
        }
        await transport.probe(AbortSignal.any([...(signal ? [signal] : []), jobs.signal]));
      }
      signal?.throwIfAborted();
      if (owner !== currentOwner) throw new AppError(409, 'Pi 当前会话已经更改，请重试。');
      if (JSON.stringify(next) !== JSON.stringify(before)) cancelJobs();
      try {
        if (next.listen) await transport.start(transportSettings(next));
        else await transport.stop();
        signal?.throwIfAborted();
        if (owner !== currentOwner) throw new AppError(409, 'Pi 当前会话已经更改，请重试。');
        if (JSON.stringify(next) !== JSON.stringify(before)) writePrivateJson(dataDir, file, { version: 1, settings: next });
        settings = next;
        startup = undefined;
      } catch (error) {
        try {
          if (before.listen) await transport.start(transportSettings(before));
          else await transport.stop();
        } catch { startup = startError; }
        throw error;
      }
      return snapshot();
    });
  }

  async function probe(signal) {
    requireReady();
    return transport.probe(AbortSignal.any([...(signal ? [signal] : []), jobs.signal]));
  }
  function reset(id) {
    requireReady();
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) throw new AppError(400, 'QQ 对话 ID 无效。');
    engine.reset(id);
    return snapshot();
  }
  return { attach, detach, snapshot, update, probe, reset };
}

const key = Symbol.for('deeppi.qq.service.v1');
export function getQqService({ agentDir, cleanupSession }) {
  const services = globalThis[key] ??= new Map();
  if (!services.has(agentDir)) services.set(agentDir, createQqService({ dataDir: join(agentDir, 'deeppi', 'qq'), cleanupSession }));
  return services.get(agentDir);
}
