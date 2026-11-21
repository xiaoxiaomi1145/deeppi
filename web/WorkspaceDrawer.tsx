import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';
import { Overlay, Panel } from './Overlay';
import type { DirectoryListing, Info, WorkspaceAction } from './types';
import { Button } from './upstream/Button';
import { IconButton } from './upstream/IconButton';
import { IconTrashOutline16 } from './upstream/icons';
import styles from './Client.module.css';

export function FolderIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
    <path d="M2 4.3a1 1 0 0 1 1-1h3.1l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
  </svg>;
}

export function pathName(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function DirectoryBrowser({ initialPath, onPick, pickLabel, disabled = false }: {
  initialPath: string;
  onPick: (path: string) => void;
  pickLabel: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<AbortController>();

  function open(path?: string) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError('');
    void api.folders(path, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setListing(next);
      setInput(next.path);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorText(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }
  useEffect(() => {
    open(initialPath);
    return () => active.current?.abort();
  }, [initialPath]);

  const path = input.trim();
  return <div className={styles.directoryBrowser} aria-busy={loading}>
    <div className={styles.directoryControls}>
      <Button variant="outlined" disabled={disabled || loading || !listing?.parent} onClick={() => open(listing?.parent ?? undefined)}>
        <span aria-hidden="true">↑</span> 上一级
      </Button>
      <label className={styles.field}><span className="srOnly">目录路径</span>
        <input value={input} spellCheck={false} maxLength={4096} onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              if (path && !loading && !disabled) open(path);
            }
          }} />
      </label>
      <Button variant="outlined" disabled={disabled || loading || !path} onClick={() => open(path)}>前往</Button>
    </div>
    {loading && <p className={styles.helper} role="status">正在读取目录…</p>}
    {error && <p className={styles.inlineError} role="alert">{error}</p>}
    {listing && <>
      <ul className={styles.folderList} aria-label="子目录">
        {listing.folders.map(folder => <li key={folder.path}>
          <button type="button" title={folder.path} disabled={disabled || loading} onClick={() => open(folder.path)}>
            <FolderIcon /><span>{folder.name}</span><span aria-hidden="true">›</span>
          </button>
        </li>)}
      </ul>
      {!listing.folders.length && !loading && <p className={styles.helper}>此目录没有可显示的子文件夹。</p>}
      {listing.truncated && <p className={styles.helper}>只显示部分文件夹；也可以直接粘贴完整路径。</p>}
      <div className={styles.formActions}><Button type="button" disabled={disabled || loading || path !== listing.path} onClick={() => onPick(listing.path)}>{pickLabel}</Button></div>
    </>}
  </div>;
}

export function WorkspaceDrawer({ info, pending, onClose, onChange }: {
  info: Info;
  pending: boolean;
  onClose: () => void;
  onChange: (action: WorkspaceAction) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  async function change(action: WorkspaceAction) {
    setError('');
    try { await onChange(action); }
    catch (cause) { setError(errorText(cause)); }
  }
  return <Overlay side="right" title="工作区" onClose={onClose}>
    <Panel title="工作区" onClose={onClose}>
      <p className={styles.panelLead}>切换后，新会话会使用所选文件夹。已有会话及磁盘文件不会移动。</p>
      <ul className={styles.workspaceList} aria-label="已保存工作区">
        {info.workspaces.map(entry => {
          const selected = entry.path === info.defaults.cwd;
          return <li className={styles.workspaceRow} key={entry.path}>
            <button type="button" className={styles.workspaceChoice} aria-current={selected ? 'true' : undefined}
              disabled={pending} onClick={() => void change({ action: 'select', path: entry.path })}>
              <FolderIcon /><span><strong>{entry.name}</strong><small title={entry.path}>{entry.path}</small></span>
              {selected && <span className={styles.currentTag}>当前</span>}
            </button>
            {entry.path !== info.workspace && <IconButton label={`从列表移除 ${entry.name}`} icon={<IconTrashOutline16 />} size="xl" disabled={pending}
              onClick={() => void change({ action: 'remove', path: entry.path })} />}
          </li>;
        })}
      </ul>
      <div className={styles.workspaceAdd}>
        <Button variant="outlined" aria-expanded={adding} disabled={pending} onClick={() => setAdding(open => !open)}>{adding ? '收起目录浏览' : '添加文件夹'}</Button>
        {adding && <>
          <label className={styles.field}><span>显示名称（可选）</span><input value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder="默认使用文件夹名" /></label>
          <DirectoryBrowser initialPath={info.defaults.cwd} pickLabel="保存并切换" disabled={pending}
            onPick={path => void change({ action: 'save', path, name: name.trim() || undefined, activate: true })} />
        </>}
      </div>
      {error && <p className={styles.inlineError} role="alert">{error}</p>}
    </Panel>
  </Overlay>;
}
