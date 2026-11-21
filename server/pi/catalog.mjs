import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve as absolutePath, sep } from 'node:path';
import { getAgentDir, migrateSessionEntries, parseSessionEntries } from '@earendil-works/pi-coding-agent';
import { AppError } from '../settings.mjs';

const missing = () => new AppError(404, '未找到可读取的 Pi 会话。');
const isId = id => typeof id === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(id);
const cwdPath = cwd => typeof cwd === 'string' && isAbsolute(cwd) ? absolutePath(cwd) : '';
const order = (a, b) => a === b ? 0 : a < b ? -1 : 1;

function timestamp(value) {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  return Number.isFinite(time) ? time : 0;
}

function title(name, firstMessage) {
  const brief = text => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim().slice(0, 100) : '';
  return brief(name) || brief(firstMessage) || '新会话';
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join(' ');
}

function liveInfo(ctx, branch) {
  const manager = ctx.sessionManager;
  let firstMessage = '';
  let activity = 0;
  let messageCount = 0;
  for (const { type, message, timestamp: writtenAt } of branch) {
    if (type !== 'message' || !message) continue;
    messageCount++;
    if (message.role === 'user') firstMessage ||= userText(message.content);
    if (message.role === 'user' || message.role === 'assistant') {
      activity = Math.max(activity, timestamp(message.timestamp) || timestamp(writtenAt));
    }
  }
  return {
    id: manager.getSessionId(), cwd: cwdPath(ctx.cwd || manager.getCwd()),
    title: title(manager.getSessionName(), firstMessage),
    updatedAt: activity || timestamp(manager.getHeader()?.timestamp), messageCount,
  };
}

function publicResolution({ id, path, cwd, title, updatedAt }) {
  return { id, path, cwd, title, updatedAt };
}

// listAll() reads direct subdirectories of the Pi agent's sessions directory.
function needsExplicitIndex(sessionDir) {
  if (!sessionDir) return false;
  const fromRoot = relative(join(getAgentDir(), 'sessions'), sessionDir);
  return !fromRoot || fromRoot === '..' || fromRoot.includes(sep) || isAbsolute(fromRoot);
}

function parseArchive(text, id) {
  const entries = parseSessionEntries(text);
  if (entries[0]?.type !== 'session' || entries[0].id !== id ||
      entries.some(entry => !entry || typeof entry.type !== 'string')) throw missing();
  migrateSessionEntries(entries);
  // Pi walks parent pointers without a cycle guard. Each native entry is appended
  // after its parent; validate that invariant before traversing an archived file.
  const seen = new Set();
  for (const entry of entries.slice(1)) {
    if (entry.type === 'session' || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id) ||
        (entry.parentId !== null && !seen.has(entry.parentId))) throw missing();
    seen.add(entry.id);
  }
  return entries;
}

export function createPiCatalog({ SessionManager, projectBranch }) {
  async function readIndex(ctx, signal) {
    signal?.throwIfAborted();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const indexes = [SessionManager.listAll(undefined, signal)];
    if (needsExplicitIndex(sessionDir)) indexes.push(SessionManager.listAll(sessionDir, undefined, signal));
    const sessions = (await Promise.all(indexes)).flat();
    signal?.throwIfAborted();
    const manager = ctx.sessionManager;
    const currentId = manager.getSessionId();
    const currentFile = manager.getSessionFile();
    const currentPath = currentFile ? absolutePath(currentFile) : undefined;
    const byId = new Map();
    for (const session of sessions) {
      if (!isId(session.id) || typeof session.path !== 'string' || !session.path) continue;
      const path = absolutePath(session.path);
      const current = path === currentPath && session.id === currentId;
      const candidate = {
        id: session.id, path, cwd: cwdPath(session.cwd) || (current ? cwdPath(ctx.cwd || manager.getCwd()) : ''),
        title: title(session.name, session.firstMessage === '(no messages)' ? '' : session.firstMessage),
        updatedAt: timestamp(session.modified) || timestamp(session.created), messageCount: session.messageCount,
      };
      const existing = byId.get(candidate.id);
      if (!existing || current || (existing.path !== currentPath && (
        candidate.updatedAt > existing.updatedAt ||
        (candidate.updatedAt === existing.updatedAt && order(candidate.path, existing.path) < 0)
      ))) byId.set(candidate.id, candidate);
    }
    return { byId, currentId, currentPath };
  }

  async function list(ctx, signal) {
    const { byId } = await readIndex(ctx, signal);
    const current = liveInfo(ctx, ctx.sessionManager.getBranch());
    const currentId = current.id;
    const rows = [current, ...[...byId.values()].filter(row => row.id !== currentId)]
      .sort((a, b) => b.updatedAt - a.updatedAt || order(a.id, b.id));
    const byCwd = new Map([[current.cwd, []]]);
    for (const { cwd, id, title, updatedAt, messageCount } of rows) {
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      byCwd.get(cwd).push({ id, title, updatedAt, messageCount });
    }
    const label = cwd => basename(cwd) || cwd || '未知工作区';
    const counts = new Map();
    for (const cwd of byCwd.keys()) counts.set(label(cwd), (counts.get(label(cwd)) ?? 0) + 1);
    const workspaces = [...byCwd].map(([cwd, sessions]) => ({
      cwd, name: counts.get(label(cwd)) > 1 && cwd ? cwd : label(cwd), sessions,
    }));
    return { currentId, workspaces };
  }

  async function findRecord(ctx, id, signal) {
    signal?.throwIfAborted();
    if (!isId(id)) throw missing();
    const { byId, currentId, currentPath } = await readIndex(ctx, signal);
    const found = byId.get(id);
    if (!found || (id === currentId && found.path !== currentPath)) throw missing();
    return found;
  }

  async function readArchive({ id, path }, signal) {
    try {
      // open() and Pi's internal file loader can migrate/repair the source JSONL.
      const text = await readFile(path, { encoding: 'utf8', signal });
      signal?.throwIfAborted();
      return parseArchive(text, id);
    } catch {
      signal?.throwIfAborted();
      throw missing();
    }
  }

  async function resolve(ctx, id, signal) {
    const found = await findRecord(ctx, id, signal);
    // Check the archive before handing the path to Pi's stateful switch operation.
    await readArchive(found, signal);
    return publicResolution(found);
  }

  async function history(ctx, id, signal) {
    signal?.throwIfAborted();
    if (!isId(id)) throw missing();
    if (id === ctx.sessionManager.getSessionId()) {
      const branch = ctx.sessionManager.getBranch();
      const { cwd, title, updatedAt } = liveInfo(ctx, branch);
      return { id, title, cwd, updatedAt, messages: projectBranch(branch) };
    }
    const found = await findRecord(ctx, id, signal);
    const { title, cwd, updatedAt } = found;
    const entries = await readArchive(found, signal);
    try {
      const branch = SessionManager.inMemory(cwd || ctx.cwd, undefined, entries).getBranch();
      return { id, title, cwd, updatedAt, messages: projectBranch(branch) };
    } catch {
      throw missing();
    }
  }

  return { list, resolve, history };
}
