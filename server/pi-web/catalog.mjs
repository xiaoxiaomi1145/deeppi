import { randomUUID } from 'node:crypto';
import { constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { projectBranch, textContent } from '../pi/transcript.mjs';
import { readPrivateJson, writePrivateJson } from '../private-json.mjs';
import { createProfile } from '../profile.mjs';
import { AppError, directory } from '../settings.mjs';

const maxArchive = 15 * 1024 * 1024;
const metaName = 'sessions.json';
const maxDrafts = 256;
const idPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,254}[A-Za-z0-9])?$/u;
const missing = () => new AppError(404, '在该工作区未找到可打开的 Pi 会话。');
const isId = id => typeof id === 'string' && idPattern.test(id);
const shortTitle = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 120) : '';
const newest = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

function expand(path, cwd, home) {
  return resolve(cwd, path === '~' || path.startsWith('~/') ? `${home}${path.slice(1)}` : path);
}

export function piStoragePaths(workspace, env = process.env) {
  const home = env.HOME || homedir();
  const agentDir = env.PI_CODING_AGENT_DIR ? expand(env.PI_CODING_AGENT_DIR, workspace, home) : join(home, '.pi', 'agent');
  let globalDir;
  try {
    const file = join(agentDir, 'settings.json');
    if (statSync(file).size <= 1024 * 1024) globalDir = JSON.parse(readFileSync(file, 'utf8')).sessionDir;
  } catch { /* Pi remains responsible for reporting its own settings diagnostics. */ }
  const setting = env.PI_CODING_AGENT_SESSION_DIR || globalDir;
  return { agentDir, sessionDir: typeof setting === 'string' && setting ? expand(setting, workspace, home) : undefined };
}

export function sessionTitle(value) {
  if (typeof value !== 'string' || value.length > 120 || !value.trim() || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new AppError(400, '会话名称须为 1–120 个字符。');
  }
  return value.trim();
}

export function archiveBranch(entries, leafId) {
  const header = entries[0]?.type === 'session' ? entries[0] : undefined;
  const body = header ? entries.slice(1) : entries;
  if (header && (header.version === undefined || header.version === 1)) {
    if (body.some(entry => typeof entry?.type !== 'string' || entry.type === 'session')) throw missing();
    return body.map((entry, index) => ({ ...entry, id: `legacy-${index}` }));
  }
  const seen = new Map();
  for (const entry of body) {
    if (typeof entry?.type !== 'string' || entry.type === 'session' || typeof entry.id !== 'string' || !entry.id ||
        seen.has(entry.id) || (entry.parentId !== null && !seen.has(entry.parentId))) throw missing();
    seen.set(entry.id, entry);
  }
  let leaf = leafId === undefined ? body.at(-1)?.id ?? null : leafId;
  const branch = [];
  while (leaf !== null) {
    const entry = seen.get(leaf);
    if (!entry) throw missing();
    branch.push(entry);
    leaf = entry.parentId;
  }
  return branch.reverse();
}

async function nativeJsonLines(file, signal) {
  signal?.throwIfAborted();
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > maxArchive) throw missing();
    // Read at most the inspected length even when another Pi is appending to it.
    const data = Buffer.allocUnsafe(info.size);
    const { bytesRead } = await fd.read(data, 0, info.size, 0);
    if (bytesRead !== info.size) throw missing();
    signal?.throwIfAborted();
    return data.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  } finally { await fd.close(); }
}

function archiveRow(entries, file, modified) {
  const header = entries[0];
  if (header?.type !== 'session' || !isId(header.id) || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) throw missing();
  let cwd = resolve(header.cwd);
  try { cwd = realpathSync(cwd); } catch { /* Keep stale native workspace labels visible. */ }
  let title = '';
  let first = '';
  let messageCount = 0;
  for (const entry of entries) {
    if (entry?.type === 'session_info') title = shortTitle(entry.name) || title;
    if (entry?.type !== 'message') continue;
    messageCount++;
    if (entry.message?.role === 'user') first ||= shortTitle(textContent(entry.message.content));
  }
  return { id: header.id, path: file, cwd, title: title || first || '新会话', updatedAt: modified, messageCount };
}

function visible({ id, cwd, title, updatedAt, messageCount }) {
  return { id, cwd, title, updatedAt, messageCount };
}

export function createPiWebCatalog({ workspace, dataDir, agentDir, sessionDir, profile = createProfile({ dataDir, workspace, demo: false }) }) {
  const launch = directory(workspace);
  const store = join(dataDir, metaName);
  const root = join(agentDir, 'sessions');
  const cache = new Map();
  let drafts = [];
  let customDirs = [];
  let unreadable = false;
  try {
    const stored = readPrivateJson(store, 512 * 1024);
    if (stored !== undefined) {
      if (stored?.version !== 1 || !Array.isArray(stored.drafts) || !Array.isArray(stored.customDirs)) throw new Error('Invalid Pi Web catalog');
      drafts = stored.drafts.filter(row => isId(row?.id) && typeof row.cwd === 'string' && isAbsolute(row.cwd) && Number.isFinite(row.updatedAt))
        .slice(0, maxDrafts).map(row => ({ id: row.id, cwd: row.cwd, title: shortTitle(row.title) || '新会话', updatedAt: row.updatedAt, messageCount: 0 }));
      customDirs = stored.customDirs.filter(path => typeof path === 'string' && isAbsolute(path)).slice(0, 128);
    }
  } catch { unreadable = true; }

  function write(nextDrafts, dirs = customDirs) {
    if (unreadable) throw new AppError(409, '本地会话目录配置不可读，请检查 Pi Web 数据目录后重启。');
    try { writePrivateJson(dataDir, metaName, { version: 1, drafts: nextDrafts, customDirs: dirs }); }
    catch { throw new AppError(500, '无法保存 Pi Web 会话目录。'); }
    drafts = nextDrafts;
    customDirs = dirs;
  }

  async function listDirectory(path) {
    try { return await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) return [];
      throw error;
    }
  }

  async function catalogRows(signal) {
    signal?.throwIfAborted();
    const projectDirs = (await listDirectory(root)).filter(entry => entry.isDirectory() && entry.name.startsWith('--'));
    const dirs = new Set([root, ...projectDirs.map(entry => join(root, entry.name)), ...customDirs]);
    if (sessionDir) dirs.add(sessionDir);
    const rows = new Map(drafts.map(row => [JSON.stringify([row.cwd, row.id]), row]));
    for (const dir of dirs) {
      signal?.throwIfAborted();
      const files = (await listDirectory(dir)).filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'));
      for (let start = 0; start < files.length; start += 8) {
        signal?.throwIfAborted();
        await Promise.all(files.slice(start, start + 8).map(async entry => {
          const file = join(dir, entry.name);
          try {
            const info = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            let stamp;
            let modified;
            try {
              const stat = await info.stat();
              if (!stat.isFile() || stat.size > maxArchive) return;
              modified = stat.mtimeMs;
              stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
            } finally { await info.close(); }
            let row = cache.get(file)?.stamp === stamp ? cache.get(file).row : undefined;
            if (!row) {
              row = archiveRow(await nativeJsonLines(file, signal), file, modified);
              cache.set(file, { stamp, row });
              if (cache.size > 2048) cache.delete(cache.keys().next().value);
            }
            const key = JSON.stringify([row.cwd, row.id]);
            const previous = rows.get(key);
            if (!previous?.path || newest(row, previous) < 0 || (row.updatedAt === previous.updatedAt && file < previous.path)) rows.set(key, row);
          } catch { signal?.throwIfAborted(); /* A malformed archive is never repaired during browsing. */ }
        }));
      }
    }
    return [...rows.values()].sort(newest);
  }

  async function find(cwd, id, signal) {
    signal?.throwIfAborted();
    if (!isId(id)) throw missing();
    const workspace = directory(cwd);
    const row = (await catalogRows(signal)).find(item => item.cwd === workspace && item.id === id);
    if (!row) throw missing();
    if (!row.path) return { row, branch: [] };
    try {
      const entries = await nativeJsonLines(row.path, signal);
      const current = archiveRow(entries, row.path, row.updatedAt);
      if (current.cwd !== workspace || current.id !== id) throw missing();
      return { row: current, branch: archiveBranch(entries) };
    } catch { signal?.throwIfAborted(); throw missing(); }
  }

  function observeFile(cwd, id, file) {
    if (typeof file !== 'string' || !isAbsolute(file) || !file.endsWith('.jsonl')) return;
    const parent = dirname(file);
    const dirKnown = parent === root || parent === sessionDir || dirname(parent) === root || customDirs.includes(parent);
    const nextDirs = dirKnown || customDirs.length >= 128 ? customDirs : [...customDirs, parent];
    let nextDrafts = drafts;
    try {
      if (statSync(file).isFile()) nextDrafts = drafts.filter(row => row.cwd !== cwd || row.id !== id);
    } catch { /* Pi creates the native file on the first committed message. */ }
    if (nextDirs !== customDirs || nextDrafts.length !== drafts.length) write(nextDrafts, nextDirs);
  }

  function selected() { return profile.snapshot().defaults.cwd; }

  return {
    selected, launch, browse: path => profile.browse(path), observeFile,
    updateWorkspace: patch => profile.updateWorkspace(patch),
    async workspaces(signal) {
      const { workspaces, defaults } = profile.snapshot();
      const rows = new Map(workspaces.map(({ path, name }) => [path, { cwd: path, name, saved: true, launch: path === launch }]));
      for (const { cwd } of await catalogRows(signal)) {
        if (!rows.has(cwd)) rows.set(cwd, { cwd, name: basename(cwd) || cwd, saved: false, launch: false });
      }
      return [...rows.values()].sort((a, b) => Number(b.cwd === defaults.cwd) - Number(a.cwd === defaults.cwd) || a.name.localeCompare(b.name));
    },
    async sessions(cwd, signal) {
      const workspace = directory(cwd);
      return (await catalogRows(signal)).filter(row => row.cwd === workspace).map(visible);
    },
    async resolve(cwd, id, signal) { return (await find(cwd, id, signal)).row; },
    async history(cwd, id, signal) {
      const { row, branch } = await find(cwd, id, signal);
      return { ...visible(row), messages: projectBranch(branch) };
    },
    createDraft(cwd, name) {
      const row = { id: randomUUID(), cwd: directory(cwd), title: name === undefined || name === '' ? '新会话' : sessionTitle(name),
        updatedAt: Date.now(), messageCount: 0 };
      if (drafts.length >= maxDrafts) throw new AppError(409, '空会话数量已达上限，请先继续现有会话。');
      write([...drafts, row]);
      return row;
    },
    renameDraft(cwd, id, title) {
      if (drafts.some(row => row.id === id && row.cwd === cwd)) {
        write(drafts.map(row => row.id === id && row.cwd === cwd ? { ...row, title } : row));
      }
    },
  };
}
