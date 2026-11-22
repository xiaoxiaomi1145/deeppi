import { useState, type FormEvent } from 'react';
import { errorText } from '../api';
import { Overlay, Panel } from '../Overlay';
import type { WorkspaceAction } from '../types';
import { DirectoryBrowser } from '../WorkspaceDrawer';
import { modelKey, type PiCommand } from '../pi/model';
import { ThinkingSlider } from '../pi/ThinkingSlider';
import styles from '../pi/Pi.module.css';
import type { BrowserSettings, BrowserState } from './model';
import { piWebApi } from './transport';

export function WorkspacePicker({ initialPath, onClose, onSave }: {
  initialPath: string;
  onClose: () => void;
  onSave: (action: WorkspaceAction) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(path: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await onSave({ action: 'save', path, name: name.trim() || undefined, activate: true }); onClose(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <Overlay title="添加工作区" side="right" onClose={onClose}><Panel title="添加工作区" onClose={onClose}>
    <div className={styles.settingsStack}>
      <label className={styles.field}>显示名称（可选）<input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <DirectoryBrowser initialPath={initialPath} onPick={path => void save(path)} pickLabel="添加工作区"
        disabled={busy} listDirectories={piWebApi.directories} />
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  </Panel></Overlay>;
}

export function BrowserSettingsPanel({ state, writable, onSave, onClose }: {
  state: BrowserState;
  writable: boolean;
  onSave: (patch: BrowserSettings) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(state.title);
  const [model, setModel] = useState(modelKey(state.model));
  const [thinking, setThinking] = useState(state.thinking);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const modelChanged = model !== modelKey(state.model);
  const changed = title.trim() !== state.title || modelChanged || thinking !== state.thinking;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !writable || !changed) return;
    const chosen = state.models.find(entry => modelKey(entry) === model);
    const patch: BrowserSettings = {};
    if (title.trim() !== state.title) patch.title = title.trim();
    if (modelChanged && chosen) patch.model = { provider: chosen.provider, id: chosen.id };
    if (!modelChanged && thinking !== state.thinking) patch.thinking = thinking;
    setBusy(true);
    setError('');
    try { await onSave(patch); onClose(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <Overlay title="会话设置" side="right" onClose={onClose}><Panel title="会话设置" onClose={onClose} onSubmit={event => void save(event)}
    footer={<button className={styles.primary} disabled={busy || !writable || !changed || !title.trim()}>{busy ? '正在保存…' : '保存'}</button>}>
    <div className={styles.settingsStack}>
      <label className={styles.field}>会话名称<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
      <label className={styles.field}>Pi 模型<select value={model} onChange={event => setModel(event.target.value)} disabled={!state.models.length}>
        {!model && <option value="">选择模型</option>}
        {state.model && !state.models.some(item => modelKey(item) === modelKey(state.model)) &&
          <option value={modelKey(state.model)}>{state.model.name} · {state.model.provider}</option>}
        {state.models.map(item => <option key={modelKey(item)} value={modelKey(item)}>{item.name} · {item.provider}</option>)}
      </select></label>
      {!state.models.length && <p className={styles.note}>在 Pi 中配置模型或登录服务商，然后重新打开会话。</p>}
      {modelChanged ? <p className={styles.note}>保存模型后可调整它支持的思考档位。</p> :
        <ThinkingSlider levels={state.levels} value={thinking} onChange={setThinking} disabled={busy || !writable} />}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  </Panel></Overlay>;
}

export function BrowserContextPanel({ state, writable, onClose }: { state: BrowserState; writable: boolean; onClose: () => void }) {
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function run(action: () => Promise<unknown>, success: string) {
    if (!writable || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); setNotice(success); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <Overlay title="Pi 上下文" side="right" onClose={onClose}><Panel title="Pi 上下文" onClose={onClose}>
    <div className={styles.settingsStack}>
      <p className={styles.note}>模型上下文窗口 {state.model?.contextWindow?.toLocaleString('zh-CN') ?? '—'} tokens</p>
      <label className={styles.checkRow}><input type="checkbox" checked={state.autoCompaction} disabled={!writable || busy}
        onChange={event => { const enabled = event.target.checked; void run(() => piWebApi.settings(state.generation, { autoCompaction: enabled }), '已更新自动压缩。'); }} />
        <span>Pi 原生自动压缩</span>
      </label>
      <label className={styles.field}>压缩重点（可选）<textarea value={focus} maxLength={4000} rows={4} onChange={event => setFocus(event.target.value)} /></label>
      <div><button type="button" className={styles.primary} disabled={!writable || !state.model || busy}
        onClick={() => void run(() => piWebApi.compact(state.generation, focus), 'Pi 压缩完成。')}>执行压缩</button></div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.note} role="status">{notice}</p>}
    </div>
  </Panel></Overlay>;
}

export function BrowserHelp({ commands, onClose }: { commands: readonly PiCommand[]; onClose: () => void }) {
  return <Overlay title="Pi 指令" side="right" onClose={onClose}><Panel title="Pi 指令" onClose={onClose}>
    <ul className={styles.helpCommands}>{commands.map(command => <li key={command.name}>
      <div><code>/{command.name}</code>{command.argumentHint && <small>{command.argumentHint}</small>}{command.kind === 'terminal' && <small>仅终端</small>}</div>
      <span>{command.description}</span>
    </li>)}</ul>
  </Panel></Overlay>;
}
