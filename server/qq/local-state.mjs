import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../settings.mjs';

export function readPrivateJson(file, limit) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > limit) throw new Error('QQ storage is not a private, bounded regular file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export function writePrivateJson(dir, name, value) {
  const temp = join(dir, `.write-${randomUUID()}`);
  let created = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(temp, 'wx', 0o600);
    created = true;
    try { writeFileSync(fd, `${JSON.stringify(value)}\n`); } finally { closeSync(fd); }
    renameSync(temp, join(dir, name));
    created = false;
  } catch { throw new AppError(500, '无法写入 QQ 本地数据，请检查数据目录与权限。'); }
  finally { if (created) try { unlinkSync(temp); } catch { /* Best effort. */ } }
}
