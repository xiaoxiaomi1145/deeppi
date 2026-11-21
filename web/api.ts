import { readEvents } from './sse';
import type { DefaultsPatch, DirectoryListing, Info, ProbeInput, Session, SessionPatch, SessionSummary, WorkspaceAction } from './types';

const accessKey = 'deeppi.access';
let activeToken: string | null = null;

export function acceptLaunchLink(): boolean {
  const token = new URLSearchParams(location.hash.slice(1)).get('access');
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  activeToken = token;
  try { sessionStorage.setItem(accessKey, token); } catch { /* Tab storage is optional. */ }
  history.replaceState(history.state, '', location.pathname + location.search);
  return true;
}

function authorization(): Record<string, string> {
  acceptLaunchLink();
  if (!activeToken) {
    try { activeToken = sessionStorage.getItem(accessKey); } catch { /* Tab storage is optional. */ }
  }
  return activeToken ? { Authorization: `Bearer ${activeToken}` } : {};
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(url: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method,
    signal,
    headers: { ...authorization(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data === undefined) {
    throw new ApiError(typeof data?.error === 'string' ? data.error : `请求失败（${response.status}）`, response.status);
  }
  return data as T;
}

const sessions = '/api/sessions';
const sessionUrl = (id: string) => `${sessions}/${encodeURIComponent(id)}`;

export const api = {
  info: (signal?: AbortSignal) => request<Info>('/api/info', 'GET', undefined, signal),
  defaults: (input: DefaultsPatch) => request<Info>('/api/settings', 'PATCH', input),
  workspace: (input: WorkspaceAction) => request<Info>('/api/workspaces', 'POST', input),
  folders: (path?: string, signal?: AbortSignal) => request<DirectoryListing>(`/api/directories${path === undefined ? '' : `?${new URLSearchParams({ path })}`}`, 'GET', undefined, signal),
  probe: (input: ProbeInput, signal?: AbortSignal) => request<{ model: string }>('/api/connection', 'POST', input, signal),
  list: (signal?: AbortSignal) => request<{ sessions: SessionSummary[] }>(sessions, 'GET', undefined, signal),
  create: (input: SessionPatch = {}) => request<{ session: Session }>(sessions, 'POST', input),
  get: (id: string, signal?: AbortSignal) => request<{ session: Session }>(sessionUrl(id), 'GET', undefined, signal),
  patch: (id: string, body: SessionPatch) => request<{ session: Session }>(sessionUrl(id), 'PATCH', body),
  delete: (id: string) => request<{ ok: true }>(sessionUrl(id), 'DELETE'),
  prompt: (id: string, text: string) => request<{ ok: true }>(`${sessionUrl(id)}/prompt`, 'POST', { text }),
  continue: (id: string) => request<{ ok: true }>(`${sessionUrl(id)}/continue`, 'POST', {}),
  stop: (id: string) => request<{ ok: true }>(`${sessionUrl(id)}/stop`, 'POST', {}),
  compact: (id: string, focus: string) => request<{ ok: true }>(`${sessionUrl(id)}/compact`, 'POST', focus ? { focus } : {}),
  removeTool: (id: string, name: string) => request<{ session: Session }>(`${sessionUrl(id)}/tools/remove`, 'POST', { name }),
  async events(id: string, onEvent: (event: string, data: unknown) => void, signal: AbortSignal) {
    const response = await fetch(`${sessionUrl(id)}/events`, { headers: { ...authorization(), Accept: 'text/event-stream' }, signal });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => undefined);
      throw new ApiError(typeof data?.error === 'string' ? data.error : `实时连接失败（${response.status}）`, response.status);
    }
    await readEvents(response.body, onEvent);
  },
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return '无法联系 Deeppi，请检查连接后重试。';
}
