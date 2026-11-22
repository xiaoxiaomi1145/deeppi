import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { errorText } from '../api';
import { Overlay, Panel } from '../Overlay';
import { Transcript } from '../Transcript';
import { useTheme } from '../theme';
import { IconButton } from '../upstream/IconButton';
import { IconCloseOutline16, IconDataOutline16, IconMenuOutline20, IconPanelLeftOutline16, IconSettingsOutline16 } from '../upstream/icons';
import { PiWebApp } from '../pi-web/App';
import { Catalog, FolderMark, sessionDate } from './Catalog';
import { ContextPanel } from './ContextPanel';
import { isSlashInput } from './input-model';
import { Empty, useMobileViewport } from './layout';
import { PiComposer } from './PiComposer';
import { PiSettings, type SettingsSection } from './PiSettings';
import { promptPayload, statusLabels, visibleHistory, workspaceLabel, type Delivery, type PiCatalog, type PiCommand, type PiHistory, type PiSessionSummary } from './model';
import { piApi } from './transport';
import { usePiSession, type LinkStatus } from './usePiSession';
import '../upstream/theme.css';
import '../upstream/global.css';
import '../upstream/markdown.css';
import styles from './Pi.module.css';

const localLinkLabels: Record<LinkStatus, string> = { connecting: '连接中', open: 'Pi 已连接', retrying: '重连中', closed: '已断开', needsLink: '等待连接' };
function CommandsPanel({ commands, onClose }: { commands: readonly PiCommand[]; onClose: () => void }) {
  return <Overlay title="Pi 指令" side="right" onClose={onClose}><Panel title="Pi 指令" onClose={onClose}>
    <p className={styles.note}>在输入框键入 <code>/</code> 可补全。仅终端的指令不会作为聊天消息发送。</p>
    <ul className={styles.helpCommands}>{commands.map(command => <li key={command.name}>
      <div><code>/{command.name}</code>{command.argumentHint && <small>{command.argumentHint}</small>}{command.kind === 'terminal' && <small>仅终端</small>}</div>
      <span>{command.description}</span>
    </li>)}</ul>
  </Panel></Overlay>;
}

type Modal = { kind: 'sidebar' | 'context' | 'help' } | { kind: 'settings'; section: SettingsSection };
type Pending = 'prompt' | 'stop' | null;

function App() {
  const [theme, setTheme] = useTheme();
  const mobile = useMobileViewport();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modal, setModal] = useState<Modal | null>(null);
  const [switching, setSwitching] = useState('');
  const { state, link, linkError, reconnect } = usePiSession();
  const [catalog, setCatalog] = useState<PiCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [target, setTarget] = useState<PiSessionSummary | null>(null);
  const [preview, setPreview] = useState<PiHistory | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const [feedback, setFeedback] = useState('');
  const [dismissedPiError, setDismissedPiError] = useState('');
  const [draft, setDraft] = useState({ sessionId: '', text: '' });
  const [pending, setPending] = useState<Pending>(null);
  const busyAction = useRef(false);
  const selectedId = target?.id ?? state?.id;
  const shownPreview = visibleHistory(preview?.id === selectedId ? preview : null, state?.id);
  const readOnly = !!target && target.id !== state?.id;
  const liveId = state?.id;
  const liveReady = state?.connected === true && link === 'open' && !switching;
  const writable = liveReady && state?.status === 'idle';
  const currentDraft = draft.sessionId === liveId ? draft : { sessionId: liveId ?? '', text: '' };
  const canSend = liveReady && !readOnly && !pending && (!!state.model || isSlashInput(currentDraft.text)) && (state.status === 'idle' || state.status === 'running');
  const canStop = liveReady && !readOnly && !pending && !!state && (state.status === 'running' || state.status === 'compacting');
  const catalogId = state?.id;
  const catalogTitle = state?.title;

  useEffect(() => {
    if (!catalogId || link !== 'open') return;
    const abort = new AbortController();
    setCatalogLoading(true);
    setCatalogError('');
    void piApi.catalog(abort.signal).then((data) => {
      if (!abort.signal.aborted) { setCatalog(data); setCatalogLoading(false); }
    }, (cause) => {
      if (!abort.signal.aborted) { setCatalogError(errorText(cause)); setCatalogLoading(false); }
    });
    return () => abort.abort();
  }, [catalogId, catalogTitle, link, catalogRefresh]);

  useEffect(() => {
    if (!target || !readOnly || link !== 'open') return;
    const abort = new AbortController();
    setPreviewError('');
    void piApi.history(target.id, abort.signal).then((data) => {
      if (!abort.signal.aborted) setPreview(data);
    }, (cause) => {
      if (!abort.signal.aborted) setPreviewError(errorText(cause));
    });
    return () => abort.abort();
  }, [target, readOnly, link, previewRefresh]);

  useEffect(() => {
    if (!switching) return;
    if (state?.id === switching && link === 'open') {
      setSwitching('');
      setTarget(null);
      setPreview(null);
      setModal(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setSwitching('');
      setNotice('尚未看到新会话。请确认 Pi 终端中的当前会话，可运行 /deeppi 重新打开网页。');
    }, 12000);
    return () => clearTimeout(timer);
  }, [switching, state?.id, link]);

  useEffect(() => {
    if (target?.id && target.id === state?.id) {
      setTarget(null);
      setPreview(null);
    }
  }, [target?.id, state?.id]);
  useEffect(() => {
    if (!mobile && modal?.kind === 'sidebar') setModal(null);
  }, [mobile, modal?.kind]);
  useEffect(() => { if (!state?.error) setDismissedPiError(''); }, [state?.error]);
  useEffect(() => { document.title = `${shownPreview?.title || (readOnly ? target?.title : state?.title) || 'Pi 会话'} · Deeppi`; }, [shownPreview?.title, readOnly, target?.title, state?.title]);

  function backToLive() {
    setTarget(null);
    setPreview(null);
    setPreviewError('');
    setNotice('');
    if (modal?.kind === 'sidebar') setModal(null);
  }
  function selectSession(session: PiSessionSummary) {
    if (switching) return;
    if (session.id === liveId) { backToLive(); return; }
    if (session.id !== target?.id) {
      setTarget(session);
      setPreview(null);
      setPreviewError('');
    }
    setNotice('');
    if (modal?.kind === 'sidebar') setModal(null);
  }
  async function enterSession() {
    if (!target || !shownPreview || !writable || busyAction.current) return;
    busyAction.current = true;
    setSwitching(target.id);
    setNotice('');
    try { await piApi.switch(target.id); }
    catch (cause) { setSwitching(''); setNotice(errorText(cause)); }
    finally { busyAction.current = false; }
  }
  async function send(delivery: Delivery) {
    if (!canSend || !state || busyAction.current) return;
    const payload = promptPayload(currentDraft.text, state.status, delivery, '');
    if (!payload) return;
    busyAction.current = true;
    setPending('prompt');
    setNotice('');
    setFeedback('');
    try {
      const result = await piApi.prompt(payload);
      setDraft(value => value.sessionId === currentDraft.sessionId && value.text === currentDraft.text ? { ...value, text: '' } : value);
      const panel = result.panel;
      if (panel === 'context' || panel === 'help') setModal({ kind: panel });
      else if (panel === 'sessions') {
        if (mobile) setModal({ kind: 'sidebar' });
        else setSidebarOpen(true);
      } else if (panel) setModal({ kind: 'settings', section: panel });
      if (result.notice) setFeedback(result.notice);
      if (result.copy !== undefined) {
        try { await navigator.clipboard.writeText(result.copy); setFeedback('已复制最后一条回复。'); }
        catch { setNotice('浏览器没有允许访问剪贴板，请手动复制正文。'); }
      }
    } catch (cause) { setNotice(errorText(cause)); }
    finally { busyAction.current = false; setPending(null); }
  }
  async function stop() {
    if (!canStop || busyAction.current) return;
    busyAction.current = true;
    setPending('stop');
    setNotice('');
    try { await piApi.stop(); }
    catch (cause) { setNotice(errorText(cause)); }
    finally { busyAction.current = false; setPending(null); }
  }

  const title = shownPreview?.title || (readOnly ? target?.title : state?.title) || 'Pi 会话';
  const cwd = shownPreview?.cwd || (readOnly ? '' : state?.cwd) || '';
  const displayStatus = readOnly ? '只读历史' : liveReady && state ? statusLabels[state.status] : link === 'open' ? 'Pi 未就绪' : localLinkLabels[link];
  const openSettings = (section: SettingsSection) => setModal({ kind: 'settings', section });
  const closeModal = () => setModal(null);
  const showCatalog = (inDialog: boolean) => <Catalog catalog={catalog} loading={catalogLoading} error={catalogError} currentCwd={state?.cwd}
    liveId={liveId} liveTitle={state?.title} selectedId={selectedId} onSelect={selectSession} onLive={backToLive} mobile={inDialog}
    onClose={inDialog ? closeModal : () => setSidebarOpen(false)} onRefresh={() => setCatalogRefresh((value) => value + 1)} />;
  const piError = state?.error && state.error !== dismissedPiError && !readOnly ? state.error : '';
  const banner = notice || piError;
  return <div className={styles.app}>
    <a className={styles.skip} href="#pi-conversation">跳到对话</a>
    {!mobile && sidebarOpen && showCatalog(false)}
    <main className={styles.main} id="pi-conversation" tabIndex={-1}>
      <header className={styles.header}>
        {(mobile || !sidebarOpen) && <IconButton size="xl" icon={mobile ? <IconMenuOutline20 /> : <IconPanelLeftOutline16 />} label="显示工作区侧栏"
          onClick={() => mobile ? setModal({ kind: 'sidebar' }) : setSidebarOpen(true)} />}
        <div className={styles.identity}>
          <h1 title={title}>{title}</h1>
          {cwd && <span title={cwd} className={styles.path}><FolderMark />{workspaceLabel(cwd)}</span>}
        </div>
        <div className={styles.headerTools}>
          <span className={styles.status} data-active={!readOnly && state?.status !== 'idle' && liveReady ? '' : undefined} role="status"><span aria-hidden="true" />{displayStatus}</span>
          {!readOnly && state && <>
            <button type="button" className={styles.modelButton} title={state.model?.id || '选择模型'} onClick={() => openSettings('model')}>{state.model?.name || '选择模型'}</button>
            <IconButton size="xl" label="查看上下文" icon={<IconDataOutline16 />} onClick={() => setModal({ kind: 'context' })} />
            <IconButton size="xl" label="Pi 会话设置" icon={<IconSettingsOutline16 />} onClick={() => openSettings('model')} />
          </>}
        </div>
      </header>

      {readOnly && <div className={styles.previewBar}>
        <div><strong>历史预览</strong><small>{shownPreview ? sessionDate(shownPreview.updatedAt) : '不会切换 Pi 或发送消息'}</small></div>
        <div className={styles.inlineActions}>
          <button type="button" className={styles.secondary} onClick={backToLive} disabled={!!switching}>返回当前</button>
          <button type="button" className={styles.primary} disabled={!writable || !!switching || !shownPreview || !!pending} onClick={() => void enterSession()}>{switching ? '正在打开…' : '在 Pi 中打开'}</button>
        </div>
      </div>}
      {readOnly && shownPreview && liveReady && !writable && <p className={styles.sessionHint}>等待当前 Pi 操作结束后再切换会话。</p>}
      {banner && <div className={`${styles.banner} ${styles.error}`} role="alert"><span>{banner}</span><IconButton icon={<IconCloseOutline16 />} label="关闭提示" size="m" onClick={() => { setNotice(''); if (piError) setDismissedPiError(piError); }} /></div>}
      {!banner && feedback && <div className={`${styles.banner} ${styles.notice}`} role="status"><span>{feedback}</span><IconButton icon={<IconCloseOutline16 />} label="关闭提示" size="m" onClick={() => setFeedback('')} /></div>}
      {state && (link === 'closed' || link === 'retrying' || link === 'needsLink') && <div className={`${styles.banner} ${styles.notice}`} role="status">
        <span>{link === 'closed' ? 'Pi 已关闭网页连接。可以先查看已有内容，或在终端重新运行 /deeppi。' : link === 'needsLink' ? '启动链接已失效，请在 Pi 终端运行 /deeppi，再打开新的完整链接。' : '实时连接中断，正在重连。'}{linkError && link === 'retrying' && ` ${linkError}`}</span>
        {link !== 'needsLink' && <button type="button" className={styles.secondary} onClick={reconnect}>重连</button>}
      </div>}

      <div className={styles.chat}>
        {readOnly
          ? shownPreview ? shownPreview.messages.length ? <Transcript key={`history-${shownPreview.id}`} messages={shownPreview.messages} /> : <Empty title="此会话没有消息"><p>这是只读预览。</p></Empty>
            : <Empty title={previewError ? '无法读取历史' : link === 'open' ? '正在读取历史…' : '等待 Pi 连接…'}>
              {previewError && <><p role="alert">{previewError}</p><button type="button" className={styles.secondary} onClick={() => setPreviewRefresh((value) => value + 1)}>重试</button></>}
            </Empty>
          : state ? state.messages.length ? <Transcript key={`live-${state.id}`} messages={state.messages} />
            : <Empty title="开始 Pi 对话"><p>消息和工具由终端中的 Pi 处理，聊天记录与当前会话同步。</p>
              {!state.model && <button type="button" className={styles.secondary} onClick={() => openSettings('model')}>选择模型</button>}
            </Empty>
          : link === 'needsLink' ? <Empty title="连接你的 Pi"><p>在 Pi 终端运行 <code>/deeppi</code>，然后打开它打印的完整链接。此页不会保存模型密钥。</p></Empty>
            : <Empty title={link === 'retrying' ? '暂时无法连接 Pi' : '正在连接 Pi…'}>
              {linkError && <p role="status">{linkError}</p>}{link === 'retrying' && <button type="button" className={styles.secondary} onClick={reconnect}>重试</button>}
            </Empty>}
      </div>

      {!readOnly && state && <PiComposer key={state.id} text={currentDraft.text} setText={text => setDraft({ ...currentDraft, text })}
        skills={state.skills} commands={state.commands ?? []} status={state.status}
        canSend={canSend} canStop={canStop} pending={pending === 'prompt'} onSend={delivery => void send(delivery)} onStop={() => void stop()}
        disabledReason={!liveReady ? '网页重新连接后可以发送。' : state.status === 'stopping' || state.status === 'compacting' ? 'Pi 正在处理当前操作，完成后可发送。' : !state.model && !isSlashInput(currentDraft.text) ? '选择模型后可聊天，仍可使用 / 指令。' : undefined} />}
    </main>
    {mobile && modal?.kind === 'sidebar' && <Overlay title="Pi 工作区与会话" side="left" onClose={closeModal}>{showCatalog(true)}</Overlay>}
    {state && !readOnly && modal?.kind === 'settings' && <PiSettings key={`${state.id}:${modal.section}`} state={state} section={modal.section} writable={writable && !pending} connected={liveReady} theme={theme} setTheme={setTheme} onClose={closeModal} />}
    {state && !readOnly && modal?.kind === 'context' && <ContextPanel key={state.id} state={state} writable={writable && !pending} onClose={closeModal} />}
    {state && !readOnly && modal?.kind === 'help' && <CommandsPanel commands={state.commands ?? []} onClose={closeModal} />}
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Pi 网页缺少挂载节点。');
createRoot(root).render(root.hasAttribute('data-pi-web') ? <PiWebApp /> : <App />);
