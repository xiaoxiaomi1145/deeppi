import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPiCatalog } from '../server/pi/catalog.mjs';

const time = Date.UTC(2026, 0, 1);
const prompt = (content, timestamp = time) => ({ role: 'user', content, timestamp });
const diskJSONL = entries => entries.map(entry => JSON.stringify(entry)).join('\n');

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deeppi-pi-catalog-')));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent-home');
  t.after(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const { SessionManager, CURRENT_SESSION_VERSION } = await import('@earendil-works/pi-coding-agent');
  const catalog = createPiCatalog({
    SessionManager,
    projectBranch: entries => entries.filter(entry => entry.type === 'message').map(({ id, message }) => ({
      id, role: message.role, text: message.content, timestamp: message.timestamp,
    })),
  });
  const cwd = (...parts) => join(root, 'work', ...parts);
  const context = sessionManager => ({ cwd: sessionManager.getCwd(), sessionManager });
  return { root, cwd, context, catalog, SessionManager, CURRENT_SESSION_VERSION };
}

const allSessions = result => result.workspaces.flatMap(group => group.sessions);
const missing = error => {
  assert.equal(error.status, 404);
  assert.doesNotMatch(error.message, /[\\/]|\.jsonl/);
  return true;
};

function save(SessionManager, cwd, id, content, { dir, name, at } = {}) {
  const manager = SessionManager.create(cwd, dir, { id });
  manager.appendMessage(prompt(content, at));
  if (name) manager.appendSessionInfo(name);
  return manager;
}

test('catalog groups native and explicit-directory sessions by full working directory and includes the unsaved current conversation', async t => {
  const { cwd, root, catalog, context, SessionManager } = await fixture(t);
  const first = cwd('one', 'same');
  const second = cwd('two', 'same');
  const now = cwd('current');
  const customDir = join(root, 'separate-sessions');
  await Promise.all([first, second, now].map(path => mkdir(path, { recursive: true })));
  save(SessionManager, first, 'first-real-id', 'first prompt', { name: 'Renamed session' });
  save(SessionManager, second, 'second-real-id', 'remote folder');
  // Pi list(cwd, customDir) omits sessions for other cwd values, even though they share that directory.
  save(SessionManager, second, 'custom-session-id', 'external storage', { dir: customDir, at: time + 1 });
  const active = SessionManager.create(now, customDir, { id: 'unsaved-current' });

  const listing = await catalog.list(context(active));
  assert.equal(listing.currentId, active.getSessionId());
  const groups = new Map(listing.workspaces.map(group => [group.cwd, group]));
  assert.equal(groups.size, 3);
  assert.equal(groups.get(first).name, first);
  assert.equal(groups.get(second).name, second);
  assert.deepEqual(groups.get(first).sessions, [{ id: 'first-real-id', title: 'Renamed session', updatedAt: time, messageCount: 1 }]);
  assert.deepEqual(groups.get(second).sessions.map(session => [session.id, session.title]), [
    ['custom-session-id', 'external storage'], ['second-real-id', 'remote folder'],
  ]);
  assert.deepEqual(groups.get(now).sessions.map(session => [session.id, session.messageCount]), [[active.getSessionId(), 0]]);
  assert.deepEqual((await catalog.history(context(active), active.getSessionId())).messages, []);
  await assert.rejects(catalog.resolve(context(active), active.getSessionId()), missing);
  assert.doesNotMatch(JSON.stringify(listing), /\.jsonl|separate-sessions|agent-home/);
});

test('catalog resolves native session IDs, prefers the current file for duplicates and rejects a supplied file path', async t => {
  const { cwd, root, catalog, context, SessionManager } = await fixture(t);
  const dir = join(root, 'explicit-dir');
  const active = save(SessionManager, cwd('active'), 'duplicate-id', 'Current source', { dir, name: 'Active file' });
  const other = save(SessionManager, cwd('other'), 'duplicate-id', 'Newer copy', { at: time + 100 });
  const ordinary = save(SessionManager, cwd('other'), 'other-session', 'External file');
  const ctx = context(active);

  assert.deepEqual(await catalog.resolve(ctx, active.getSessionId()), {
    id: active.getSessionId(), path: active.getSessionFile(), cwd: active.getCwd(), title: 'Active file', updatedAt: time,
  });
  assert.deepEqual(await catalog.resolve(ctx, ordinary.getSessionId()), {
    id: ordinary.getSessionId(), path: ordinary.getSessionFile(), cwd: ordinary.getCwd(), title: 'External file', updatedAt: time,
  });
  assert.deepEqual(allSessions(await catalog.list(ctx)).filter(row => row.id === 'duplicate-id').map(row => row.title), ['Active file']);
  await assert.rejects(catalog.resolve(ctx, other.getSessionFile()), missing);
  await assert.rejects(catalog.history(ctx, 'absent-session'), missing);
  await rm(ordinary.getSessionFile());
  await assert.rejects(catalog.resolve(ctx, ordinary.getSessionId()), missing);
});

test('history projects only the native selected branch without repairing or rewriting archived JSONL', async t => {
  const { cwd, catalog, context, SessionManager } = await fixture(t);
  const archived = SessionManager.create(cwd('archive'), undefined, { id: 'archive-id' });
  const rootEntry = archived.appendMessage(prompt('shared question'));
  archived.appendMessage(prompt('discarded branch', time + 1));
  archived.branch(rootEntry);
  const chosen = archived.appendMessage(prompt('selected branch', time + 2));
  const path = archived.getSessionFile();
  const original = (await readFile(path, 'utf8')).trimEnd();
  await writeFile(path, original);
  const active = SessionManager.inMemory(cwd('current'), { id: 'active-id' });

  const archivedView = await catalog.history(context(active), 'archive-id');
  assert.deepEqual(archivedView, {
    id: 'archive-id', title: 'shared question', cwd: archived.getCwd(), updatedAt: time + 2,
    messages: [
      { id: rootEntry, role: 'user', text: 'shared question', timestamp: time },
      { id: chosen, role: 'user', text: 'selected branch', timestamp: time + 2 },
    ],
  });
  assert.equal(await readFile(path, 'utf8'), original);
});

test('current history follows the live Pi leaf even when the last entry on disk belongs to a different branch', async t => {
  const { cwd, catalog, context, SessionManager } = await fixture(t);
  const active = SessionManager.create(cwd('live'), undefined, { id: 'active-id' });
  const rootEntry = active.appendMessage(prompt('still selected'));
  active.appendMessage(prompt('disk leaf must not appear', time + 1));
  active.branch(rootEntry);
  const current = await catalog.history(context(active), active.getSessionId());
  assert.deepEqual(current.messages.map(message => message.text), ['still selected']);
});

test('legacy sessions are displayed without migrations on disk and malformed records do not leak their path', async t => {
  const { cwd, catalog, context, SessionManager, CURRENT_SESSION_VERSION } = await fixture(t);
  const active = SessionManager.create(cwd('legacy'), undefined, { id: 'active-id' });
  const datestring = new Date(time).toISOString();
  const header = (id, version) => ({ type: 'session', version, id, timestamp: datestring, cwd: active.getCwd() });
  const legacyPath = join(active.getSessionDir(), 'legacy.jsonl');
  const original = diskJSONL([header('legacy-id', 1), { type: 'message', timestamp: datestring, message: prompt('old Pi message') }]);
  await writeFile(legacyPath, original);
  await writeFile(join(active.getSessionDir(), 'malformed.jsonl'), '{not a Pi session}\n');
  await writeFile(join(active.getSessionDir(), 'cycle.jsonl'), diskJSONL([
    header('cycle-id', CURRENT_SESSION_VERSION),
    { type: 'message', id: 'loop', parentId: 'loop', timestamp: datestring, message: prompt('self-parenting record') },
  ]));
  const ctx = context(active);

  assert.deepEqual((await catalog.history(ctx, 'legacy-id')).messages.map(message => message.text), ['old Pi message']);
  assert.equal(await readFile(legacyPath, 'utf8'), original);
  assert.ok(!allSessions(await catalog.list(ctx)).some(({ id }) => id === 'malformed'));
  await assert.rejects(catalog.history(ctx, 'cycle-id'), missing);
  await assert.rejects(catalog.resolve(ctx, 'cycle-id'), missing);
});

test('catalog keeps the current row and currentId aligned when Pi starts a new conversation during the scan', async t => {
  const { cwd, catalog, context, SessionManager } = await fixture(t);
  const active = save(SessionManager, cwd('current'), 'archived-id', 'Original question');
  const pending = catalog.list(context(active));
  active.newSession({ id: 'new-current' });

  const result = await pending;
  assert.equal(result.currentId, active.getSessionId());
  assert.deepEqual(allSessions(result).map(row => row.id).sort(), ['archived-id', 'new-current']);
});

test('catalog reads respect caller cancellation', async t => {
  const { cwd, catalog, context, SessionManager } = await fixture(t);
  const ctx = context(SessionManager.inMemory(cwd('current'), { id: 'active-id' }));
  const reason = new Error('request disconnected');
  const signal = AbortSignal.abort(reason);

  await assert.rejects(catalog.list(ctx, signal), error => error === reason);
  await assert.rejects(catalog.resolve(ctx, 'active-id', signal), error => error === reason);
  await assert.rejects(catalog.history(ctx, 'active-id', signal), error => error === reason);
});
