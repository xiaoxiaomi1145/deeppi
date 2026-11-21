import { randomUUID } from 'node:crypto';
import {
  accessSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AppError, credentialScope, defaults, directory, plainObject, resolveKey, updateSettings } from './settings.mjs';

const folderLimit = 200;
const scanLimit = 4096;
const compareNames = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;
const permissionDenied = error => error.code === 'EACCES' || error.code === 'EPERM';
const label = path => basename(path) || path;

function absolutePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
    throw new AppError(400, '目录路径格式无效。');
  }
  const path = value === '~' || value.startsWith('~/') ? `${homedir()}${value.slice(1)}` : value;
  if (!isAbsolute(path)) throw new AppError(400, '请输入绝对路径或以 ~/ 开头的路径。');
  return resolve(path);
}

function reachable(value) {
  const path = absolutePath(value);
  let canonical;
  try { canonical = directory(path); }
  catch (error) {
    // The shared validator deliberately hides filesystem errors. Probe existence
    // separately so an inaccessible parent is distinguished from a plain file.
    try { accessSync(path, constants.F_OK); }
    catch (cause) {
      if (permissionDenied(cause)) throw new AppError(403, '没有访问该目录的权限。');
    }
    throw error;
  }
  try { accessSync(canonical, constants.R_OK | constants.X_OK); }
  catch (error) {
    if (permissionDenied(error)) throw new AppError(403, '没有访问该目录的权限。');
    throw new AppError(400, '目录不存在或无法访问。');
  }
  return canonical;
}

function workspaceName(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 120 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new AppError(400, '工作区名称格式无效。');
  }
  return value.trim() || fallback;
}

function cleanKey(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new AppError(400, 'API Key 格式无效。');
  const key = value.trim();
  if (!key || /[\x00-\x20\x7f]/u.test(key)) throw new AppError(400, 'API Key 格式无效。');
  return key;
}

function readProfile(file) {
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Profile is not a private regular file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function writeProfile(dir, file, document) {
  const temp = join(dir, `.profile.${randomUUID()}.tmp`);
  let created = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(temp, 'wx', 0o600);
    created = true;
    try {
      fchmodSync(fd, 0o600);
      if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error('Profile permissions cannot be restricted');
      writeFileSync(fd, `${JSON.stringify(document)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, file);
    created = false;
  } catch {
    throw new AppError(500, '无法保存本地配置，请检查数据目录与权限。');
  } finally {
    if (created) {
      try { unlinkSync(temp); } catch { /* Best-effort cleanup of this private temporary file. */ }
    }
  }
}

export function createProfile({ dataDir, workspace, demo }) {
  const dir = resolve(dataDir);
  const file = join(dir, 'profile.json');
  const launch = reachable(workspace);
  let state = {
    defaults: defaults(launch, demo), workspaces: new Map([[launch, label(launch)]]), keys: new Map(),
  };
  let unreadable = false;

  try {
    const saved = readProfile(file);
    if (saved !== undefined) {
      if (saved?.version !== 1 || !plainObject(saved.defaults) || !Array.isArray(saved.workspaces) || !plainObject(saved.rememberedKeys)) {
        throw new Error('Unknown profile format');
      }
      const { cwd, allowBash: _allowBash, ...settings } = saved.defaults;
      const restoredDefaults = updateSettings(state.defaults, settings, demo);
      const workspaces = new Map(state.workspaces);
      for (const entry of saved.workspaces) {
        if (!plainObject(entry)) throw new Error('Invalid workspace entry');
        const path = absolutePath(entry.path);
        workspaces.set(path, workspaceName(entry.name, label(path)));
      }
      const selected = absolutePath(cwd);
      // Stale registrations remain removable. Loading never rewrites config or sessions.
      if (workspaces.has(selected)) {
        try { if (reachable(selected) === selected) restoredDefaults.cwd = selected; }
        catch (error) { if (!(error instanceof AppError)) throw error; }
      }
      const keys = new Map(Object.entries(saved.rememberedKeys).map(([scope, key]) => [scope, { key: cleanKey(key), remember: true }]));
      state = { defaults: restoredDefaults, workspaces, keys };
    }
  } catch {
    // Fall back to launch defaults, but do not replace unreadable or corrupt data.
    unreadable = true;
  }

  function snapshot() {
    const defaults = { ...state.defaults };
    const stored = state.keys.get(credentialScope(defaults));
    return {
      defaults, workspaces: Array.from(state.workspaces, ([path, name]) => ({ path, name })),
      hasDefaultKey: Boolean(resolveKey(defaults, stored?.key)), rememberedKey: Boolean(stored?.remember),
    };
  }

  function commit(next) {
    if (unreadable) throw new AppError(409, '无法读取本地配置。请检查 profile.json 的内容和权限并重启 Deeppi；原文件未被覆盖。');
    const remembered = [...next.keys].filter(([, entry]) => entry.remember).map(([scope, entry]) => [scope, entry.key]);
    writeProfile(dir, file, {
      version: 1, defaults: next.defaults,
      workspaces: Array.from(next.workspaces, ([path, name]) => ({ path, name })),
      rememberedKeys: Object.fromEntries(remembered),
    });
    state = next;
    return snapshot();
  }

  function update(body) {
    if (!plainObject(body)) throw new AppError(400, '本地配置必须是一个对象。');
    const patch = body.settings;
    let nextDefaults = state.defaults;
    if (patch !== undefined) {
      if (!plainObject(patch)) throw new AppError(400, '设置必须是一个对象。');
      if (patch.allowBash === true) throw new AppError(403, 'Bash 只能在会话设置中启用。');
      const settings = { ...patch };
      if (Object.hasOwn(settings, 'cwd')) {
        const cwd = reachable(settings.cwd);
        if (!state.workspaces.has(cwd)) throw new AppError(400, '请先保存该工作区。');
        settings.cwd = cwd;
      }
      nextDefaults = updateSettings(state.defaults, settings, demo);
    }
    if (body.rememberKey !== undefined && typeof body.rememberKey !== 'boolean') {
      throw new AppError(400, 'rememberKey 必须是布尔值。');
    }
    const keys = new Map(state.keys);
    const scope = credentialScope(nextDefaults);
    const previous = keys.get(scope);
    let key = previous?.key;
    if (Object.hasOwn(body, 'apiKey')) {
      if (body.apiKey === null) key = undefined;
      else {
        if (nextDefaults.provider === 'demo') throw new AppError(400, '演示模型不需要 API Key。');
        key = cleanKey(body.apiKey);
      }
    }
    if (key) keys.set(scope, { key, remember: body.rememberKey ?? previous?.remember ?? false });
    else keys.delete(scope);
    return commit({ ...state, defaults: nextDefaults, keys });
  }

  function updateWorkspace(body) {
    if (!plainObject(body)) throw new AppError(400, '工作区设置必须是一个对象。');
    const workspaces = new Map(state.workspaces);
    let cwd = state.defaults.cwd;
    if (body.action === 'save') {
      if (body.activate !== undefined && typeof body.activate !== 'boolean') throw new AppError(400, 'activate 必须是布尔值。');
      const path = reachable(body.path);
      workspaces.set(path, workspaceName(body.name, workspaces.get(path) ?? label(path)));
      if (body.activate) cwd = path;
    } else if (body.action === 'select') {
      const path = reachable(body.path);
      if (!workspaces.has(path)) throw new AppError(404, '工作区未保存。');
      cwd = path;
    } else if (body.action === 'remove') {
      let path = absolutePath(body.path);
      if (!workspaces.has(path)) path = reachable(path);
      if (path === launch) throw new AppError(409, '不能移除启动工作区。');
      if (!workspaces.delete(path)) throw new AppError(404, '工作区未保存。');
      if (path === cwd) cwd = launch;
    } else {
      throw new AppError(400, '不支持该工作区操作。');
    }
    return commit({ ...state, defaults: { ...state.defaults, cwd }, workspaces });
  }

  function browse(value = state.defaults.cwd) {
    const path = reachable(value);
    const parent = dirname(path);
    const folders = [];
    let truncated = false;
    try {
      const entries = opendirSync(path);
      try {
        for (let scanned = 0; ; scanned++) {
          const entry = entries.readSync();
          if (!entry) break;
          if (scanned === scanLimit) { truncated = true; break; }
          // This listing omits dot entries and symlinks, but explicit paths can resolve either.
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          if (folders.length === folderLimit) { truncated = true; break; }
          folders.push({ path: join(path, entry.name), name: entry.name });
        }
      } finally { entries.closeSync(); }
    } catch (error) {
      if (permissionDenied(error)) throw new AppError(403, '没有读取该目录的权限。');
      throw new AppError(400, '无法读取该目录。');
    }
    folders.sort((a, b) => compareNames(a.name, b.name) || (a.name < b.name ? -1 : a.name === b.name ? 0 : 1));
    return { path, parent: parent === path ? null : parent, folders, truncated };
  }

  return { snapshot, keyFor: settings => state.keys.get(credentialScope(settings))?.key, update, updateWorkspace, browse };
}
