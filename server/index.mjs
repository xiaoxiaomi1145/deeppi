import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { body, createLoopbackServer, json, newAccessToken, openEvents } from './http.mjs';
import { createSessions, isSessionId } from './sessions.mjs';
import { AppError, directory } from './settings.mjs';

const bundled = fileURLToPath(new URL('../dist/', import.meta.url));

export function createDeeppiServer({ workspace = process.cwd(), dataDir, demo = false, distDir = bundled, accessToken = newAccessToken(), bashAvailable = false } = {}) {
  const root = directory(resolve(workspace));
  const sessions = createSessions({ workspace: root, dataDir: resolve(dataDir ?? resolve(root, '.deeppi', demo ? 'demo' : 'sessions')), demo, bashAvailable });
  const streams = new Set();

  function stream(id, res) {
    if (!sessions.has(id)) throw new AppError(404, '会话不存在。');
    const send = openEvents(res, streams);
    const unsubscribe = sessions.subscribe(id, (event, payload) => {
      send(event, payload);
      if (event === 'deleted') res.end();
    });
    res.once('close', unsubscribe);
  }

  async function api(req, res, { pathname, searchParams }) {
    const { method } = req;
    if (pathname === '/api/info' && method === 'GET') return json(res, 200, sessions.info());
    if (pathname === '/api/settings' && method === 'PATCH') return json(res, 200, sessions.updateDefaults(await body(req)));
    if (pathname === '/api/workspaces' && method === 'POST') return json(res, 200, sessions.updateWorkspace(await body(req)));
    if (pathname === '/api/directories' && method === 'GET') return json(res, 200, sessions.browse(searchParams.get('path') ?? undefined));
    if (pathname === '/api/connection' && method === 'POST') {
      const input = await body(req);
      const abort = new AbortController();
      const disconnected = () => abort.abort();
      res.once('close', disconnected);
      try {
        const result = await sessions.probe(input, abort.signal);
        if (!res.destroyed) return json(res, 200, result);
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        res.removeListener('close', disconnected);
      }
      return;
    }
    if (pathname === '/api/sessions') {
      if (method === 'GET') return json(res, 200, { sessions: sessions.list() });
      if (method === 'POST') return json(res, 201, { session: sessions.create(await body(req)) });
      throw new AppError(405, '不支持此请求方法。');
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/u.exec(pathname);
    if (!match || !isSessionId(match[1])) throw new AppError(404, '接口不存在。');
    const [, id, action] = match;
    if (!action) {
      if (method === 'GET') return json(res, 200, { session: sessions.get(id) });
      if (method === 'PATCH') return json(res, 200, { session: sessions.patch(id, await body(req)) });
      if (method === 'DELETE') {
        sessions.remove(id);
        return json(res, 200, { ok: true });
      }
      throw new AppError(405, '不支持此请求方法。');
    }
    if (action === 'events' && method === 'GET') return stream(id, res);
    if (method !== 'POST') throw new AppError(405, '不支持此请求方法。');
    const input = await body(req);
    if (action === 'tools/remove') return json(res, 200, { session: sessions.removeTool(id, input) });
    if (action === 'prompt') sessions.prompt(id, input);
    else if (action === 'continue') sessions.continue(id);
    else if (action === 'compact') sessions.compact(id, input);
    else if (action === 'stop') sessions.stop(id);
    else throw new AppError(404, '接口不存在。');
    return json(res, action === 'stop' ? 200 : 202, { ok: true });
  }

  const server = createLoopbackServer({ distDir, accessToken, api });
  server.stopDeeppi = () => {
    const jobs = sessions.stopAll();
    for (const res of streams) res.end();
    return jobs;
  };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const port = Number(process.env.DEEPPI_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEEPPI_PORT 必须是 1 到 65535 的整数。');
  const accessToken = newAccessToken();
  const server = createDeeppiServer({ dataDir: process.env.DEEPPI_DATA_DIR, demo, accessToken, bashAvailable: process.argv.includes('--allow-bash') });
  server.listen(port, '127.0.0.1', () => console.log(`Deeppi${demo ? ' (demo)' : ''} · http://127.0.0.1:${port}/#access=${accessToken}`));
  const close = () => {
    void server.stopDeeppi();
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
