import type { MessageView, SessionStatus } from '../types';
import type { ModelRef, PiCommand, PiModel, PiSessionSummary, PiSkill } from '../pi/model';

export interface BrowserWorkspace { cwd: string; name: string; saved: boolean; launch: boolean }
export interface BrowserSession extends PiSessionSummary { cwd: string }
export interface BrowserModel extends PiModel { contextWindow: number | null }
export interface BrowserState {
  generation: number;
  id: string;
  cwd: string;
  title: string;
  connected: boolean;
  switching: boolean;
  status: SessionStatus;
  model: BrowserModel | null;
  models: BrowserModel[];
  thinking: string;
  levels: string[];
  commands: PiCommand[];
  skills: PiSkill[];
  messages: MessageView[];
  autoCompaction: boolean;
  pendingMessageCount: number;
  error?: string;
}
export interface BrowserSettings { title?: string; model?: ModelRef; thinking?: string; autoCompaction?: boolean }

export function isBrowserState(value: unknown): value is BrowserState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<BrowserState>;
  return Number.isSafeInteger(state.generation) && typeof state.id === 'string' && typeof state.cwd === 'string'
    && typeof state.title === 'string' && typeof state.connected === 'boolean' && typeof state.switching === 'boolean'
    && (state.status === 'idle' || state.status === 'running' || state.status === 'compacting' || state.status === 'stopping')
    && Array.isArray(state.messages) && Array.isArray(state.models) && Array.isArray(state.levels)
    && Array.isArray(state.commands) && Array.isArray(state.skills);
}

export function isCurrent(row: Pick<BrowserSession, 'id' | 'cwd'> | null, state: Pick<BrowserState, 'id' | 'cwd'> | null) {
  return !!row && !!state && row.id === state.id && row.cwd === state.cwd;
}

export function sessionKey(cwd: string, id: string) { return JSON.stringify([cwd, id]); }

export function workspaceSelection(workspaces: readonly Pick<BrowserWorkspace, 'cwd'>[], selected: string, fallback: string) {
  if (workspaces.some(workspace => workspace.cwd === selected)) return selected;
  if (workspaces.some(workspace => workspace.cwd === fallback)) return fallback;
  return workspaces[0]?.cwd ?? '';
}

export function setDraftText(previous: Map<string, string>, key: string, text: string) {
  if ((previous.get(key) ?? '') === text) return previous;
  const next = new Map(previous);
  next.delete(key);
  if (text) next.set(key, text);
  if (next.size > 24) next.delete(next.keys().next().value!);
  return next;
}

const local = /^(context|settings|model|thinking|name|new|resume|compact|stop|help)$/u;
export function parseBrowserCommand(text: string) {
  const match = /^\/([\w][\w.:-]*)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match || !local.test(match[1])) return null;
  return { name: match[1], args: match[2]?.trim() ?? '' };
}
