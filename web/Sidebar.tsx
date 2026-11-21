import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, Workspace } from './types';
import { FolderIcon, pathName } from './WorkspaceDrawer';
import { IconButton } from './upstream/IconButton';
import { IconCloseOutline16, IconEditOutline16, IconEllipsisOutline16, IconPanelLeftOutline16, IconSettingsOutline16, IconTrashOutline16, NewChatIcon } from './upstream/icons';
import sider from './upstream/Sider.module.css';
import item from './upstream/SessionItem.module.css';
import styles from './Client.module.css';

interface SidebarProps {
  sessions: readonly SessionSummary[];
  activeId: string | null;
  workspace?: Workspace;
  mobile?: boolean;
  pending: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onWorkspace: () => void;
  onRename: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onSettings: () => void;
  onCollapse: () => void;
}

export function Sidebar({ sessions, activeId, workspace, mobile, pending, onSelect, onCreate, onWorkspace, onRename, onDelete, onSettings, onCollapse }: SidebarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuArea = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!openMenu) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !menuArea.current?.contains(event.target)) setOpenMenu(null);
    }
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [openMenu]);

  return (
    <aside className={clsx(sider.sider, styles.sidebar, mobile && sider.mobile)} aria-label="会话侧栏">
      <div className={sider.top}>
        <span className={clsx(sider.appName, styles.brand)}>Deeppi</span>
        <IconButton icon={mobile ? <IconCloseOutline16 /> : <IconPanelLeftOutline16 />}
          label={mobile ? '关闭侧栏' : '收起侧栏'} size={mobile ? 'xl' : 'm'} onClick={onCollapse} data-initial-focus={mobile ? '' : undefined} />
      </div>
      <button type="button" className={sider.newChat} onClick={onCreate} disabled={pending}>
        <span className={sider.newChatIcon} aria-hidden="true"><NewChatIcon /></span>开启新会话
      </button>
      <button type="button" className={styles.workspaceButton} onClick={onWorkspace} disabled={pending} title={workspace?.path ?? '管理工作区'}>
        <span className={styles.workspaceIcon} aria-hidden="true"><FolderIcon /></span>
        <span className={styles.workspaceText}><strong>{workspace?.name ?? '工作区'}</strong><small>{workspace?.path ?? '选择工作目录'}</small></span>
        <span aria-hidden="true" className={styles.workspaceChevron}>›</span>
      </button>
      <div className={sider.listWrap}>
        <nav className={sider.list} aria-label="会话记录">
          <div className={clsx(sider.sectionHeader, styles.historyLabel)}>会话记录</div>
          {sessions.length === 0 && <div className={styles.historyEmpty}>暂无会话</div>}
          <ul className={styles.sessionList}>
            {sessions.map((session) => {
              const active = session.id === activeId;
              const menuOpen = session.id === openMenu;
              return (
                <li key={session.id}>
                  <div className={clsx(item.item, styles.sessionItem, active && item.active)}>
                    <button type="button" className={clsx(item.title, styles.sessionSelect)} aria-current={active ? 'page' : undefined}
                      title={session.title} onClick={() => { setOpenMenu(null); onSelect(session.id); }}>
                      {session.title}
                    </button>
                    <div className={styles.sessionActions} ref={menuOpen ? menuArea : undefined}
                      onBlur={(event) => {
                        if (menuOpen && !event.currentTarget.contains(event.relatedTarget)) setOpenMenu(null);
                      }}
                      onKeyDown={(event) => {
                        if (menuOpen && event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setOpenMenu(null);
                          menuButton.current?.focus();
                        }
                      }}>
                      <IconButton icon={<IconEllipsisOutline16 />} label={`会话操作：${session.title}`} aria-expanded={menuOpen}
                        onClick={(event) => {
                          menuButton.current = event.currentTarget;
                          setOpenMenu(menuOpen ? null : session.id);
                        }} />
                      {menuOpen && (
                        <div className={styles.sessionMenu}>
                          <button type="button" disabled={pending || (active && session.status !== 'idle')} onClick={() => { setOpenMenu(null); onRename(session); }}>
                            <span aria-hidden="true" className="icon"><IconEditOutline16 /></span>重命名
                          </button>
                          <button type="button" disabled={pending || (active && session.status !== 'idle')}
                            onClick={() => { setOpenMenu(null); onDelete(session); }}>
                            <span aria-hidden="true" className="icon"><IconTrashOutline16 /></span>删除会话
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div className={sider.bottom}>
        <button type="button" className={sider.settings} onClick={onSettings}>
          <span className={sider.settingsIcon} aria-hidden="true"><IconSettingsOutline16 /></span>
          <span className={sider.settingsLabel}>设置</span>
        </button>
      </div>
    </aside>
  );
}
