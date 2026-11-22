import { acceptLaunchLink, ApiError } from '../api';
import { readEvents } from '../sse';
import type { AddonId, CompactPayload, PiCatalog, PiHistory, PiState, PromptPayload, PromptResult, ResourceAction, ResourceResult, SettingsPatch, WebModelAction } from './model';
import type { QqPatch, QqView } from './qq-model';

const prefix = '/api/pi';
let launchToken: string | null = null;

function token() {
  const hashToken = new URLSearchParams(location.hash.slice(1)).get('access');
  if (acceptLaunchLink()) launchToken = hashToken;
  if (!launchToken) {
    try { launchToken = sessionStorage.getItem('deeppi.access'); } catch { /* Private tabs can deny storage. */ }
  }
  return launchToken && /^[A-Za-z0-9_-]{43}$/u.test(launchToken) ? launchToken : null;
}

export function hasAccess() { return Boolean(token()); }

function authorization(): Record<string, string> {
  const key = token();
  if (!key) throw new ApiError('请打开 Pi 用 /deeppi 打印的完整链接。', 401);
  return { Authorization: `Bearer ${key}` };
}

function failed(response: Response, data: unknown): ApiError {
  const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : '';
  return new ApiError(message || `请求失败（${response.status}）`, response.status);
}

export async function nativeRequest<T>(url: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    headers: { ...authorization(), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || (data === undefined && response.status !== 204)) throw failed(response, data);
  return data as T;
}

const request = <T>(path: string, method?: string, body?: object, signal?: AbortSignal) =>
  nativeRequest<T>(`${prefix}${path}`, method, body, signal);

export async function nativeEvents(url: string, onEvent: (event: string, data: unknown) => void, signal: AbortSignal, onActivity?: () => void) {
  const response = await fetch(url, {
    signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    headers: { ...authorization(), Accept: 'text/event-stream' },
  });
  if (!response.ok) throw failed(response, await response.json().catch(() => undefined));
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Pi 未返回实时事件流。');
  }
  await readEvents(response.body, onEvent, onActivity);
}

export const piApi = {
  state: (signal?: AbortSignal) => request<PiState>('/state', 'GET', undefined, signal),
  catalog: (signal?: AbortSignal) => request<PiCatalog>('/catalog', 'GET', undefined, signal),
  history: (id: string, signal?: AbortSignal) => request<PiHistory>(`/history?${new URLSearchParams({ id })}`, 'GET', undefined, signal),
  switch: (id: string) => request<{ ok: true }>('/switch', 'POST', { id }),
  prompt: (body: PromptPayload) => request<PromptResult>('/prompt', 'POST', body),
  models: (body: WebModelAction) => request<{ ok: true; notice?: string }>('/models', 'POST', body),
  stop: () => request<unknown>('/stop', 'POST', {}),
  compact: (body: CompactPayload) => request<unknown>('/compact', 'POST', body),
  probe: (signal?: AbortSignal) => request<{ model: string }>('/probe', 'POST', {}, signal),
  settings: (body: SettingsPatch) => request<unknown>('/settings', 'PATCH', body),
  resources: (body: ResourceAction) => request<ResourceResult>('/resources', 'POST', body),
  addons: (id: AddonId, enabled: boolean) => request<{ ok: true }>('/addons', 'POST', { id, enabled, ...(id === 'bash' && enabled && { confirmed: true }) }),
  qq: (signal?: AbortSignal) => request<QqView>('/qq', 'GET', undefined, signal),
  qqSettings: (body: QqPatch, signal?: AbortSignal) => request<QqView>('/qq', 'PATCH', body, signal),
  qqProbe: (signal?: AbortSignal) => request<{ botId: string; nickname?: string }>('/qqprobe', 'POST', {}, signal),
  qqReset: (id: string, signal?: AbortSignal) => request<QqView>('/qqreset', 'POST', { id }, signal),
  events: (onEvent: (event: string, data: unknown) => void, signal: AbortSignal, onActivity?: () => void) =>
    nativeEvents(`${prefix}/events`, onEvent, signal, onActivity),
};
