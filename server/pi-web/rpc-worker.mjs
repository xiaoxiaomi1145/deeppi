import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AppError } from '../settings.mjs';

const maxFrame = 16 * 1024 * 1024;
const maxPending = 64;
const workerFailed = () => new AppError(502, 'Pi 进程已退出或未能完成通信。');

function usable(path, mode) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, mode);
    return true;
  } catch { return false; }
}

function pathExecutable(name, cwd, env) {
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    const path = resolve(cwd, entry, name);
    if (usable(path, constants.X_OK)) return path;
  }
}

function installedPeer() {
  try { return fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry')); }
  catch { return undefined; }
}

export function resolvePiCli({ cwd = process.cwd(), env = process.env, peerEntry = installedPeer } = {}) {
  const override = env.DEEPPI_PI_CLI;
  if (override !== undefined && override !== '') {
    const valid = typeof override === 'string' && !/[\x00\r\n]/u.test(override);
    const path = valid && (isAbsolute(override) || /[/\\]/u.test(override)
      ? resolve(cwd, override) : pathExecutable(override, cwd, env));
    if (path && ['.js', '.cjs', '.mjs'].includes(extname(path)) && usable(path, constants.R_OK)) {
      return { command: process.execPath, args: [path] };
    }
    if (path && usable(path, constants.X_OK)) return { command: path, args: [] };
    throw new AppError(503, 'DEEPPI_PI_CLI 需要指向可执行的 Pi 程序或可读的 Node.js 入口。');
  }
  const peer = peerEntry();
  if (peer && usable(peer, constants.R_OK)) return { command: process.execPath, args: [peer] };
  const executable = pathExecutable('pi', cwd, env);
  if (executable) return { command: executable, args: [] };
  throw new AppError(503, '没有找到 Pi。请安装 Pi 或在启动前设置 DEEPPI_PI_CLI。');
}

export function createPiRpcWorker({ cli, cwd, sessionPath, sessionId, sessionDir, env = process.env,
  closeGraceMs = 750, requestTimeoutMs = 30_000 }) {
  const args = [...cli.args, '--mode', 'rpc', '--offline'];
  if (sessionPath) args.push('--session', sessionPath);
  else if (sessionId) args.push('--session-id', sessionId);
  if (sessionDir) args.push('--session-dir', sessionDir);
  const ownProcessGroup = process.platform !== 'win32';
  const child = spawn(cli.command, args, {
    cwd, env: { ...env, DEEPPI_PI_WEB_WORKER: '1' }, detached: ownProcessGroup, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const pending = new Map();
  const observers = new Set();
  const exits = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let sequence = 0;
  let buffers = [];
  let length = 0;
  let ended = false;
  let closing;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });

  function finish(error) {
    if (ended) return;
    ended = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    observers.clear();
    for (const listener of exits) listener(error);
    exits.clear();
  }

  function signal(name) {
    try {
      if (ownProcessGroup && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { /* Worker has already exited. */ }
  }

  const childEnded = () => {
    finish(workerFailed());
    resolveExit();
  };
  child.once('error', childEnded);
  child.once('exit', childEnded);
  child.stdin.on('error', () => finish(workerFailed()));
  child.stdout.on('error', () => { finish(workerFailed()); void close(); });

  function frame(bytes) {
    let value;
    try { value = JSON.parse(decoder.decode(bytes)); }
    catch { finish(workerFailed()); void close(); return; }
    if (!value || typeof value.type !== 'string') {
      finish(workerFailed());
      void close();
      return;
    }
    if (value.type === 'response') {
      const request = pending.get(value.id);
      if (!request) return;
      if (value.command !== request.command || typeof value.success !== 'boolean') {
        finish(workerFailed());
        void close();
        return;
      }
      pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.success) request.resolve(value.data);
      else request.reject(new AppError(409, 'Pi 拒绝了此操作，请检查模型、会话和本机 Pi 配置。'));
    } else {
      for (const listener of observers) listener(value);
    }
  }

  child.stdout.on('data', chunk => {
    for (let start = 0; start < chunk.length && !ended;) {
      const lf = chunk.indexOf(10, start);
      const part = chunk.subarray(start, lf === -1 ? chunk.length : lf);
      length += part.length;
      if (length > maxFrame) { finish(workerFailed()); void close(); return; }
      if (part.length) buffers.push(part);
      if (lf === -1) break;
      if (length) frame(buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, length));
      buffers = [];
      length = 0;
      start = lf + 1;
    }
  });

  function request(command, payload = {}, timeoutMs = requestTimeoutMs) {
    if (ended || closing) return Promise.reject(workerFailed());
    if (pending.size >= maxPending) return Promise.reject(new AppError(503, 'Pi 请求过多，请稍后重试。'));
    const id = `deeppi-${++sequence}`;
    const line = `${JSON.stringify({ ...payload, id, type: command })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AppError(504, '等待 Pi 响应超时，请确认 Pi 当前状态。'));
      }, timeoutMs);
      timer.unref();
      pending.set(id, { command, resolve, reject, timer });
      child.stdin.write(line, error => { if (error) finish(workerFailed()); });
    });
  }

  async function waitForExit(ms) {
    let timer;
    try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      finish(workerFailed());
      child.stdin.end();
      if (await waitForExit(closeGraceMs)) return;
      signal('SIGTERM');
      if (await waitForExit(closeGraceMs)) return;
      signal('SIGKILL');
      await waitForExit(closeGraceMs);
    })();
    return closing;
  }

  return {
    request, close,
    onEvent(listener) { observers.add(listener); return () => observers.delete(listener); },
    onExit(listener) {
      if (ended) { listener(workerFailed()); return () => {}; }
      exits.add(listener);
      return () => exits.delete(listener);
    },
  };
}
