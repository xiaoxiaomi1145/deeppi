import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError, plainObject } from '../settings.mjs';

const imageLimit = 2 * 1024 * 1024;
const scopeLimit = 8 * 1024 * 1024;
const itemLimit = 32;
const conversationLimit = 64;
const noteLimit = 240;
const documentLimit = 4 * Math.ceil(scopeLimit / 3) + 32_768;
const timeoutMs = 8000;
const cdnHosts = new Set(['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']);
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
const writes = new Map();
let pendingSaves = 0;

const cacheError = () => new AppError(500, 'QQ 表情缓存不可读取或写入。');
const badSource = () => new AppError(400, '只能保存这条 QQ 消息中的受支持图片。');
const tooLarge = () => new AppError(413, '表情图片不得超过 2 MiB。');
const full = () => new AppError(409, '此 QQ 对话的表情库已满。');
const row = ({ id, note, bytes }) => ({ id, note, bytes });

function fileFor(dir, scope) {
  if (typeof scope !== 'string' || !/^[1-9][0-9]{0,19}:(?:p:[1-9][0-9]{0,19}|g:[1-9][0-9]{0,19}(?::u:[1-9][0-9]{0,19})?)$/u.test(scope)) {
    throw new AppError(400, 'QQ 对话范围无效。');
  }
  return join(dir, `${createHash('sha256').update(scope).digest('hex')}.json`);
}

function cleanNote(value) {
  if (typeof value !== 'string' || value.length > noteLimit ||
      /[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u.test(value) || !value.trim()) {
    throw new AppError(400, '表情备注必须为 1 至 240 个字符的单行文本。');
  }
  return value.trim();
}

function decodeImage(value) {
  if (typeof value !== 'string' || !value) throw badSource();
  if (value.length > 4 * Math.ceil(imageLimit / 3)) throw tooLarge();
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw badSource();
  const image = Buffer.from(value, 'base64');
  if (image.length > imageLimit) throw tooLarge();
  if (image.toString('base64') !== value) throw badSource();
  return image;
}

function validateRaster(bytes) {
  const prefix = bytes.toString('ascii', 0, 6);
  if (bytes.length >= 14 && (prefix === 'GIF87a' || prefix === 'GIF89a') &&
      bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return bytes;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngMagic) && bytes.readUInt32BE(8) === 13 &&
      bytes.toString('latin1', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return bytes;
  if (bytes.length >= 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return bytes;
  if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length) return bytes;
  throw new AppError(415, '仅支持 JPEG、PNG、GIF 和 WebP 位图表情。');
}

function sourceOf(image) {
  if (!plainObject(image)) throw badSource();
  if (typeof image.file === 'string' && image.file.startsWith('base64://')) return decodeImage(image.file.slice(9));
  const raw = image.url || image.file;
  if (typeof raw !== 'string' || raw.length > 8192 || !raw.startsWith('https://') || /[\x00-\x20\x7f\\]/u.test(raw)) throw badSource();
  let url;
  try { url = new URL(raw); } catch { throw badSource(); }
  if (!cdnHosts.has(url.hostname) || url.port || url.username || url.password || url.hash) throw badSource();
  return url;
}

function discard(body) {
  if (body && !body.locked) void body.cancel().catch(() => {});
}

async function fetchImage(url, fetcher, signal) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal: combined });
    const body = response.body;
    if (combined.aborted || !response.ok || response.redirected || !body) {
      discard(body);
      combined.throwIfAborted();
      throw new AppError(502, '未能从 QQ 图片服务下载表情。');
    }
    const length = response.headers.get('content-length');
    if (length && /^\d+$/u.test(length) && Number(length) > imageLimit) {
      discard(body);
      throw tooLarge();
    }
    const reader = body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      let size = 0;
      const chunks = [];
      for (;;) {
        combined.throwIfAborted();
        const { value, done } = await reader.read();
        combined.throwIfAborted();
        if (done) return Buffer.concat(chunks, size);
        size += value.byteLength;
        if (size > imageLimit) throw tooLarge();
        if (value.byteLength) chunks.push(value);
      }
    } finally {
      combined.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted) throw new AppError(504, 'QQ 表情下载超时。');
    if (error instanceof AppError) throw error;
    throw new AppError(502, '未能从 QQ 图片服务下载表情。');
  }
}

async function checkDirectory(dir, create) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw cacheError();
    return true;
  } catch (error) {
    if (!create && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readEntries(file, scope) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > documentLimit) throw cacheError();
    const { version, scope: actualScope, entries } = JSON.parse(await handle.readFile('utf8'));
    if (version !== 1 || actualScope !== scope || !Array.isArray(entries) || entries.length > itemLimit) throw cacheError();
    let total = 0;
    for (const [index, entry] of entries.entries()) {
      if (!plainObject(entry) || entry.id !== index + 1 || entry.note !== cleanNote(entry.note) ||
          !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > imageLimit ||
          typeof entry.image !== 'string' || entry.image.length !== 4 * Math.ceil(entry.bytes / 3)) throw cacheError();
      total += entry.bytes;
    }
    if (total > scopeLimit) throw cacheError();
    return entries;
  } finally { await handle.close(); }
}

async function reserveConversation(dir) {
  let count = 0;
  const entries = await opendir(dir);
  for await (const entry of entries) {
    if (/^[0-9a-f]{64}\.json$/u.test(entry.name) && ++count >= conversationLimit) {
      throw new AppError(409, 'QQ 表情缓存已达到对话数量上限。');
    }
  }
}

async function saveEntries(dir, file, scope, entries, signal) {
  const temp = join(dir, `.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, scope, entries })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    await rename(temp, file);
    created = false;
  } finally {
    if (created) await unlink(temp).catch(() => {});
  }
}

// Serialize private disk updates per storage directory, including across store instances.
function withWrite(dir, work) {
  const job = (writes.get(dir) ?? Promise.resolve()).then(work, work);
  writes.set(dir, job);
  return job.finally(() => {
    if (writes.get(dir) === job) writes.delete(dir);
  });
}

export function createStickerStore({ dataDir, fetch: fetcher = globalThis.fetch }) {
  const dir = resolve(dataDir, 'stickers');
  const load = async (file, scope) => {
    try { return await checkDirectory(dir, false) ? await readEntries(file, scope) : []; }
    catch { throw cacheError(); }
  };
  return {
    async save(scope, image, note, signal) {
      const file = fileFor(dir, scope);
      const clean = cleanNote(note);
      signal?.throwIfAborted();
      if (pendingSaves >= 16) throw new AppError(429, 'QQ 表情保存请求过多，请稍后再试。');
      pendingSaves++;
      try {
        const source = sourceOf(image);
        const bytes = validateRaster(Buffer.isBuffer(source) ? source : await fetchImage(source, fetcher, signal));
        return await withWrite(dir, async () => {
          try {
            signal?.throwIfAborted();
            const entries = await load(file, scope);
            if (entries.length >= itemLimit || entries.reduce((sum, item) => sum + item.bytes, bytes.length) > scopeLimit) throw full();
            await checkDirectory(dir, true);
            if (!entries.length) await reserveConversation(dir);
            const entry = { id: entries.length + 1, note: clean, bytes: bytes.length, image: bytes.toString('base64') };
            await saveEntries(dir, file, scope, [...entries, entry], signal);
            return row(entry);
          } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof AppError) throw error;
            throw cacheError();
          }
        });
      } finally { pendingSaves--; }
    },
    async list(scope) {
      return (await load(fileFor(dir, scope), scope)).map(row);
    },
    async read(scope, id) {
      const file = fileFor(dir, scope);
      if (!Number.isSafeInteger(id) || id < 1) throw new AppError(400, '表情编号必须为正整数。');
      const entry = (await load(file, scope))[id - 1];
      if (!entry) throw new AppError(404, '此 QQ 对话没有这个表情编号。');
      try {
        const bytes = validateRaster(decodeImage(entry.image));
        if (entry.bytes !== bytes.length) throw cacheError();
      } catch { throw cacheError(); }
      return { ...row(entry), segment: { type: 'image', data: { file: `base64://${entry.image}` } } };
    },
  };
}
