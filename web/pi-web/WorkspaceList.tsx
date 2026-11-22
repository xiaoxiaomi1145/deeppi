import { IconButton } from '../upstream/IconButton';
import { IconCloseOutline16, IconPanelLeftOutline16, IconRefreshOutline16, IconTrashOutline16 } from '../upstream/icons';
import { FolderMark, sessionDate } from '../pi/Catalog';
import styles from '../pi/Pi.module.css';
import { isCurrent, type BrowserSession, type BrowserState, type BrowserWorkspace } from './model';

export function WorkspaceList({ workspaces, selected, sessions, active, target, loading, error, ready, canStart, mobile,
  onBrowse, onRemove, onAdd, onNew, onPreview, onLive, onRefresh, onClose }: {
  workspaces: BrowserWorkspace[]; selected: string; sessions: BrowserSession[];
  active: BrowserState | null; target: BrowserSession | null; loading: boolean; error: string;
  ready: boolean; canStart: boolean; mobile: boolean;
  onBrowse: (cwd: string) => void; onRemove: (cwd: string) => void; onAdd: () => void;
  onNew: () => void; onPreview: (row: BrowserSession) => void; onLive: () => void; onRefresh: () => void; onClose: () => void;
}) {
  const browsing = workspaces.find(item => item.cwd === selected);
  return <aside className={styles.sidebar} aria-label="工作区与会话">
    <div className={styles.brandRow}>
      <div className={styles.brand}><span className={styles.brandSymbol} aria-hidden="true">π</span><strong>Deeppi</strong></div>
      <IconButton label={mobile ? '关闭工作区侧栏' : '收起工作区侧栏'} size="xl" icon={mobile ? <IconCloseOutline16 /> : <IconPanelLeftOutline16 />}
        onClick={onClose} data-initial-focus={mobile ? '' : undefined} />
    </div>
    {active?.id && <button type="button" className={styles.liveShortcut} onClick={onLive} aria-current={!target ? 'page' : undefined}>
      <span className={styles.liveDot} aria-hidden="true" /><span><strong>当前会话</strong><small>{active.title}</small></span>
    </button>}
    <div className={`${styles.catalogHeading} ${styles.webShelf}`}>
      <h2>工作区</h2>
      <div className={styles.inlineActions}><button type="button" className={styles.secondary} onClick={onAdd} disabled={!ready}>添加</button>
        <IconButton label="刷新工作区与会话" icon={<IconRefreshOutline16 />} size="xl" onClick={onRefresh} disabled={!ready || loading} />
      </div>
    </div>
    <div className={styles.catalogTree}>
      <nav aria-label="工作区">
        {workspaces.map(workspace => <div className={styles.webWorkspace} key={workspace.cwd}>
          <button type="button" className={styles.workspaceToggle} aria-current={workspace.cwd === selected ? 'true' : undefined}
            title={workspace.cwd} onClick={() => onBrowse(workspace.cwd)}>
            <FolderMark /><span><strong>{workspace.name}</strong><small>{workspace.cwd}</small></span>
          </button>
          {workspace.cwd === selected && workspace.saved && !workspace.launch && <IconButton size="m" label={`移除工作区 ${workspace.name}（不删除文件和会话）`}
            icon={<IconTrashOutline16 />} onClick={() => onRemove(workspace.cwd)} disabled={!ready} />}
        </div>)}
      </nav>
      <div className={`${styles.catalogHeading} ${styles.webShelf}`}>
        <h2>会话{browsing ? ` · ${browsing.name}` : ''}</h2>
        <button type="button" className={styles.primary} disabled={!canStart || !selected} onClick={onNew}>新建会话</button>
      </div>
      <nav aria-label="所选工作区的会话">
        {error && <p className={styles.error} role="status">{error}</p>}
        {!sessions.length && !error && <p className={styles.note}>{loading ? '正在读取 Pi 会话…' : '这个工作区还没有会话。'}</p>}
        <ul className={`${styles.sessionList} ${styles.webSessions}`}>
          {sessions.map(row => <li key={row.id}>
            <button type="button" className={styles.sessionPick} onClick={() => onPreview(row)} title={row.title}
              aria-current={isCurrent(row, target ?? active) ? 'page' : undefined}>
              <strong>{row.title}</strong><small>{isCurrent(row, active) ? '当前会话' : [sessionDate(row.updatedAt), `${row.messageCount} 条`].filter(Boolean).join(' · ')}</small>
            </button>
          </li>)}
        </ul>
      </nav>
    </div>
    <p className={styles.sidebarFoot}>在本机以 Pi 运行。切换工作区浏览不会打断当前会话。</p>
  </aside>;
}
