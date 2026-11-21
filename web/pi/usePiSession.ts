import { useEffect, useReducer, useState } from 'react';
import { ApiError, errorText } from '../api';
import type { Delta } from '../types';
import { applyPiDeltas, type PiState } from './model';
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
  const [state, setState] = useState<PiState | null>(null);
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
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let retryTimer = 0;
    let connectController: AbortController | undefined;
    let frame = 0;
    let pending: Delta[] = [];
    let retryDelay = 450;
    let initialized = false;
    function dropPending() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = [];
    }
    function flush() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!pending.length || signal.aborted) return;
      const batch = pending;
      pending = [];
      setState((previous) => previous ? applyPiDeltas(previous, batch) : previous);
    }
    function retry() {
      if (signal.aborted) return;
      retryTimer = window.setTimeout(() => void connect(), retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    }
    async function connect() {
      if (signal.aborted) return;
      const controller = new AbortController();
      connectController = controller;
      let closed = false;
      let snapshotSeen = false;
      try {
        if (!initialized) {
          const initial = await piApi.state(controller.signal);
          if (signal.aborted) return;
          if (!isState(initial)) throw new Error('无效的 Pi 状态。');
          setState(initial);
          initialized = true;
        }
        await piApi.events((event, data) => {
          if (signal.aborted || closed) return;
          if (event === 'state' && isState(data)) {
            // Complete snapshots supersede fragments already delivered, including queued frames.
            dropPending();
            snapshotSeen = true;
            retryDelay = 450;
            setState(data);
            setLink('open');
            setLinkError('');
          } else if (event === 'delta' && snapshotSeen && isDelta(data)) {
            pending.push(data);
            if (pending.length >= 128) flush();
            else if (!frame) frame = requestAnimationFrame(flush);
          } else if (event === 'closed') {
            closed = true;
            controller.abort();
          }
        }, controller.signal);
      } catch (cause) {
        if (signal.aborted) return;
        if (!closed && cause instanceof ApiError && cause.status === 401) {
          dropPending();
          setState(null);
          setLink('needsLink');
          setLinkError('');
          return;
        }
        if (!closed) setLinkError(errorText(cause));
      }
      if (signal.aborted) return;
      flush();
      if (closed) {
        setLink('closed');
        setLinkError('');
        return;
      }
      setLink('retrying');
      retry();
    }
    setLink('connecting');
    setLinkError('');
    void connect();
    return () => {
      lifetime.abort();
      connectController?.abort();
      clearTimeout(retryTimer);
      dropPending();
    };
  }, [attempt]);

  return { state, link, linkError, reconnect };
}
