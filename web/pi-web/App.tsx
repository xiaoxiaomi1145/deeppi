import { useEffect, useRef, useState } from 'react';
import { ApiError, errorText } from '../api';
import { Overlay } from '../Overlay';
import { Transcript } from '../Transcript';
import { useTheme } from '../theme';
import type { WorkspaceAction } from '../types';
import { IconButton } from '../upstream/IconButton';
import { IconCloseOutline16, IconDataOutline16, IconMenuOutline20, IconSettingsOutline16 } from '../upstream/icons';
import { FolderMark, sessionDate } from '../pi/Catalog';
import { Empty, useMobileViewport } from '../pi/layout';
import { statusLabels, workspaceLabel, type Delivery, type PiHistory } from '../pi/model';
import { PiComposer } from '../pi/PiComposer';
import { usePiStream } from '../pi/usePiSession';
import styles from '../pi/Pi.module.css';
import { isBrowserState, isCurrent, parseBrowserCommand, sessionKey, setDraftText, workspaceSelection, type BrowserSession, type BrowserWorkspace } from './model';
import { BrowserContextPanel, BrowserHelp, BrowserSettingsPanel, WorkspacePicker } from './Panels';
import { piWebApi } from './transport';
import { WorkspaceList } from './WorkspaceList';

type Modal = 'workspaces' | 'add' | 'settings' | 'context' | 'help' | null;
type Operation = 'workspace' | 'open' | 'prompt' | 'stop' | null;
const invalid = (message: string) => new ApiError(message, 400);

export function PiWebApp() {
  useTheme();
  const mobile = useMobileViewport();
  const { state, link, linkError, reconnect } = usePiStream(piWebApi.events, isBrowserState);
  const [modal, setModal] = useState<Modal>(null);
  const [sidebar, setSidebar] = useState(true);
  const [workspaces, setWorkspaces] = useState<BrowserWorkspace[]>([]);
  const [selected, setSelected] = useState('');
  const [listed, setListed] = useState({ cwd: '', sessions: [] as BrowserSession[] });
  const [target, setTarget] = useState<BrowserSession | null>(null);
  const [preview, setPreview] = useState<PiHistory | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [loading, setLoading] = useState(false);
  const [version, refresh] = useState(0);
  const [previewVersion, refreshPreview] = useState(0);
  const [drafts, setDrafts] = useState(() => new Map<string, string>());
  const [operation, setOperation] = useState<Operation>(null);
  const [notice, setNotice] = useState('');
  const [dismissed, setDismissed] = useState('');
  const doing = useRef(false);
  const useSavedDefault = useRef(false);
  const ready = link === 'open' && !!state;
  const active = state?.id ? state : null;
  const live = !!active && active.connected && ready && !active.switching;
  const canStart = ready && !operation && !state.switching && state.status === 'idle' && !state.pendingMessageCount;
  const readOnly = !!target && !isCurrent(target, active);
  const visiblePreview = readOnly && isCurrent(target, preview) ? preview : null;
  const activeKey = active ? sessionKey(active.cwd, active.id) : '';
  const draft = drafts.get(activeKey) ?? '';
  const command = parseBrowserCommand(draft);
  const canSend = live && !readOnly && !operation && (!!active.model || !!command) && ['idle', 'running'].includes(active.status);
  const canStop = live && !readOnly && !operation && ['running', 'compacting'].includes(active.status);
  const title = readOnly ? visiblePreview?.title ?? target.title : active?.title || 'Pi Web';
  const cwd = readOnly ? target.cwd : active?.cwd ?? selected;
  const settled = state?.status === 'idle' ? state.messages.length : -1;

  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    void piWebApi.workspaces(abort.signal).then(data => {
      if (abort.signal.aborted) return;
      const preferDefault = useSavedDefault.current;
      useSavedDefault.current = false;
      setWorkspaces(data.workspaces);
      setSelected(previous => workspaceSelection(data.workspaces, preferDefault ? '' : previous, data.selected));
    }, cause => { if (!abort.signal.aborted) setCatalogError(errorText(cause)); });
    return () => abort.abort();
  }, [ready, version, active?.cwd]);

  useEffect(() => {
    if (!ready || !selected) return;
    const abort = new AbortController();
    setLoading(true);
    setCatalogError('');
    void piWebApi.sessions(selected, abort.signal).then(data => {
      if (!abort.signal.aborted) { setListed({ cwd: selected, sessions: data.sessions }); setLoading(false); }
    }, cause => { if (!abort.signal.aborted) { setCatalogError(errorText(cause)); setLoading(false); } });
    return () => abort.abort();
  }, [ready, selected, version, activeKey, active?.title, settled]);

  useEffect(() => {
    if (!ready || !target || !readOnly) return;
    const abort = new AbortController();
    setPreviewError('');
    void piWebApi.history(target.cwd, target.id, abort.signal).then(data => {
      if (!abort.signal.aborted) setPreview(data);
    }, cause => { if (!abort.signal.aborted) setPreviewError(errorText(cause)); });
    return () => abort.abort();
  }, [ready, target, readOnly, previewVersion]);

  useEffect(() => { if (!state?.error) setDismissed(''); }, [state?.error]);
  useEffect(() => { document.title = `${title} · Deeppi`; }, [title]);
  useEffect(() => { if (!mobile && modal === 'workspaces') setModal(null); }, [mobile, modal]);

  function showWorkspace() { if (mobile) setModal('workspaces'); else setSidebar(true); }
  function backToLive() { setTarget(null); setPreview(null); setPreviewError(''); if (modal === 'workspaces') setModal(null); }
  function inspect(row: BrowserSession) {
    if (isCurrent(row, active)) { backToLive(); return; }
    setTarget(row);
    setPreview(null);
    setPreviewError('');
    setNotice('');
    if (modal === 'workspaces') setModal(null);
  }
  async function run(next: NonNullable<Operation>, action: () => Promise<unknown>) {
    if (!ready || doing.current) return;
    doing.current = true;
    setOperation(next);
    setNotice('');
    try { await action(); }
    catch (cause) { setNotice(errorText(cause)); }
    finally { doing.current = false; setOperation(null); }
  }
  async function changeWorkspace(action: WorkspaceAction) {
    await piWebApi.workspace(action);
    useSavedDefault.current = action.action === 'save';
    refresh(value => value + 1);
  }
  async function start(path: string, name?: string) {
    await piWebApi.create(path, name);
    setSelected(path);
    setTarget(null);
    setPreview(null);
    setModal(null);
  }
  function create() { if (canStart && selected) void run('open', () => start(selected)); }
  function open(row: Pick<BrowserSession, 'cwd' | 'id'>) {
    if (!canStart) return;
    void run('open', async () => {
      await piWebApi.open(row);
      setSelected(row.cwd);
      setTarget(null);
      setPreview(null);
      setModal(null);
    });
  }
  function send(delivery: Delivery) {
    if (!canSend || !active || !draft.trim()) return;
    void run('prompt', async () => {
      if (!command) await piWebApi.prompt(active.generation, draft.trim(), delivery);
      else {
        const { name, args } = command;
        switch (name) {
          case 'help': setModal('help'); break;
          case 'context': setModal('context'); break;
          case 'settings': setModal('settings'); break;
          case 'model': {
            if (!args) { setModal('settings'); break; }
            const model = active.models.find(item => `${item.provider}/${item.id}` === args);
            if (!model) throw invalid('没有找到该模型。用 /model 打开列表。');
            await piWebApi.settings(active.generation, { model: { provider: model.provider, id: model.id } });
            break;
          }
          case 'thinking':
            if (!args) { setModal('settings'); break; }
            if (!active.levels.includes(args)) throw invalid('当前模型不支持该思考档位。');
            await piWebApi.settings(active.generation, { thinking: args });
            break;
          case 'name':
            if (!args) setModal('settings'); else await piWebApi.settings(active.generation, { title: args });
            break;
          case 'new': await start(active.cwd, args || undefined); break;
          case 'resume': {
            if (!args) { showWorkspace(); break; }
            const { sessions } = await piWebApi.sessions(active.cwd);
            const row = sessions.find(item => item.id === args);
            if (!row) throw invalid('未在当前工作区找到该会话。请从侧栏查看。');
            inspect(row);
            break;
          }
          case 'compact': await piWebApi.compact(active.generation, args); break;
          case 'stop': await piWebApi.stop(active.generation); break;
        }
      }
      setDrafts(previous => previous.get(activeKey) === draft ? setDraftText(previous, activeKey, '') : previous);
    });
  }
  function stop() { if (canStop && active) void run('stop', () => piWebApi.stop(active.generation)); }

  const selectedSessions = listed.cwd === selected ? listed.sessions : [];
  const showList = (inDialog: boolean) => <WorkspaceList workspaces={workspaces} sessions={selectedSessions} active={active} target={readOnly ? target : null}
    selected={selected} error={catalogError} loading={loading || (ready && !!selected && listed.cwd !== selected)} ready={ready && !operation} canStart={canStart} mobile={inDialog}
    onBrowse={setSelected} onRemove={path => void run('workspace', () => changeWorkspace({ action: 'remove', path }))}
    onAdd={() => setModal('add')} onNew={create} onPreview={inspect} onLive={backToLive} onRefresh={() => refresh(value => value + 1)}
    onClose={() => inDialog ? setModal(null) : setSidebar(false)} />;
  const status = readOnly ? '只读历史' : live ? statusLabels[active.status] : state?.switching || operation === 'open' ? '正在打开' : ready ? active ? 'Pi 已断开' : '未打开会话' : link === 'retrying' ? '重连中' : '等待连接';
  const engineError = !readOnly && active?.error !== dismissed ? active?.error : undefined;
  const banner = notice || engineError;
  const messages = readOnly ? visiblePreview?.messages : active?.messages;
  const shown = readOnly ? target : active;
  const close = () => setModal(null);

  return <div className={styles.app}>
    <a className={styles.skip} href="#pi-web-conversation">跳到对话</a>
    {!mobile && sidebar && showList(false)}
    <main className={styles.main} id="pi-web-conversation" tabIndex={-1}>
      <header className={styles.header}>
        {(mobile || !sidebar) && <IconButton size="xl" label="显示工作区侧栏" icon={<IconMenuOutline20 />} onClick={showWorkspace} />}
        <div className={styles.identity}><h1 title={title}>{title}</h1>{cwd && <span title={cwd} className={styles.path}><FolderMark />{workspaceLabel(cwd)}</span>}</div>
        <div className={styles.headerTools}>
          <span className={styles.status} data-active={live && !readOnly && active.status !== 'idle' ? '' : undefined} role="status"><span aria-hidden="true" />{status}</span>
          {!readOnly && active && <>
            {!mobile && <button type="button" className={styles.modelButton} onClick={() => setModal('settings')}>{active.model?.name ?? '选择模型'}</button>}
            <IconButton size="xl" label="查看上下文" icon={<IconDataOutline16 />} onClick={() => setModal('context')} />
            <IconButton size="xl" label="会话设置" icon={<IconSettingsOutline16 />} onClick={() => setModal('settings')} />
          </>}
        </div>
      </header>
      {readOnly && <div className={styles.previewBar}>
        <div><strong>历史预览</strong><small>{visiblePreview ? sessionDate(visiblePreview.updatedAt) : '不会切换活跃会话'}</small></div>
        <div className={styles.inlineActions}>
          <button type="button" className={styles.secondary} onClick={backToLive}>返回</button>
          <button type="button" className={styles.primary} onClick={() => open(target)} disabled={!canStart || !visiblePreview}>{operation === 'open' ? '正在打开…' : '打开会话'}</button>
        </div>
      </div>}
      {readOnly && live && !canStart && !operation && <p className={styles.sessionHint}>当前 Pi 操作结束后才能打开另一会话。</p>}
      {banner && <div className={`${styles.banner} ${styles.error}`} role="alert"><span>{banner}</span><IconButton icon={<IconCloseOutline16 />} label="关闭提示" size="m" onClick={() => { setNotice(''); if (engineError) setDismissed(engineError); }} /></div>}
      {ready && !readOnly && active && !active.connected && <div className={`${styles.banner} ${styles.notice}`} role="status"><span>Pi 进程已断开。</span><button type="button" className={styles.secondary} disabled={!canStart} onClick={() => open(active)}>重新打开会话</button></div>}
      {state && (link === 'retrying' || link === 'closed') && <div className={`${styles.banner} ${styles.notice}`} role="status"><span>{link === 'closed' ? 'Pi Web 已关闭，请在终端重新运行。' : '实时连接中断，正在保留草稿并重连。'}</span><button type="button" className={styles.secondary} onClick={reconnect}>重连</button></div>}
      <div className={styles.chat}>
        {shown && messages?.length ? <Transcript key={`${readOnly}:${sessionKey(shown.cwd, shown.id)}`} messages={messages} /> : readOnly
          ? <Empty title={previewError ? '无法预览' : visiblePreview ? '此会话还没有消息' : ready ? '正在读取历史…' : '等待连接…'}>
            {previewError && <><p>{previewError}</p><button type="button" className={styles.secondary} onClick={() => refreshPreview(value => value + 1)} disabled={!ready}>重试</button></>}
          </Empty> : active ? <Empty title="开始 Pi 对话"><p>消息由此工作区的原生 Pi 处理，对话写入 Pi 会话记录。</p>
            {!active.model && <button type="button" className={styles.secondary} onClick={() => setModal('settings')}>选择模型</button>}</Empty>
            : ready ? <Empty title="打开一个 Pi 会话"><p>选择已有会话，或在本机工作区新建。此网页不需要打开 Pi 终端。</p>
              <div className={styles.inlineActions}><button type="button" className={styles.primary} onClick={create} disabled={!canStart || !selected}>新建会话</button>
                <button type="button" className={styles.secondary} onClick={() => setModal('add')}>添加工作区</button></div></Empty>
            : <Empty title={link === 'needsLink' ? '打开 Pi Web 启动链接' : link === 'retrying' ? '暂时无法连接 Pi Web' : '正在连接 Pi Web…'}>
              {link === 'needsLink' ? <p>运行 <code>pnpm pi-web</code>，打开终端打印的完整链接。</p> : linkError && <p>{linkError}</p>}
              {(link === 'retrying' || link === 'closed') && <button type="button" className={styles.secondary} onClick={reconnect}>重试</button>}
            </Empty>}
      </div>
      {!readOnly && active && <PiComposer key={activeKey} text={draft} setText={text => setDrafts(previous => setDraftText(previous, activeKey, text))}
        skills={active.skills} commands={active.commands} status={active.status} canSend={canSend} canStop={canStop}
        onSend={send} onStop={stop} pending={operation === 'prompt'} disabledReason={!live ? 'Pi Web 未就绪，草稿仍保留。' : !active.model && !command ? '在 Pi 配置模型后即可发送。' : undefined} />}
    </main>
    {mobile && modal === 'workspaces' && <Overlay title="工作区与会话" side="left" onClose={close}>{showList(true)}</Overlay>}
    {modal === 'add' && <WorkspacePicker initialPath={selected || state?.cwd || ''} onClose={close} onSave={changeWorkspace} />}
    {active && modal === 'settings' && <BrowserSettingsPanel key={active.generation} state={active} writable={live && canStart} onClose={close}
      onSave={async patch => { await piWebApi.settings(active.generation, patch); }} />}
    {active && modal === 'context' && <BrowserContextPanel key={active.generation} state={active} writable={live && canStart} onClose={close} />}
    {active && modal === 'help' && <BrowserHelp commands={active.commands} onClose={close} />}
  </div>;
}
