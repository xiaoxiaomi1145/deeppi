import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPiWebCatalog } from '../server/pi-web/catalog.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'deeppi-pi-web-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'one');
  const other = join(dir, 'two');
  const agentDir = join(dir, 'agent');
  const sessionDir = join(dir, 'native-sessions');
  await Promise.all([mkdir(cwd), mkdir(other), mkdir(agentDir), mkdir(sessionDir)]);
  const options = { workspace: cwd, agentDir, sessionDir, dataDir: join(dir, 'web') };
  const archive = async (id, workspace, entries) => {
    const file = join(sessionDir, `2026-01-01_${id}.jsonl`);
    await writeFile(file, [{ type: 'session', id, version: 3, cwd: workspace, timestamp: '2026-01-01T00:00:00.000Z' }, ...entries]
      .map(entry => JSON.stringify(entry)).join('\n'));
    return file;
  };
  return { cwd, other, options, archive, sessionDir, dir };
}

const message = (id, parentId, text, role = 'user') => ({ type: 'message', id, parentId, message: { role, content: text, timestamp: 1 } });

test('catalog opens only the selected native branch without rewriting the archive', async t => {
  const { options, cwd, other, archive } = await fixture(t);
  const file = await archive('native', other, [message('root', null, '你好'), message('stale', 'root', '旧分支'),
    message('leaf', 'root', '当前回复', 'assistant'), { type: 'session_info', id: 'name', parentId: 'leaf', name: '原生会话' }]);
  const before = await readFile(file);
  const catalog = createPiWebCatalog(options);
  assert.deepEqual((await catalog.workspaces()).map(row => row.cwd), [cwd, other]);
  assert.equal((await catalog.sessions(other))[0].title, '原生会话');
  assert.deepEqual((await catalog.history(other, 'native')).messages.map(row => row.text), ['你好', '当前回复']);
  await assert.rejects(catalog.resolve(cwd, 'native'), { status: 404 });
  assert.deepEqual(await readFile(file), before);
});

test('catalog rejects cycles and file aliases and observes cancellation', async t => {
  const { options, cwd, archive, sessionDir } = await fixture(t);
  const file = await archive('cycle', cwd, [message('a', 'a', 'bad')]);
  await symlink(file, join(sessionDir, 'alias.jsonl'));
  const catalog = createPiWebCatalog(options);
  assert.equal((await catalog.sessions(cwd)).length, 1);
  await assert.rejects(catalog.resolve(cwd, 'cycle'), { status: 404 });
  await assert.rejects(catalog.resolve(cwd, '../cycle'), { status: 404 });
  await assert.rejects(catalog.sessions(cwd, AbortSignal.abort()), { name: 'AbortError' });
});

test('workspaces and empty Pi session IDs persist without creating Pi archives', async t => {
  const { options, cwd, other, dir } = await fixture(t);
  let catalog = createPiWebCatalog(options);
  catalog.updateWorkspace({ action: 'save', path: other, name: '第二工作区', activate: true });
  const draft = catalog.createDraft(other, '空会话');
  assert.equal(draft.path, undefined);
  catalog = createPiWebCatalog(options);
  assert.equal(catalog.selected(), other);
  assert.equal((await catalog.sessions(other))[0].id, draft.id);
  assert.equal((await catalog.history(other, draft.id)).title, '空会话');
  assert.equal((await catalog.resolve(other, draft.id)).path, undefined);
  await assert.rejects(catalog.sessions(join(dir, 'missing')), { status: 400 });
  assert.equal((await catalog.workspaces())[0].cwd, other);
  assert.ok((await catalog.workspaces()).some(row => row.cwd === cwd));
});
