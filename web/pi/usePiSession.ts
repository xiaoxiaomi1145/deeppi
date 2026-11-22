import { useEffect, useReducer, useState } from 'react';
import { ApiError, errorText } from '../api';
import type { Delta } from '../types';
import { applyPiDeltas, type PiState } from './model';
import { firstRetryMs, retryAfter, shouldWakeStream, staleStream, watchdogMs, type StreamHealth } from './stream-health';
import { hasAccess, piApi } from './transport';

export type LinkStatus = 'connecting' | 'open' | 'retrying' | 'closed' | 'needsLink';

function isState(value: unknown): value is PiState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PiState>;
  return typeof state.id === 'string' && typeof state.title === 'string' && typeof state.cwd === 'string' && typeof state.connected === 'boolean'
    && (state.status === 'idle' || state.status === 'running' || state.status === 'compacting' || state.status === 'stopping')
    && Array.isArray(state.messages) && Array.isArray(state.models) && Array.isArray(state.tools) && Array.isArray(state.skills)
    && Array.isArray(state.mcp) && Array.isArray(state.levels) && !!state.context;
}

function isDelta(value: unknown): value is Delta {
  if (!value || typeof value !== 'object') return false;
  const delta = value as Partial<Delta>;
  return typeof delta.messageId === 'string' && (delta.text === undefined || typeof delta.text === 'string')
    && (delta.thinking === undefined || typeof delta.thinking === 'string');
}

export function usePiSession() {
  return usePiStream(piApi.events, isState);
}

export function usePiStream<T extends Pick<PiState, 'status' | 'messages'>>(
  events: typeof piApi.events,
  accepts: (value: unknown) => value is T,
) {
  const [state, setState] = useState<T | null>(null);
  const [link, setLink] = useState<LinkStatus>('connecting');
  const [linkError, setLinkError] = useState('');
  const [attempt, reconnect] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const newLink = () => { if (hasAccess()) reconnect(); };
    addEventListener('hashchange', newLink);
    return () => removeEventListener('hashchange', newLink);
  }, []);

  useEffect(() => {
    if (!hasAccess()) {
      setLink('needsLink');
      setState(null);
      return;
    }
    type Connection = StreamHealth & { controller: AbortController };
    let stream: Connection | undefined;
    let stopped = false;
    let terminal = false;
    let retryTimer = 0;
    let retryDelay = firstRetryMs;
    let frame = 0;
    let pending: Delta[] = [];

    function dropPending() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = [];
    }
    function flush() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!pending.length || stopped) return;
      const batch = pending;
      pending = [];
      setState(previous => previous ? applyPiDeltas(previous, batch) : previous);
    }
    function cancelStream() {
      const abandoned = stream;
      stream = undefined;
      abandoned?.controller.abort();
    }
    function scheduleRetry(message: string) {
      if (stopped || terminal || retryTimer) return;
      setLink('retrying');
      setLinkError(message);
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        void connect();
      }, retryDelay);
      retryDelay = retryAfter(retryDelay);
    }
    function terminate(next: 'needsLink' | 'closed') {
      terminal = true;
      cancelStream();
      if (next === 'needsLink') { dropPending(); setState(null); }
      else flush();
      setLink(next);
      setLinkError('');
    }
    async function connect() {
      if (stopped || terminal || stream) return;
      const now = Date.now();
      const current: Connection = { controller: new AbortController(), startedAt: now, lastActivity: now, ready: false };
      stream = current;
      try {
        await events((event, data) => {
          if (stream !== current) return;
          if (event === 'state' && accepts(data)) {
            // A complete snapshot supersedes deltas queued before it.
            dropPending();
            current.ready = true;
            retryDelay = firstRetryMs;
            setState(data);
            setLink('open');
            setLinkError('');
          } else if (event === 'delta' && current.ready && isDelta(data)) {
            pending.push(data);
            if (pending.length >= 128) flush();
            else if (!frame) frame = requestAnimationFrame(flush);
          } else if (event === 'closed') terminate('closed');
        }, current.controller.signal, () => { current.lastActivity = Date.now(); });
      } catch (cause) {
        if (stream !== current) return;
        if (cause instanceof ApiError && cause.status === 401) { terminate('needsLink'); return; }
        setLinkError(errorText(cause));
        stream = undefined;
        flush();
        scheduleRetry(errorText(cause));
        return;
      }
      if (stream !== current) return;
      stream = undefined;
      flush();
      scheduleRetry('Pi 实时连接已断开。');
    }
    const watchdog = window.setInterval(() => {
      if (!stream || !staleStream(stream, Date.now())) return;
      const ready = stream.ready;
      flush();
      cancelStream();
      scheduleRetry(ready ? '未收到 Pi 心跳。' : 'Pi 连接超时。');
    }, watchdogMs);
    function wake(reason: 'visible' | 'online') {
      if (!shouldWakeStream(reason, stream, Date.now(), navigator.onLine !== false, terminal || stopped)) return;
      flush();
      cancelStream();
      clearTimeout(retryTimer);
      retryTimer = 0;
      retryDelay = firstRetryMs;
      setLink('retrying');
      setLinkError('');
      void connect();
    }
    function visible() { if (document.visibilityState === 'visible') wake('visible'); }
    const online = () => wake('online');
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    window.addEventListener('pageshow', visible);
    window.addEventListener('online', online);
    setLink('connecting');
    setLinkError('');
    void connect();
    return () => {
      stopped = true;
      cancelStream();
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      dropPending();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
      window.removeEventListener('pageshow', visible);
      window.removeEventListener('online', online);
    };
  }, [attempt, accepts, events]);

  return { state, link, linkError, reconnect };
}
