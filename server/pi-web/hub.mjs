import { body, createLoopbackServer, json, newAccessToken, openEvents } from '../http.mjs';
import { AppError } from '../settings.mjs';

const route = '/api/pi-web/';

export function createPiWebHub({ broker, distDir, accessToken = newAccessToken() }) {
  const streams = new Set();
  const senders = new Map();
  const unsubscribe = broker.subscribe((event, data) => {
    if (!senders.size) return;
    const serialized = JSON.stringify(data);
    for (const [response, send] of senders) {
      send(event, serialized);
      if (event === 'closed') response.end();
    }
  });
  const server = createLoopbackServer({ distDir, accessToken, indexFile: 'pi-web.html', api: async (req, res, url) => {
    if (!url.pathname.startsWith(route)) throw new AppError(404, '接口不存在。');
    const name = url.pathname.slice(route.length);
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    const { signal } = controller;
    if (req.method === 'GET') {
      const cwd = url.searchParams.get('cwd');
      if (name === 'state') return json(res, 200, broker.state());
      if (name === 'workspaces') return json(res, 200, { selected: broker.selected(), workspaces: await broker.workspaces(signal) });
      if (name === 'sessions') return json(res, 200, { sessions: await broker.sessions(cwd, signal) });
      if (name === 'history') return json(res, 200, await broker.history(cwd, url.searchParams.get('id'), signal));
      if (name === 'directories') return json(res, 200, broker.browse(url.searchParams.get('path') ?? undefined));
      if (name === 'events') {
        const send = openEvents(res, streams);
        senders.set(res, send);
        res.once('close', () => senders.delete(res));
        return send('state', JSON.stringify(broker.state()));
      }
    }
    if (req.method === 'POST') {
      const actions = { workspaces: broker.workspace, sessions: broker.create, switch: broker.open, prompt: broker.prompt,
        stop: broker.stop, compact: broker.compact, settings: broker.settings };
      if (Object.hasOwn(actions, name)) {
        await actions[name](await body(req), signal);
        return json(res, 200, { ok: true });
      }
    }
    throw new AppError(404, '接口不存在。');
  } });
  let closing;
  return {
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        const failed = error => reject(error);
        server.once('error', failed);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', failed);
          resolve(`http://127.0.0.1:${server.address().port}/#access=${accessToken}`);
        });
      });
    },
    close() {
      closing ??= (async () => {
        // Calling close() publishes the terminal event synchronously.
        const worker = broker.close();
        const http = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        server.closeAllConnections();
        unsubscribe();
        await Promise.all([worker, http]);
      })();
      return closing;
    },
  };
}
