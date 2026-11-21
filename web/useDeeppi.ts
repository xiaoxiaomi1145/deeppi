import { useEffect, useRef, useState } from 'react';
import { acceptLaunchLink, api, ApiError, errorText } from './api';
import { appendDelta, applySessionUpdate } from './client-logic';
import type { DefaultsPatch, Delta, Info, ProbeInput, Session, SessionPatch, SessionSummary, SessionUpdate, Settings, WorkspaceAction } from './types';

const activeKey = 'deeppi.activeSession';
type Connection = 'connecting' | 'online' | 'reconnecting';
type Prepared = { settings: Partial<Settings>; key?: { scope: string; value: string } };
const emptyPrepared: Prepared = { settings: {} };
const scope = ({ provider, baseUrl }: Settings) => `${provider}\n${baseUrl}`;

function remember(id: string | null) {
  try { localStorage.setItem(activeKey, id ?? ''); } catch { /* Browser storage is optional. */ }
}

function rememberedId(): string | null {
  try { return localStorage.getItem(activeKey); } catch { return null; }
}

function sortSessions(sessions: SessionSummary[]) {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function useDeeppi() {
  const [info, setInfo] = useState<Info | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [preparedByWorkspace, setPrepared] = useState<Record<string, Prepared>>({});
  const [connection, setConnection] = useState<Connection>('connecting');
  const [bootError, setBootError] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const selected = useRef<string | null>(null);
  const online = useRef<string | null>(null);
  const streamRevision = useRef(0);
  const mutation = useRef(false);
  const stopRequest = useRef(false);
  const workspace = info?.defaults.cwd ?? '';
  const prepared = preparedByWorkspace[workspace] ?? emptyPrepared;
  const draftSettings = info && { ...info.defaults, ...prepared.settings };
  const draftKey = draftSettings && prepared.key?.scope === scope(draftSettings) ? prepared.key.value : undefined;
  const draftNeedsConnection = Boolean(info?.connection === 'missing' && draftSettings && scope(draftSettings) === scope(info.defaults) && !draftKey);

  function updateSummary({ id, title, status, updatedAt, cwd }: SessionSummary) {
    setSessions(previous => {
      const existing = previous.find(item => item.id === id);
      if (existing?.title === title && existing.status === status && existing.updatedAt === updatedAt && existing.cwd === cwd) return previous;
      return sortSessions([{ id, title, status, updatedAt, cwd }, ...previous.filter(item => item.id !== id)]);
    });
  }

  function accept(snapshot: Session) {
    updateSummary(snapshot);
    if (selected.current === snapshot.id) setSession(snapshot);
  }

  function select(id: string | null, seed: Session | null = null) {
    remember(id);
    if (id === selected.current && !seed) return;
    selected.current = id;
    online.current = null;
    streamRevision.current++;
    setSession(seed);
    setSessionError('');
    setConnection('connecting');
    setActiveId(id);
  }

  function forget(id: string) {
    setSessions(previous => previous.filter(item => item.id !== id));
    if (selected.current === id) select(null);
  }

  async function refreshOffline(id: string, signal?: AbortSignal) {
    if (online.current === id || selected.current !== id || signal?.aborted) return;
    const revision = ++streamRevision.current;
    const useSnapshot = () => selected.current === id && online.current !== id && streamRevision.current === revision && !signal?.aborted;
    try {
      const { session: snapshot } = await api.get(id, signal);
      if (useSnapshot()) {
        accept(snapshot);
        setSessionError('');
      }
    } catch (error) {
      if (!useSnapshot()) return;
      if (error instanceof ApiError && error.status === 404) forget(id);
      else setSessionError(errorText(error));
    }
  }

  useEffect(() => {
    function reauthorize() {
      if (!acceptLaunchLink()) return;
      setBootAttempt(value => value + 1);
      setStreamAttempt(value => value + 1);
    }
    window.addEventListener('hashchange', reauthorize);
    return () => window.removeEventListener('hashchange', reauthorize);
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setBootError('');
    void Promise.all([api.info(abort.signal), api.list(abort.signal)]).then(([nextInfo, list]) => {
      if (abort.signal.aborted) return;
      const ordered = sortSessions(list.sessions);
      const remembered = rememberedId();
      const restored = ordered.find(({ id }) => id === remembered);
      setInfo(nextInfo);
      setSessions(ordered);
      select(restored?.id ?? (remembered === null ? ordered.find(row => row.cwd === nextInfo.defaults.cwd)?.id ?? null : null));
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setBootError(errorText(error));
    });
    return () => abort.abort();
  }, [bootAttempt]);

  useEffect(() => {
    if (activeId === null) return;
    const id = activeId;
    const abort = new AbortController();
    const isCurrent = () => !abort.signal.aborted && selected.current === id;
    online.current = null;
    streamRevision.current++;
    setConnection('connecting');
    setSessionError('');
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = 350;
    let frame = 0;
    let buffered: Delta | undefined;
    function flushDelta() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const delta = buffered;
      buffered = undefined;
      if (delta && isCurrent()) setSession(previous => previous?.id === id ? appendDelta(previous, delta) : previous);
    }
    async function connect() {
      try {
        await api.events(id, (event, data) => {
          if (!isCurrent()) return;
          if (event === 'delta') {
            const delta = data as Delta;
            if (online.current !== id || !delta?.messageId) return;
            if (buffered && buffered.messageId !== delta.messageId) flushDelta();
            buffered = buffered ? {
              messageId: delta.messageId, text: (buffered.text ?? '') + (delta.text ?? ''),
              thinking: (buffered.thinking ?? '') + (delta.thinking ?? ''),
            } : delta;
            if (!frame) frame = requestAnimationFrame(flushDelta);
            return;
          }
          flushDelta();
          if (event === 'state') {
            const snapshot = data as Session;
            if (snapshot?.id !== id) return;
            streamRevision.current++;
            online.current = id;
            backoff = 350;
            accept(snapshot);
            setSessionError('');
            setConnection('online');
          } else if (event === 'update') {
            const update = data as SessionUpdate;
            if (online.current !== id || update?.id !== id) return;
            updateSummary(update);
            setSession(previous => previous?.id === id ? applySessionUpdate(previous, update) : previous);
          } else if (event === 'deleted') {
            forget(id);
          }
        }, abort.signal);
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof ApiError && error.status === 404) { forget(id); return; }
        if (error instanceof ApiError && error.status === 401) {
          online.current = null;
          setSessionError(error.message);
          setConnection('reconnecting');
          return;
        }
      }
      if (!isCurrent()) return;
      flushDelta();
      const wasOnline = online.current === id;
      online.current = null;
      setConnection('reconnecting');
      if (wasOnline) void refreshOffline(id, abort.signal);
      retry = setTimeout(() => { void connect(); }, backoff);
      backoff = Math.min(5000, backoff * 2);
    }
    void connect();
    void refreshOffline(id, abort.signal);
    return () => {
      abort.abort();
      if (frame) cancelAnimationFrame(frame);
      if (retry !== undefined) clearTimeout(retry);
    };
  }, [activeId, streamAttempt]);

  async function run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (mutation.current) throw new ApiError('请等待当前操作完成。', 409);
    mutation.current = true;
    setPending(name);
    try { return await action(); }
    finally { mutation.current = false; setPending(null); }
  }

  function acceptMutation(snapshot: Session) {
    if (online.current === snapshot.id) return;
    if (selected.current === snapshot.id) streamRevision.current++;
    accept(snapshot);
  }

  async function patch(id: string, body: SessionPatch) {
    const { session: snapshot } = await api.patch(id, body);
    acceptMutation(snapshot);
  }

  async function create() {
    const { session: next } = await api.create({ settings: prepared.settings, ...(draftKey ? { apiKey: draftKey } : {}) });
    setPrepared(previous => {
      if (!Object.hasOwn(previous, workspace)) return previous;
      const next = { ...previous };
      delete next[workspace];
      return next;
    });
    updateSummary(next);
    select(next.id, next);
    return next.id;
  }

  return {
    info, sessions, activeId, session, connection, bootError, sessionError, pending, stopping, draftSettings, draftNeedsConnection, draftHasKey: Boolean(draftKey),
    select: (id: string) => select(id),
    newChat: () => select(null),
    retryBoot: () => setBootAttempt(current => current + 1),
    reconnect: () => setStreamAttempt(current => current + 1),
    rename: (id: string, title: string) => run('rename', () => patch(id, { title })),
    saveDefaults: (body: DefaultsPatch) => run('defaults', async () => {
      setInfo(await api.defaults(body));
      if (selected.current) await refreshOffline(selected.current);
    }),
    saveSettings: (body: SessionPatch) => run('settings', async () => {
      if (selected.current) return patch(selected.current, body);
      if (!info || !draftSettings) return;
      const edited = { ...draftSettings, ...body.settings };
      const settings = Object.fromEntries(Object.entries(edited).filter(([key, value]) => value !== info.defaults[key as keyof Settings]));
      const value = Object.hasOwn(body, 'apiKey') ? body.apiKey : scope(draftSettings) === scope(edited) ? draftKey : undefined;
      setPrepared(previous => ({ ...previous, [workspace]: { settings, key: value ? { scope: scope(edited), value } : undefined } }));
    }),
    workspace: (body: WorkspaceAction) => run('workspace', async () => {
      const next = await api.workspace(body);
      setInfo(next);
      return next;
    }),
    probe: (body: ProbeInput, target: 'global' | 'session' | 'draft', signal: AbortSignal) => {
      if (target === 'global') return api.probe(body, signal);
      if (target === 'session') return api.probe({ ...body, sessionId: selected.current ?? undefined }, signal);
      const settings = { ...prepared.settings, ...body.settings };
      const edited = draftSettings && { ...draftSettings, ...body.settings };
      const keepKey = draftKey && edited && draftSettings && scope(edited) === scope(draftSettings);
      return api.probe({ settings, ...(Object.hasOwn(body, 'apiKey') ? { apiKey: body.apiKey } : keepKey ? { apiKey: draftKey } : {}) }, signal);
    },
    remove: (id: string) => run('delete', async () => { await api.delete(id); forget(id); }),
    send: (text: string, onTarget: (id: string) => void) => run('prompt', async () => {
      const id = selected.current ?? await create();
      onTarget(id);
      await api.prompt(id, text);
      await refreshOffline(id);
    }),
    continue: (id: string) => run('continue', async () => {
      await api.continue(id);
      await refreshOffline(id);
    }),
    stop: async () => {
      if (!session || session.status === 'idle' || session.status === 'stopping' || stopRequest.current) return;
      stopRequest.current = true;
      setStopping(true);
      try { await api.stop(session.id); await refreshOffline(session.id); }
      finally { stopRequest.current = false; setStopping(false); }
    },
    compact: (id: string, focus: string) => run('compact', async () => {
      await api.compact(id, focus);
      await refreshOffline(id);
    }),
    removeTool: (id: string, name: string) => run('removeTool', async () => {
      const { session: snapshot } = await api.removeTool(id, name);
      acceptMutation(snapshot);
    }),
  };
}
