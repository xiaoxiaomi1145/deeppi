import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';
import test from 'node:test';
import { createProfile } from '../server/profile.mjs';
import { AppError } from '../server/settings.mjs';

function fixture(t, demo = false) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'deeppi-profile-test-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.ok(dirname(target) === parent && basename(target).startsWith('deeppi-profile-test-'));
    rmSync(target, { recursive: true });
  });
  const workspace = join(root, 'launch');
  const dataDir = join(root, 'data');
  mkdirSync(workspace);
  mkdirSync(dataDir);
  return {
    root, workspace, dataDir,
    file: join(dataDir, 'profile.json'),
    open: () => createProfile({ dataDir, workspace, demo }),
  };
}

function env(t, name, value) {
  const old = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

function expectError(fn, status) {
  assert.throws(fn, error => error instanceof AppError && (status === undefined || error.status === status));
}

const keyA = 'test-only-fake-key-a';
const keyB = 'test-only-fake-key-b';
const routeA = { provider: 'deepseek', baseUrl: 'https://example.invalid/a' };
const routeB = { provider: 'deepseek', baseUrl: 'https://example.invalid/b' };

// A launch must not create, expose, or implicitly enable executable defaults.
test('launch defaults register the launch root and snapshots are detached', t => {
  const { workspace, open } = fixture(t, true);
  const profile = open();
  const initial = profile.snapshot();
  assert.deepEqual(Object.keys(initial).sort(), ['defaults', 'hasDefaultKey', 'rememberedKey', 'workspaces']);
  assert.equal(initial.defaults.provider, 'demo');
  assert.equal(initial.defaults.cwd, workspace);
  assert.equal(initial.defaults.allowBash, false);
  assert.deepEqual(initial.workspaces, [{ path: workspace, name: 'launch' }]);
  assert.equal(initial.hasDefaultKey, false);
  assert.equal(initial.rememberedKey, false);
  initial.defaults.cwd = '/other';
  initial.workspaces[0].name = 'changed';
  assert.equal(profile.snapshot().defaults.cwd, workspace);
  assert.equal(profile.snapshot().workspaces[0].name, 'launch');
});

test('valid defaults survive restart and invalid updates neither enable Bash nor change disk', t => {
  const { open, file } = fixture(t);
  const profile = open();
  const saved = profile.update({ settings: { model: 'model-a', systemPrompt: 'Brief answers.', maxTurns: 5 } });
  assert.equal(saved.defaults.provider, 'deepseek');
  assert.equal(saved.defaults.systemPrompt, 'Brief answers.');
  assert.equal(saved.defaults.maxTurns, 5);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = readFileSync(file, 'utf8');
  expectError(() => profile.update({ settings: { allowBash: true, model: 'other-model' } }), 403);
  expectError(() => profile.update({ settings: { maxTurns: 0 } }), 400);
  expectError(() => profile.update({ settings: { cwd: '/not/a/saved/project' } }), 400);
  expectError(() => profile.update({ rememberKey: 'true' }), 400);
  expectError(() => profile.update({ apiKey: 'bad\nkey' }), 400);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(open().snapshot().defaults, saved.defaults);
  const tampered = JSON.parse(before);
  tampered.defaults.allowBash = true;
  writeFileSync(file, JSON.stringify(tampered));
  const reopened = open().snapshot();
  assert.equal(reopened.defaults.allowBash, false);
  assert.equal(reopened.defaults.systemPrompt, 'Brief answers.');
});

test('manual keys are memory-only by default and do not cross provider or URL boundaries', t => {
  const { open, file } = fixture(t);
  const profile = open();
  const snapshot = profile.update({ settings: { ...routeA, baseUrl: `${routeA.baseUrl}/` }, apiKey: keyA });
  assert.equal(snapshot.defaults.baseUrl, routeA.baseUrl);
  assert.equal(snapshot.hasDefaultKey, true);
  assert.equal(snapshot.rememberedKey, false);
  assert.equal(profile.keyFor(snapshot.defaults), keyA);
  assert.equal(profile.keyFor(routeB), undefined);
  assert.equal(profile.keyFor({ ...routeA, provider: 'openai-compatible' }), undefined);
  assert.equal(profile.keyFor({ ...routeA, baseUrl: '' }), undefined);
  assert.ok(!JSON.stringify(snapshot).includes(keyA));
  assert.ok(!readFileSync(file, 'utf8').includes(keyA));
  assert.equal(open().keyFor(routeA), undefined);
  assert.equal(open().snapshot().hasDefaultKey, false);
});

test('explicit remember applies to that scope only, and unchecking or clearing removes the disk key', t => {
  const { open, file } = fixture(t);
  const profile = open();
  profile.update({ settings: routeA, apiKey: keyA });
  assert.equal(profile.update({ rememberKey: true }).rememberedKey, true);
  assert.ok(!JSON.stringify(profile.snapshot()).includes(keyA));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(open().keyFor(routeA), keyA);
  assert.equal(profile.update({ settings: routeB, apiKey: keyB }).rememberedKey, false);
  assert.equal(open().keyFor(routeA), keyA);
  assert.equal(open().keyFor(routeB), undefined);
  assert.equal(profile.update({ settings: routeA }).rememberedKey, true);
  assert.equal(profile.update({ apiKey: keyB }).rememberedKey, true);
  assert.equal(open().keyFor(routeA), keyB);

  const unremembered = profile.update({ rememberKey: false });
  assert.equal(unremembered.hasDefaultKey, true);
  assert.equal(unremembered.rememberedKey, false);
  assert.equal(profile.keyFor(routeA), keyB);
  assert.equal(open().keyFor(routeA), undefined);
  assert.ok(!readFileSync(file, 'utf8').includes(keyB));
  profile.update({ rememberKey: true });
  assert.equal(open().keyFor(routeA), keyB);
  assert.equal(profile.update({ apiKey: null }).hasDefaultKey, false);
  assert.equal(profile.keyFor(routeA), undefined);
  assert.equal(profile.keyFor(routeB), keyB);
  assert.equal(open().keyFor(routeA), undefined);
  assert.ok(!readFileSync(file, 'utf8').includes(keyB));
});

test('environment credentials count as available but are never copied to profile storage', t => {
  env(t, 'DEEPSEEK_API_KEY', keyA);
  const { open, file } = fixture(t);
  const profile = open();
  const before = profile.snapshot();
  assert.equal(before.hasDefaultKey, true);
  assert.equal(profile.keyFor(before.defaults), undefined);
  const after = profile.update({ rememberKey: true });
  assert.equal(after.hasDefaultKey, true);
  assert.equal(after.rememberedKey, false);
  assert.ok(!readFileSync(file, 'utf8').includes(keyA));
  assert.equal(profile.update({ settings: routeA }).hasDefaultKey, false);
});

test('workspace save canonicalizes home paths and aliases, persists selection, and only removes registrations', t => {
  const { root, workspace, open } = fixture(t);
  const second = join(root, 'second');
  const alias = join(root, 'alias');
  const sentinel = join(second, 'session-sentinel');
  mkdirSync(second);
  symlinkSync(second, alias, 'dir');
  writeFileSync(sentinel, 'do not delete');
  env(t, 'HOME', root);
  const profile = open();
  const saved = profile.updateWorkspace({ action: 'save', path: '~/second', name: ' Second project ' });
  assert.equal(saved.defaults.cwd, workspace);
  assert.deepEqual(saved.workspaces, [{ path: workspace, name: 'launch' }, { path: second, name: 'Second project' }]);
  const deduped = profile.updateWorkspace({ action: 'save', path: alias, activate: true });
  assert.deepEqual(deduped.workspaces, saved.workspaces);
  assert.equal(deduped.defaults.cwd, second);
  assert.deepEqual(open().snapshot().workspaces, saved.workspaces);
  assert.equal(open().snapshot().defaults.cwd, second);
  assert.equal(profile.updateWorkspace({ action: 'select', path: workspace }).defaults.cwd, workspace);
  assert.equal(profile.update({ settings: { cwd: second } }).defaults.cwd, second);
  expectError(() => profile.updateWorkspace({ action: 'remove', path: workspace }), 409);
  expectError(() => profile.updateWorkspace({ action: 'select', path: root }), 404);
  expectError(() => profile.updateWorkspace({ action: 'save', path: 'relative' }), 400);
  expectError(() => profile.updateWorkspace({ action: 'save', path: sentinel }), 400);
  expectError(() => profile.updateWorkspace({ action: 'save', path: second, activate: 'true' }), 400);
  expectError(() => profile.updateWorkspace({ action: 'erase', path: second }), 400);
  const removed = profile.updateWorkspace({ action: 'remove', path: second });
  assert.deepEqual(removed.workspaces, [{ path: workspace, name: 'launch' }]);
  assert.equal(removed.defaults.cwd, workspace);
  assert.equal(readFileSync(sentinel, 'utf8'), 'do not delete');
  assert.deepEqual(open().snapshot().workspaces, removed.workspaces);
});

test('browse returns sorted visible directories, canonical paths and the parent, never file contents', t => {
  const { root, workspace, open } = fixture(t);
  env(t, 'HOME', workspace);
  for (const name of ['zebra', 'alpha', '.dot']) mkdirSync(join(workspace, name));
  writeFileSync(join(workspace, 'a-file'), 'not a folder');
  symlinkSync(join(workspace, 'zebra'), join(workspace, 'link'), 'dir');
  const profile = open();
  const found = profile.browse();
  assert.deepEqual(found, {
    path: workspace, parent: root,
    folders: [{ path: join(workspace, 'alpha'), name: 'alpha' }, { path: join(workspace, 'zebra'), name: 'zebra' }],
    truncated: false,
  });
  assert.deepEqual(profile.browse('~'), found);
  assert.equal(profile.browse(join(workspace, 'link')).path, join(workspace, 'zebra'));
  const filesystemRoot = parse(workspace).root;
  let rootDenied = false;
  try { accessSync(filesystemRoot, constants.R_OK | constants.X_OK); }
  catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
    rootDenied = true;
  }
  if (rootDenied) expectError(() => profile.browse(filesystemRoot), 403);
  else assert.equal(profile.browse(filesystemRoot).parent, null);
  for (const path of ['relative', 'x\0x', join(workspace, 'a-file'), join(workspace, 'missing')]) {
    expectError(() => profile.browse(path), 400);
  }
  const denied = join(workspace, 'denied');
  mkdirSync(denied, 0o000);
  try {
    let inaccessible = false;
    try { accessSync(denied, constants.R_OK | constants.X_OK); } catch (error) { inaccessible = error.code === 'EACCES' || error.code === 'EPERM'; }
    if (inaccessible) expectError(() => profile.browse(denied), 403);
  } finally { chmodSync(denied, 0o700); }
});

test('wide directory listings are bounded and marked truncated', t => {
  const { workspace, open } = fixture(t);
  for (let i = 0; i < 300; i++) mkdirSync(join(workspace, `folder-${String(i).padStart(3, '0')}`));
  const listing = open().browse();
  assert.equal(listing.truncated, true);
  assert.ok(listing.folders.length > 0 && listing.folders.length < 300);
  const names = listing.folders.map(folder => folder.name);
  assert.deepEqual(names, [...names].sort());
});

test('stale active workspace falls back without resetting saved settings, keys, or session data', t => {
  const { root, workspace, dataDir, file, open } = fixture(t);
  const stale = join(root, 'stale');
  mkdirSync(stale);
  const session = join(dataDir, 'session-sentinel.json');
  writeFileSync(session, 'untouched');
  const profile = open();
  profile.updateWorkspace({ action: 'save', path: stale, activate: true });
  profile.update({ settings: { ...routeA, systemPrompt: 'still here' }, apiKey: keyA, rememberKey: true });
  const before = readFileSync(file, 'utf8');
  assert.equal(realpathSync(stale), join(root, 'stale'));
  rmdirSync(stale);
  const reopened = open();
  const snapshot = reopened.snapshot();
  assert.equal(snapshot.defaults.cwd, workspace);
  assert.equal(snapshot.defaults.systemPrompt, 'still here');
  assert.equal(reopened.keyFor(routeA), keyA);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readFileSync(session, 'utf8'), 'untouched');
  assert.ok(!reopened.updateWorkspace({ action: 'remove', path: stale }).workspaces.some(entry => entry.path === stale));
});

test('corrupt profile cannot be silently overwritten with provisional defaults', t => {
  const { file, workspace, open } = fixture(t);
  const broken = '{ incomplete json';
  writeFileSync(file, broken, { mode: 0o600 });
  const profile = open();
  assert.equal(profile.snapshot().defaults.cwd, workspace);
  assert.equal(profile.browse().path, workspace);
  assert.equal(readFileSync(file, 'utf8'), broken);
  expectError(() => profile.update({ settings: { systemPrompt: 'new settings' } }), 409);
  expectError(() => profile.updateWorkspace({ action: 'select', path: workspace }), 409);
  assert.equal(readFileSync(file, 'utf8'), broken);
});

test('a failed atomic write leaves memory unchanged and does not retain a temp key file', t => {
  const { file, dataDir, open } = fixture(t);
  const profile = open();
  const before = profile.snapshot();
  mkdirSync(file);
  expectError(() => profile.update({ settings: routeA, apiKey: keyA, rememberKey: true }), 500);
  assert.deepEqual(profile.snapshot(), before);
  assert.equal(profile.keyFor(routeA), undefined);
  assert.deepEqual(readdirSync(dataDir), ['profile.json']);
  assert.ok(statSync(file).isDirectory());
});
