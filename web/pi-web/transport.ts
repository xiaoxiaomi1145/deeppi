import { nativeEvents, nativeRequest } from '../pi/transport';
import type { Delivery, PiHistory } from '../pi/model';
import type { DirectoryListing, WorkspaceAction } from '../types';
import type { BrowserSession, BrowserSettings, BrowserWorkspace } from './model';

const root = '/api/pi-web';
const get = <T>(path: string, signal?: AbortSignal) => nativeRequest<T>(`${root}${path}`, 'GET', undefined, signal);
const post = (path: string, body: object) => nativeRequest<{ ok: true }>(`${root}${path}`, 'POST', body);
const query = (fields: Record<string, string>) => `?${new URLSearchParams(fields)}`;

export const piWebApi = {
  events: (onEvent: (event: string, data: unknown) => void, signal: AbortSignal, onActivity?: () => void) =>
    nativeEvents(`${root}/events`, onEvent, signal, onActivity),
  workspaces: (signal?: AbortSignal) => get<{ selected: string; workspaces: BrowserWorkspace[] }>('/workspaces', signal),
  sessions: (cwd: string, signal?: AbortSignal) => get<{ sessions: BrowserSession[] }>(`/sessions${query({ cwd })}`, signal),
  history: (cwd: string, id: string, signal?: AbortSignal) => get<PiHistory>(`/history${query({ cwd, id })}`, signal),
  directories: (path?: string, signal?: AbortSignal) => get<DirectoryListing>(`/directories${path ? query({ path }) : ''}`, signal),
  workspace: (action: WorkspaceAction) => post('/workspaces', action),
  create: (cwd: string, title?: string) => post('/sessions', { cwd, title }),
  open: ({ cwd, id }: Pick<BrowserSession, 'id' | 'cwd'>) => post('/switch', { cwd, id }),
  prompt: (generation: number, text: string, mode: Delivery) => post('/prompt', { generation, text, mode }),
  stop: (generation: number) => post('/stop', { generation }),
  compact: (generation: number, focus: string) => post('/compact', { generation, focus }),
  settings: (generation: number, settings: BrowserSettings) => post('/settings', { generation, ...settings }),
};
