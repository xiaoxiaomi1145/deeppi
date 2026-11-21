import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { errorText } from './api';
import { Composer } from './Chat';
import { Transcript } from './Transcript';
import { ContextDrawer } from './ContextDrawer';
import { Overlay, Panel } from './Overlay';
import { providerLabels, SettingsDrawer } from './SettingsDrawer';
import { Sidebar } from './Sidebar';
import { pathName, WorkspaceDrawer } from './WorkspaceDrawer';
import type { SessionStatus, SessionSummary } from './types';
import { useDeeppi } from './useDeeppi';
import { useTheme } from './theme';
import { Button } from './upstream/Button';
import { IconButton } from './upstream/IconButton';
import { IconDataOutline16, IconMenuOutline20, IconPanelLeftOutline16, NewChatIcon } from './upstream/icons';
import './upstream/theme.css';
import './upstream/global.css';
import './upstream/markdown.css';
import frame from './upstream/App.module.css';
import view from './upstream/SessionView.module.css';
import welcome from './upstream/Welcome.module.css';
import styles from './Client.module.css';

const statusLabels: Record<SessionStatus, string> = { idle: '空闲', running: '生成中', compacting: '压缩中', stopping: '正在停止' };
const mobileQuery = '(max-width: 767px)';
type Modal = { kind: 'sidebar' | 'globalSettings' | 'sessionSettings' | 'workspace' | 'context' } | { kind: 'rename' | 'delete'; target: SessionSummary };

function useMobileViewport() {
  const [mobile, setMobile] = useState(() => matchMedia(mobileQuery).matches);
  useEffect(() => {
    const media = matchMedia(mobileQuery);
    const viewport = window.visualViewport;
    const root = document.documentElement;
    function update() {
      setMobile(media.matches);
      if (!media.matches || !viewport || viewport.scale !== 1) {
        root.style.removeProperty('--app-viewport-height');
        root.style.removeProperty('--app-viewport-top');
        return;
      }
      root.style.setProperty('--app-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--app-viewport-top', `${viewport.offsetTop}px`);
    }
    media.addEventListener('change', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    update();
    return () => {
      media.removeEventListener('change', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, []);
  return mobile;
}

function SessionAction({ mode, target, onClose, onSubmit, pending }: {
  mode: 'rename' | 'delete';
  target: SessionSummary;
  onClose: () => void;
  onSubmit: (title: string) => Promise<void>;
  pending: boolean;
}) {
  const [title, setTitle] = useState(target.title);
  const [error, setError] = useState('');
  const rename = mode === 'rename';
  const heading = rename ? '重命名会话' : '删除会话';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (rename && !title.trim())) return;
    setError('');
    try { await onSubmit(title.trim()); onClose(); } catch (cause) { setError(errorText(cause)); }
  }
  return (
    <Overlay title={heading} onClose={onClose}>
      <Panel title={heading} onClose={onClose} onSubmit={submit} footer={<div className={styles.formActions}>
        <Button variant="outlined" onClick={onClose} data-initial-focus={rename ? undefined : ''}>取消</Button>
        <Button variant={rename ? 'primary' : 'danger'} type="submit" disabled={pending || (rename && !title.trim())}>
          {rename ? '保存名称' : '确认删除'}
        </Button>
      </div>}>
        {rename ? <label className={styles.field}><span>会话名称</span>
          <input data-initial-focus="" value={title} required maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label> : <p className={styles.confirmCopy}>删除「{target.title}」？此操作无法撤销。</p>}
        {error && <p role="alert" className={styles.inlineError}>{error}</p>}
      </Panel>
    </Overlay>
  );
}

function App() {
  const app = useDeeppi();
  const { info, session, activeId, sessions, bootError, sessionError, pending, stopping, select, newChat } = app;
  const [theme, setTheme] = useTheme();
  const mobile = useMobileViewport();
  const [collapsed, setCollapsed] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState('');

  const workspace = info?.workspaces.find(entry => entry.path === info.defaults.cwd);
  const key = activeId ?? `draft:${info?.defaults.cwd ?? ''}`;
  const draft = drafts[key] ?? '';
  const selected = sessions.find(({ id }) => id === activeId);
  const status = session?.status ?? selected?.status ?? 'idle';
  const busy = status !== 'idle' || pending === 'prompt' || pending === 'continue';
  const canStop = Boolean(session && status !== 'idle' && status !== 'stopping' && !stopping);
  const ready = Boolean(info && !bootError && (activeId === null || session));
  const empty = !session?.messages.length;
  const currentSettings = session?.settings ?? (!activeId ? app.draftSettings : undefined);
  const needsConnection = session ? session.connection === 'missing' : !activeId && app.draftNeedsConnection;
  const cwd = currentSettings?.cwd ?? selected?.cwd;
  const cwdLabel = cwd && (info?.workspaces.find(entry => entry.path === cwd)?.name ?? pathName(cwd));
  const title = session?.title ?? selected?.title ?? '新会话';
  const statusLabel = status === 'idle' ? (pending === 'continue' ? '继续中' : '发送中') : statusLabels[status];

  const close = useCallback(() => setModal(current => current === modal ? null : current), [modal]);
  const choose = useCallback((id: string) => {
    select(id);
    setActionError('');
    setModal(null);
  }, [select]);
  const create = useCallback(() => {
    newChat();
    setActionError('');
    setModal(null);
  }, [newChat]);
  const openGlobal = useCallback(() => setModal({ kind: 'globalSettings' }), []);
  const openSession = useCallback(() => setModal({ kind: 'sessionSettings' }), []);
  const openWorkspace = useCallback(() => setModal({ kind: 'workspace' }), []);
  const collapseSidebar = useCallback(() => setCollapsed(true), []);
  const rename = useCallback((target: SessionSummary) => setModal({ kind: 'rename', target }), []);
  const remove = useCallback((target: SessionSummary) => setModal({ kind: 'delete', target }), []);
  function setDraft(text: string) { setDrafts(previous => ({ ...previous, [key]: text })); }
  async function send() {
    const text = draft.trim();
    if (!text || !ready || busy || pending || needsConnection) return;
    setActionError('');
    let target = key;
    try {
      await app.send(text, id => {
        target = id;
        if (activeId) return;
        setDrafts(previous => {
          const next = { ...previous, [id]: previous[key] ?? draft };
          delete next[key];
          return next;
        });
      });
      setDrafts(previous => {
        if (previous[target] !== draft) return previous;
        const next = { ...previous };
        delete next[target];
        return next;
      });
    } catch (cause) { setActionError(errorText(cause)); }
  }
  async function resume() {
    if (!session?.canContinue || busy || pending || needsConnection) return;
    setActionError('');
    try { await app.continue(session.id); } catch (cause) { setActionError(errorText(cause)); }
  }
  async function stop() {
    setActionError('');
    try { await app.stop(); } catch (cause) { setActionError(errorText(cause)); }
  }

  const sidebar = (insideMobile: boolean) => (
    <Sidebar sessions={sessions} activeId={activeId} workspace={workspace} mobile={insideMobile} pending={!info || Boolean(pending)}
      onSelect={choose} onCreate={create} onSettings={openGlobal} onWorkspace={openWorkspace}
      onCollapse={insideMobile ? close : collapseSidebar} onRename={rename} onDelete={remove} />
  );
  const composer = (
    <Composer text={draft} onText={setDraft} onSend={() => void send()} onStop={() => void stop()} onSettings={openSession}
      allowSend={ready && !pending && status === 'idle' && !needsConnection} canStop={canStop} busy={busy}
      stopping={stopping || status === 'stopping'} empty={empty} />
  );

  return (
    <div className={frame.frame} onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !modal && canStop) {
        event.preventDefault();
        void stop();
      }
    }}>
      {!mobile && !collapsed && sidebar(false)}
      <main className={frame.main}>
        <header className={clsx(view.header, styles.header)}>
          <div className={styles.headerStart}>
            {(mobile || collapsed) && <IconButton size="xl" label="打开会话侧栏"
              icon={mobile ? <IconMenuOutline20 /> : <IconPanelLeftOutline16 />}
              onClick={() => mobile ? setModal({ kind: 'sidebar' }) : setCollapsed(false)} />}
            {collapsed && !mobile && <IconButton size="xl" label="开启新会话" icon={<NewChatIcon />} disabled={!info || Boolean(pending)} onClick={create} />}
            <div className={styles.headerIdentity}>
              <span className={clsx(view.title, styles.headerTitle)} title={title}>{title}</span>
              {cwdLabel && <small title={cwd}>{cwdLabel}</small>}
            </div>
          </div>
          <div className={styles.headerEnd}>
            {currentSettings && <button type="button" className={styles.model} title={`${providerLabels[currentSettings.provider]} · ${currentSettings.model}`}
              onClick={openSession} aria-label={`会话模型：${currentSettings.model}，更改设置`}>
              {currentSettings.provider === 'demo' ? '离线演示' : currentSettings.model}
            </button>}
            {busy && <span className={styles.runStatus} role="status">
              <span className={styles.statusDot} />{statusLabel}
            </span>}
            {session && <IconButton size="xl" label="查看上下文" icon={<IconDataOutline16 />} onClick={() => setModal({ kind: 'context' })} />}
            {!session && needsConnection && <Button size="s" variant="outlined" onClick={openGlobal}>配置连接</Button>}
          </div>
        </header>
        <div className={frame.content}>
          <div className={view.view}>
            {(actionError || session?.error) && <div className={styles.banner} role="alert">
              <span>{actionError || session?.error}</span>
              {actionError && <button type="button" onClick={() => setActionError('')}>关闭</button>}
            </div>}
            {activeId && app.connection === 'reconnecting' && (session || !sessionError) && <div className={styles.reconnect} role="status">
              消息连接中断，正在重新连接… <button type="button" onClick={app.reconnect}>立即重连</button>
            </div>}
            <div className={styles.chatArea}>
              {bootError || (sessionError && !session) ? <div className={frame.loadingState}>
                <p role="alert">{bootError || sessionError}</p>
                <Button variant="outlined" onClick={bootError ? app.retryBoot : app.reconnect}>重试</Button>
              </div> : !ready ? <div className={frame.loadingState} role="status">正在载入会话…</div> : empty ? (
                <div className={welcome.container}>
                  <div className={clsx(welcome.welcome, styles.welcome)}>
                    <h1 className={clsx(welcome.greeting, styles.greeting)}>你好，有什么可以帮你？</h1>
                    {composer}
                    <p className={styles.keyHint}>Enter 发送 · Shift + Enter 换行</p>
                  </div>
                </div>
              ) : (
                <>
                  <Transcript key={session?.id} messages={session?.messages ?? []} />
                  <div className={clsx(view.inputContainer, styles.chatInput)}>
                    {composer}
                    <div className={styles.keyHint}>{busy ? 'Esc 停止' : 'Enter 发送 · Shift + Enter 换行'}</div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </main>
      {modal?.kind === 'sidebar' && mobile && <Overlay title="会话侧栏" onClose={close} side="left">{sidebar(true)}</Overlay>}
      {modal?.kind === 'workspace' && info && <WorkspaceDrawer info={info} pending={Boolean(pending)} onClose={close}
        onChange={async (body) => { await app.workspace(body); }} />}
      {modal?.kind === 'globalSettings' && info && <SettingsDrawer info={info} settings={info.defaults} scope="global"
        connection={info.connection} hasKeyOverride={info.hasDefaultKey} theme={theme} onTheme={setTheme} onClose={close}
        onSave={(body) => app.saveDefaults(body)} onProbe={(body, signal) => app.probe(body, 'global', signal)}
        editable={!busy && !pending} />}
      {modal?.kind === 'sessionSettings' && info && (session || app.draftSettings) && <SettingsDrawer info={info}
        settings={session?.settings ?? app.draftSettings!} scope={session ? 'session' : 'draft'}
        connection={session?.connection ?? (app.draftNeedsConnection ? 'missing' : info.connection)}
        hasKeyOverride={session?.hasSessionKey ?? app.draftHasKey} theme={theme} onTheme={setTheme} onClose={close}
        onSave={(body) => app.saveSettings(body)}
        onProbe={(body, signal) => app.probe(body, session ? 'session' : 'draft', signal)}
        editable={!busy && !pending} />}
      {modal?.kind === 'context' && session && <ContextDrawer session={session} blocked={Boolean(pending)} onClose={close}
        onCompact={(focus) => app.compact(session.id, focus)} onRemove={(name) => app.removeTool(session.id, name)} />}
      {(modal?.kind === 'rename' || modal?.kind === 'delete') && <SessionAction mode={modal.kind} target={modal.target}
        onClose={close} pending={Boolean(pending)} onSubmit={(text) => modal.kind === 'rename' ? app.rename(modal.target.id, text) : app.remove(modal.target.id)} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
