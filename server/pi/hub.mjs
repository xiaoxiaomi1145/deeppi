import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { body, createLoopbackServer, json, newAccessToken, openEvents } from '../http.mjs';
import { AppError } from '../settings.mjs';

const routes = { settings: 'PATCH', prompt: 'POST', stop: 'POST', compact: 'POST', probe: 'POST', addons: 'POST', resources: 'POST', switch: 'POST',
  models: 'POST', qq: 'PATCH', qqprobe: 'POST', qqreset: 'POST' };

export function createPiWebHub({ distDir }) {
  let binding, live, starting;
  const streams = new Map();
  const clients = new Set();
  const isBound = host => binding === host;
  function broadcast(event, data) {
    if (!streams.size) return;
    const payload = JSON.stringify(data);
    for (const send of streams.values()) send(event, payload);
  }
  function publish(host, event, data) {
    if (isBound(host)) broadcast(event, data);
  }
  function publishState(host) {
    if (!streams.size || !isBound(host)) return;
    try { broadcast('state', host.snapshot()); }
    catch { /* Pi may invalidate a previously bound runtime during switch/reload. */ }
  }
  function bind(host) {
    binding = host;
    publishState(host);
  }
  function bindCommands(ctx) { binding?.bindCommands(ctx); }
  function detach(host, reason) {
    if (!isBound(host)) return;
    binding = undefined;
    if (reason === 'quit') void close();
  }

  function requireBinding() {
    if (!binding) throw new AppError(503, 'Pi 正在重载或切换会话，稍后重试。');
    return binding;
  }
  async function api(req, res, { pathname, searchParams }) {
    const name = /^\/api\/pi\/([a-z]+)$/u.exec(pathname)?.[1];
    if (!name) throw new AppError(404, '接口不存在。');
    const readOnly = ['state', 'events', 'catalog', 'history'].includes(name) || (name === 'qq' && req.method === 'GET');
    if (!readOnly && !Object.hasOwn(routes, name)) throw new AppError(404, '接口不存在。');
    if (req.method !== (readOnly ? 'GET' : routes[name])) throw new AppError(405, '不支持此请求方法。');
    const host = requireBinding();
    if (name === 'state') return json(res, 200, host.snapshot());
    if (name === 'qq' && readOnly) return json(res, 200, host.qqSnapshot());
    if (name === 'events') {
      const snapshot = JSON.stringify(host.snapshot());
      const send = openEvents(res, clients);
      streams.set(res, send);
      res.once('close', () => streams.delete(res));
      send('state', snapshot);
      return;
    }
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    res.once('close', disconnected);
    try {
      let value;
      if (name === 'catalog') value = await host.catalog(abort.signal);
      else if (name === 'history') value = await host.history(searchParams.get('id'), abort.signal);
      else {
        const input = await body(req);
        abort.signal.throwIfAborted();
        if (!isBound(host)) throw new AppError(409, 'Pi 当前会话已更改，请重新操作。');
        value = await host.action(name, input, abort.signal);
      }
      if (!res.destroyed) json(res, name === 'prompt' || name === 'compact' ? 202 : 200, value);
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally { res.removeListener('close', disconnected); }
  }

  async function start(port = 0) {
    if (live) return live.url;
    if (starting) return starting;
    starting = (async () => {
      requireBinding();
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError(400, 'DEEPPI_PI_PORT 必须是 0 到 65535 的整数。');
      try { await access(join(distDir, 'index.html')); }
      catch { throw new AppError(503, 'Pi 网页尚未构建。源码安装请先在 Deeppi 目录运行 npm ci 和 npm run build。'); }
      const accessToken = newAccessToken();
      const server = createLoopbackServer({ distDir, accessToken, api });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const url = `http://127.0.0.1:${server.address().port}/#access=${accessToken}`;
      live = { server, url };
      return url;
    })();
    try { return await starting; } finally { starting = undefined; }
  }

  async function close() {
    if (starting) await starting.catch(() => {});
    if (!live) return;
    const { server } = live;
    live = undefined;
    broadcast('closed', { reason: 'closed' });
    for (const res of streams.keys()) res.end();
    streams.clear();
    clients.clear();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections();
    });
  }
  return { start, close, bind, detach, bindCommands, isBound, publish, publishState };
}

const hubKey = Symbol.for('deeppi.native-web.v1');
export function getPiWebHub({ agentDir, distDir }) {
  // Session switches re-evaluate the extension module. Only the UI listener,
  // not the old native command context or runtime, spans that boundary.
  const hubs = globalThis[hubKey] ??= new Map();
  const key = `${agentDir}\n${distDir}`;
  if (!hubs.has(key)) hubs.set(key, createPiWebHub({ distDir }));
  return hubs.get(key);
}
