import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, STATUS_CODES } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError, isLoopback } from '../settings.mjs';

const wsPath = '/onebot/v11/ws';
const httpPath = '/onebot/v11/event';
const maxEventBytes = 1024 * 1024;
const maxActionBytes = 8 * 1024 * 1024;
const maxPending = 32;
const maxDispatch = 64;
const actionTimeout = 10_000;
const httpIdentityTtl = 30_000;
const actions = new Set(['get_login_info', 'send_private_msg', 'send_group_msg']);
const roles = new Set(['api', 'event', 'universal']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => new AppError(503, 'OneBot 未连接或已断开。');
const timedOut = () => new AppError(504, 'OneBot 接口响应超时。');
const upstreamFailed = () => new AppError(502, 'OneBot 接口未返回成功结果。');

function qqId(value) {
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return undefined;
  const text = String(value);
  return /^[1-9][0-9]{0,19}$/u.test(text) ? text : undefined;
}

function credential(value, label, required = true) {
  if (value == null || value === '') {
    if (!required) return '';
    throw new AppError(400, `请配置 ${label}。`);
  }
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/u.test(value)) throw new AppError(400, `${label} 格式无效。`);
  return value;
}

function configFor(input) {
  const { transport, port, botId: rawId } = input ?? {};
  const botId = qqId(rawId);
  if (!botId) throw new AppError(400, '机器人 QQ 号无效。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError(400, 'OneBot 监听端口无效。');
  if (transport === 'ws') return { transport, port, botId, wsToken: credential(input.wsToken, 'WS Access Token') };
  if (transport !== 'http') throw new AppError(400, 'OneBot 连接方式无效。');
  let api;
  try { api = new URL(input.httpApiUrl); } catch { /* Invalid or absent URL. */ }
  if (!api || api.username || api.password || api.search || api.hash ||
      !(api.protocol === 'https:' || (api.protocol === 'http:' && isLoopback(api.hostname)))) {
    throw new AppError(400, 'OneBot HTTP API 地址需要 HTTPS 或本机 HTTP，不可带凭据、查询参数或片段。');
  }
  const httpSecret = credential(input.httpSecret, 'HTTP 回调签名密钥');
  const httpToken = credential(input.httpToken, 'HTTP API Access Token', false);
  return { transport, port, botId, httpApiUrl: `${api.origin}${api.pathname.replace(/\/+$/u, '')}`, httpSecret, httpToken };
}

function matchingSecret(candidate, expected) {
  const supplied = Buffer.from(candidate ?? '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseObject(raw) {
  try { const parsed = JSON.parse(raw); if (object(parsed)) return parsed; } catch { /* Invalid frame or body. */ }
  return undefined;
}

function checkedResult(payload) {
  if (!object(payload) || payload.status !== 'ok' || payload.retcode !== 0) throw upstreamFailed();
  return payload.data ?? null;
}

async function callbackBytes(req) {
  if ((Number(req.headers['content-length']) || 0) > maxEventBytes) throw new AppError(413, 'OneBot 事件太大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxEventBytes) throw new AppError(413, 'OneBot 事件太大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function responseObject(response) {
  if (!response.ok || !response.body || (Number(response.headers.get('content-length')) || 0) > maxEventBytes) {
    void response.body?.cancel().catch(() => {});
    throw upstreamFailed();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxEventBytes) throw upstreamFailed();
    chunks.push(chunk);
  }
  return parseObject(Buffer.concat(chunks, size).toString('utf8'));
}

function isExpectedHost(req, port) {
  return /^(?:127\.0\.0\.1|localhost)$/iu.test((req.headers.host ?? '').replace(/:\d+$/u, '')) &&
    Number(/:(\d+)$/u.exec(req.headers.host ?? '')?.[1] ?? 80) === port;
}

function rejectUpgrade(socket, code) {
  socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createOneBotTransport({ onEvent, fetch: fetcher = globalThis.fetch }) {
  let live, startupError;
  let lifecycle = Promise.resolve();
  const serialize = work => {
    const result = lifecycle.then(work);
    lifecycle = result.catch(() => {});
    return result;
  };
  const activeSocket = (state, role) => {
    const candidate = state.sockets.get('universal');
    if (candidate?.readyState === WebSocket.OPEN) return candidate;
    const peer = state.sockets.get(role);
    return peer?.readyState === WebSocket.OPEN ? peer : undefined;
  };

  function snapshot() {
    if (!live) return { listening: false, connected: false, ...(startupError ? { lastError: startupError } : {}) };
    const { config, port, lastError, lastEventAt, httpConnected } = live;
    const ws = config.transport === 'ws';
    return {
      listening: true,
      connected: ws ? Boolean(activeSocket(live, 'api') && activeSocket(live, 'event')) : httpConnected,
      ...(ws ? { wsUrl: `ws://127.0.0.1:${port}${wsPath}` } : { httpUrl: `http://127.0.0.1:${port}${httpPath}` }),
      ...(lastEventAt === undefined ? {} : { lastEventAt }),
      ...(lastError ? { lastError } : {}),
    };
  }

  function wsAction(state, action, params, signal) {
    const peer = activeSocket(state, 'api');
    if (!peer) throw unavailable();
    if (state.pending.size >= maxPending || peer.bufferedAmount > maxActionBytes) throw new AppError(429, 'OneBot 待发送请求过多。');
    const echo = randomUUID();
    const data = JSON.stringify({ action, params, echo });
    if (Buffer.byteLength(data) > maxActionBytes) throw new AppError(413, 'OneBot 动作参数太大。');
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (!state.pending.delete(echo)) return;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const timeout = setTimeout(() => finish(timedOut()), actionTimeout);
      timeout.unref();
      const abort = () => finish(signal.reason);
      state.pending.set(echo, { peer, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try { peer.send(data, error => { if (error) finish(unavailable()); }); }
      catch { finish(unavailable()); }
    });
  }

  async function httpAction(state, action, params, signal) {
    if (state.httpPending >= maxPending) throw new AppError(429, 'OneBot 待发送请求过多。');
    const { httpApiUrl, httpToken } = state.config;
    const body = JSON.stringify(params);
    if (Buffer.byteLength(body) > maxActionBytes) throw new AppError(413, 'OneBot 动作参数太大。');
    const timeout = AbortSignal.timeout(actionTimeout);
    const combined = AbortSignal.any([state.abort.signal, timeout, ...(signal ? [signal] : [])]);
    state.httpPending++;
    try {
      const reply = await fetcher(`${httpApiUrl}/${action}`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', ...(httpToken ? { authorization: `Bearer ${httpToken}` } : {}) }, body,
      });
      return checkedResult(await responseObject(reply));
    } catch {
      if (signal?.aborted) throw signal.reason;
      if (state.abort.signal.aborted) throw unavailable();
      if (timeout.aborted) throw timedOut();
      throw upstreamFailed();
    } finally { state.httpPending--; }
  }

  async function send(state, action, params, { signal } = {}) {
    if (live !== state) throw unavailable();
    if (!actions.has(action)) throw new AppError(403, '不允许调用此 OneBot 动作。');
    if (!object(params)) throw new AppError(400, 'OneBot 动作参数无效。');
    signal?.throwIfAborted();
    if (state.config.transport === 'ws') return wsAction(state, action, params, signal);
    if (action !== 'get_login_info' && Date.now() >= state.httpIdentityUntil) await probeState(state, signal);
    if (live !== state) throw unavailable();
    signal?.throwIfAborted();
    return httpAction(state, action, params, signal);
  }

  function dispatch(state, event) {
    state.lastEventAt = Date.now();
    if (state.dispatching >= maxDispatch) {
      state.lastError = 'OneBot 正在处理的事件过多。';
      return false;
    }
    state.dispatching++;
    setImmediate(() => {
      Promise.resolve().then(() => {
        if (live === state) return onEvent(event, (action, params, options) => send(state, action, params, options));
      }).catch(() => {
        if (live === state) state.lastError = 'OneBot 事件处理失败。';
      }).finally(() => { state.dispatching--; });
    });
    return true;
  }

  function installWebSocket(server, state) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: maxEventBytes, perMessageDeflate: false });
    const bearer = Buffer.from(`Bearer ${state.config.wsToken}`);
    const alive = new WeakSet();
    state.heartbeat = setInterval(() => {
      for (const socket of state.sockets.values()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        if (!alive.delete(socket)) socket.terminate();
        else socket.ping();
      }
    }, 30_000);
    state.heartbeat.unref();
    state.wss = wss;
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      if (live !== state || req.url !== wsPath) return rejectUpgrade(socket, 404);
      if (!isExpectedHost(req, state.port) || req.headers.origin) return rejectUpgrade(socket, 403);
      if (!matchingSecret(req.headers.authorization, bearer)) return rejectUpgrade(socket, 401);
      if (qqId(req.headers['x-self-id']) !== state.config.botId) return rejectUpgrade(socket, 403);
      const role = req.headers['x-client-role']?.toLowerCase();
      if (!roles.has(role)) return rejectUpgrade(socket, 400);
      wss.handleUpgrade(req, socket, head, peer => {
        state.sockets.get(role)?.terminate();
        state.sockets.set(role, peer);
        state.lastError = undefined;
        alive.add(peer);
        peer.on('pong', () => alive.add(peer));
        peer.on('error', () => peer.terminate());
        peer.on('close', () => {
          if (state.sockets.get(role) === peer) state.sockets.delete(role);
          for (const wait of state.pending.values()) if (wait.peer === peer) wait.finish(unavailable());
        });
        peer.on('message', (data, binary) => {
          if (live !== state || binary || state.sockets.get(role) !== peer) return;
          const payload = parseObject(data.toString());
          if (!payload) return;
          if (Object.hasOwn(payload, 'echo')) {
            const wait = state.pending.get(payload.echo);
            if (wait?.peer !== peer || !wait) return;
            try { wait.finish(undefined, checkedResult(payload)); } catch (error) { wait.finish(error); }
          } else if (activeSocket(state, 'event') === peer && typeof payload.post_type === 'string' && qqId(payload.self_id) === state.config.botId) {
            dispatch(state, payload);
          }
        });
      });
    });
  }

  async function callback(req, res, state) {
    if (live !== state || state.config.transport !== 'http' || req.url !== httpPath) throw new AppError(404, 'OneBot 接口不存在。');
    if (!isExpectedHost(req, state.port) || req.headers.origin) throw new AppError(403, 'OneBot 请求来源无效。');
    if (req.method !== 'POST') throw new AppError(405, 'OneBot 事件需要 POST。');
    if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '')) throw new AppError(415, 'OneBot 事件需要 JSON。');
    const signature = /^sha1=([0-9a-f]{40})$/iu.exec(req.headers['x-signature'] ?? '');
    if (!signature) throw new AppError(401, 'OneBot 事件签名无效。');
    const bytes = await callbackBytes(req);
    const expected = createHmac('sha1', state.config.httpSecret).update(bytes).digest();
    if (!timingSafeEqual(Buffer.from(signature[1], 'hex'), expected)) throw new AppError(401, 'OneBot 事件签名无效。');
    const event = parseObject(bytes.toString('utf8'));
    if (!event || typeof event.post_type !== 'string') throw new AppError(400, 'OneBot 事件格式无效。');
    if (qqId(event.self_id) !== state.config.botId ||
        (req.headers['x-self-id'] !== undefined && qqId(req.headers['x-self-id']) !== state.config.botId)) {
      throw new AppError(403, 'OneBot 机器人身份不匹配。');
    }
    if (live !== state) throw unavailable();
    state.httpConnected = true;
    if (!dispatch(state, event)) throw new AppError(503, state.lastError);
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
  }

  async function stopLive() {
    const state = live;
    if (!state) return;
    live = undefined;
    state.abort.abort();
    clearInterval(state.heartbeat);
    for (const wait of state.pending.values()) wait.finish(unavailable());
    for (const peer of state.sockets.values()) peer.terminate();
    await new Promise(resolve => {
      state.server.close(resolve);
      state.server.closeAllConnections();
    });
    state.wss?.close();
  }

  function start(input) {
    return serialize(async () => {
      const config = configFor(input);
      const identity = JSON.stringify(config);
      if (live?.identity === identity) return snapshot();
      await stopLive();
      const state = { config, identity, abort: new AbortController(), sockets: new Map(), pending: new Map(),
        dispatching: 0, httpPending: 0, httpConnected: false, httpIdentityUntil: 0 };
      const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 }, (req, res) => {
        callback(req, res, state).catch(error => {
          if (!res.destroyed) {
            res.writeHead(error instanceof AppError ? error.status : 400, { connection: 'close', 'cache-control': 'no-store' });
            res.end();
          }
        });
      });
      state.server = server;
      server.maxConnections = 64;
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
        });
      } catch {
        startupError = '无法启动 OneBot 本机监听，请检查端口。';
        throw new AppError(409, startupError);
      }
      state.port = server.address().port;
      if (config.transport === 'ws') installWebSocket(server, state);
      server.on('error', () => { state.lastError = 'OneBot 本机监听异常。'; });
      startupError = undefined;
      live = state;
      return snapshot();
    });
  }

  function stop() { return serialize(async () => { await stopLive(); startupError = undefined; }); }

  async function probeState(state, signal) {
    try {
      const data = await send(state, 'get_login_info', {}, { signal });
      if (live !== state) throw unavailable();
      if (qqId(data?.user_id) !== state.config.botId) throw new AppError(502, 'OneBot 登录账号与配置的机器人 QQ 号不匹配。');
      if (state.config.transport === 'http') {
        state.httpConnected = true;
        state.httpIdentityUntil = Date.now() + httpIdentityTtl;
      }
      state.lastError = undefined;
      return { botId: state.config.botId, ...(typeof data.nickname === 'string' ? { nickname: data.nickname.slice(0, 80) } : {}) };
    } catch (error) {
      if (!signal?.aborted && live === state) {
        if (state.config.transport === 'http') {
          state.httpConnected = false;
          state.httpIdentityUntil = 0;
        }
        state.lastError = error instanceof AppError ? error.message : 'OneBot 连接检查失败。';
      }
      throw error;
    }
  }

  async function probe(signal) {
    if (!live) throw unavailable();
    return probeState(live, signal);
  }

  return { start, stop, snapshot, probe };
}
