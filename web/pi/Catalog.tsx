import { useState } from 'react';
import { IconButton } from '../upstream/IconButton';
import { IconCloseOutline16, IconPanelLeftOutline16, IconRefreshOutline16, IconSearchOutline16 } from '../upstream/icons';
import type { PiCatalog, PiSessionSummary } from './model';
import styles from './Pi.module.css';

export function FolderMark() {
  return <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
    <path d="M3 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.6 1.7h5.8A1.5 1.5 0 0 1 17 7.7v6.8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
  </svg>;
}

const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
export function sessionDate(timestamp: number) {
  return Number.isFinite(timestamp) && timestamp > 0 ? date.format(timestamp) : '';
}

interface Props {
  catalog: PiCatalog | null;
  error: string;
  loading: boolean;
  liveId?: string;
  currentCwd?: string;
  liveTitle?: string;
  selectedId?: string;
  mobile?: boolean;
  onSelect: (session: PiSessionSummary) => void;
  onLive: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function Catalog({ catalog, error, loading, liveId, currentCwd, liveTitle, selectedId, mobile, onSelect, onLive, onRefresh, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const normalized = query.trim().toLocaleLowerCase();
  const workspaces = (catalog?.workspaces ?? []).flatMap((workspace) => {
    if (!normalized || `${workspace.name} ${workspace.cwd}`.toLocaleLowerCase().includes(normalized)) return [workspace];
    const sessions = workspace.sessions.filter(({ title }) => title.toLocaleLowerCase().includes(normalized));
    return sessions.length ? [{ ...workspace, sessions }] : [];
  });

  return <aside className={styles.sidebar} aria-label="Pi 工作区与会话">
    <div className={styles.brandRow}>
      <div className={styles.brand}><span className={styles.brandSymbol} aria-hidden="true">π</span><strong>Deeppi</strong></div>
      <IconButton label={mobile ? '关闭工作区侧栏' : '收起工作区侧栏'} size="xl" icon={mobile ? <IconCloseOutline16 /> : <IconPanelLeftOutline16 />}
        onClick={onClose} data-initial-focus={mobile ? '' : undefined} />
    </div>
    <button type="button" className={styles.liveShortcut} onClick={onLive} disabled={!liveId} aria-current={liveId && liveId === selectedId ? 'page' : undefined}>
      <span className={styles.liveDot} aria-hidden="true" />
      <span><strong>当前 Pi 对话</strong><small>{liveTitle || '等待连接'}</small></span>
    </button>
    <div className={styles.catalogHeading}>
      <h2>工作区</h2>
      <IconButton label="刷新 Pi 工作区" size="xl" icon={<IconRefreshOutline16 />} onClick={onRefresh} disabled={loading} />
    </div>
    <label className={styles.catalogSearch}>
      <span aria-hidden="true" className="icon"><IconSearchOutline16 /></span><span className="srOnly">查找工作区或会话</span>
      <input type="search" placeholder="查找工作区或会话" value={query} onChange={(event) => setQuery(event.target.value)} />
    </label>
    <nav aria-label="工作区会话" className={styles.catalogTree} tabIndex={0}>
      {error && <p className={styles.error} role="status">{error}</p>}
      {!workspaces.length && !error && <p className={styles.note}>{loading ? '正在读取 Pi 工作区…' : normalized ? '没有匹配的工作区或会话。' : '还没有工作区记录。'}</p>}
      {workspaces.map((workspace) => {
        const open = Boolean(normalized) || (expanded[workspace.cwd] ?? workspace.cwd === currentCwd);
        return <section key={workspace.cwd} className={styles.workspace}>
          <button type="button" className={styles.workspaceToggle} onClick={() => setExpanded((previous) => ({ ...previous, [workspace.cwd]: !open }))}
            aria-expanded={open} aria-disabled={normalized ? true : undefined} disabled={Boolean(normalized)} title={workspace.cwd}>
            <FolderMark /><span><strong>{workspace.name}</strong><small>{workspace.cwd}</small></span>
            <span className={styles.workspaceCount} aria-label={`${workspace.sessions.length} 个会话`}>{workspace.sessions.length}</span>
            <span aria-hidden="true" className={styles.chevron} />
          </button>
          {open && <ul className={styles.sessionList} aria-label={`${workspace.name} 会话`}>
            {!workspace.sessions.length && <li className={styles.note}>暂无会话</li>}
            {workspace.sessions.map((session) => <li key={session.id}>
              <button type="button" className={styles.sessionPick} aria-current={session.id === selectedId ? 'page' : undefined}
                title={session.title} onClick={() => onSelect(session)}>
                <strong>{session.title}</strong>
                <small>{session.id === liveId ? '当前对话' : [sessionDate(session.updatedAt), `${session.messageCount} 条`].filter(Boolean).join(' · ')}</small>
              </button>
            </li>)}
          </ul>}
        </section>;
      })}
    </nav>
    <p className={styles.sidebarFoot}>在终端中新建会话或工作区，运行 <code>/deeppi</code> 后打开链接。</p>
  </aside>;
}
