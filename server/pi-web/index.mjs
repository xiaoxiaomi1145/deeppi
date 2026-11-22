#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../settings.mjs';
import { createPiWebBroker } from './broker.mjs';
import { createPiWebCatalog, piStoragePaths } from './catalog.mjs';
import { createPiWebHub } from './hub.mjs';
import { resolvePiCli } from './rpc-worker.mjs';

const distDir = fileURLToPath(new URL('../../dist/pi/', import.meta.url));

async function main() {
  const workspace = process.cwd();
  const storage = piStoragePaths(workspace);
  const dataDir = join(storage.agentDir, 'deeppi-rpc-web');
  const cli = resolvePiCli({ cwd: workspace });
  try { await access(join(distDir, 'pi-web.html')); }
  catch { throw new AppError(503, 'Pi Web 页面尚未构建，请先运行 pnpm build。'); }
  const rawPort = process.env.DEEPPI_PI_WEB_PORT ?? '';
  const port = rawPort ? Number(rawPort) : 0;
  if (!/^\d*$/u.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AppError(400, 'DEEPPI_PI_WEB_PORT 必须为 0–65535 的整数。');
  }
  const catalog = createPiWebCatalog({ workspace, dataDir, ...storage });
  const broker = createPiWebBroker({ catalog, cli, sessionDir: storage.sessionDir });
  const hub = createPiWebHub({ broker, distDir });
  const link = await hub.listen(port);
  const stop = () => { void hub.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`Pi Web 已启动，请打开完整链接\n${link}`);
}

main().catch(error => {
  const message = error instanceof AppError ? error.message : error?.code === 'EADDRINUSE' ? '端口已被占用。' : '启动失败，请检查 Pi 配置和目录权限。';
  console.error(`Pi Web ${message}`);
  process.exitCode = 1;
});
