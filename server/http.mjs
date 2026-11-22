import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { AppError, isLoopback, plainObject } from './settings.mjs';

export const newAccessToken = () => randomBytes(32).toString('base64url');
const bodyLimit = 1024 * 1024;
const staticTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};
const contentPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function body(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] ?? '')) throw new AppError(415, '请求需要使用 application/json。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= bodyLimit) chunks.push(chunk);
  }
  if (size > bodyLimit) throw new AppError(413, '请求内容太大。');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, '请求不是有效的 JSON。'); }
  if (!plainObject(value)) throw new AppError(400, '请求需要是一个 JSON 对象。');
  return value;
}

function trustedHost(req) {
  const host = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/iu.exec(req.headers.host ?? '');
  if (!host || !isLoopback(req.socket.localAddress === '::1' ? '[::1]' : req.socket.localAddress)) return false;
  return Number(host[1] || 80) === req.socket.localPort;
}

async function staticFile(req, res, path, distDir, indexFile) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, '不支持此请求方法。');
  const isIndex = path === '/' || path === '/index.html';
  const relative = isIndex ? indexFile : path.slice(1);
  if (!isIndex && !/^(?:LICENSE|THIRD_PARTY_NOTICES|favicon\.ico|assets\/[a-zA-Z0-9_.-]+)$/u.test(relative)) {
    throw new AppError(404, '页面不存在。');
  }
  let target = resolve(distDir, relative);
  let info;
  try { info = await stat(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // dist/pi reuses the root notice generated alongside dist/. This keeps
  // package storage down while preserving a discoverable URL in both apps.
  if (!info?.isFile() && relative === 'THIRD_PARTY_NOTICES') {
    const shared = resolve(distDir, '..', relative);
    try {
      const sharedInfo = await stat(shared);
      if (sharedInfo.isFile()) { target = shared; info = sharedInfo; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!info?.isFile()) {
    if (relative === 'index.html') throw new AppError(503, '页面还未构建，请在 Deeppi 项目中运行 npm run build。');
    throw new AppError(404, '文件不存在。');
  }
  res.writeHead(200, { 'content-type': staticTypes[extname(target)] ?? 'text/plain; charset=utf-8', 'content-length': info.size, 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  else createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

export function createLoopbackServer({ distDir, accessToken, api, indexFile = 'index.html' }) {
  const expected = Buffer.from(`Bearer ${accessToken}`);
  const server = createServer(async (req, res) => {
    res.setHeader('content-security-policy', contentPolicy);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (!trustedHost(req)) throw new AppError(403, '请通过本机地址打开 Deeppi。');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new AppError(400, '请求路径无效。');
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) return await staticFile(req, res, url.pathname, distDir, indexFile);
      if (req.headers['sec-fetch-site'] === 'cross-site' ||
          (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
        throw new AppError(403, '请求来源不匹配。');
      }
      const maybeToken = Buffer.from(req.headers.authorization ?? '');
      if (maybeToken.length !== expected.length || !timingSafeEqual(maybeToken, expected)) {
        res.setHeader('www-authenticate', 'Bearer realm="Deeppi"');
        throw new AppError(401, '请打开 Deeppi 启动终端中显示的完整链接。');
      }
      await api(req, res, url);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof AppError) json(res, error.status, { error: error.message });
      else {
        console.error('Deeppi request failed', error?.code ?? error?.name ?? 'internal error');
        json(res, 500, { error: '无法处理请求，请检查服务日志。' });
      }
    }
  });
  server.requestTimeout = 30_000;
  return server;
}

export function openEvents(res, streams) {
  if (streams.size >= 48) throw new AppError(503, '实时连接过多。');
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  streams.add(res);
  const heartbeat = setInterval(() => send(''), 15_000);
  heartbeat.unref();
  res.once('close', () => { clearInterval(heartbeat); streams.delete(res); });
  function send(event, payload) {
    if (res.writableEnded || res.destroyed) return;
    if (res.writableLength > bodyLimit) { res.destroy(); return; }
    res.write(event ? `event: ${event}\ndata: ${payload}\n\n` : ': heartbeat\n\n');
  }
  return send;
}
