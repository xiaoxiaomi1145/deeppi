import type { Delta, MessageView, SessionStatus } from '../types';

export interface ModelRef { provider: string; id: string }
export interface PiModel extends ModelRef { name: string }
export interface PiModelOption extends PiModel { reasoning: boolean; contextWindow: number; maxOutputTokens: number; levels: string[] }

export const thinkingLabels: Record<string, string> = {
  inherit: '跟随 Pi', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', adaptive: '自动',
};
const orderedThinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function thinkingFor(levels: readonly string[], requested: string): string {
  if (levels.includes(requested)) return requested;
  const index = orderedThinking.indexOf(requested);
  for (let i = index - 1; i >= 0; i -= 1) if (levels.includes(orderedThinking[i])) return orderedThinking[i];
  return levels.includes('off') ? 'off' : levels[0] ?? 'off';
}
export interface PiSkill { name: string; description: string }
export interface PiTool { name: string; description: string; active: boolean; exposure?: unknown }
export interface PiMcp { name: string; transport: 'http' | 'stdio'; enabled: boolean; exposure?: unknown; source: 'pi' | 'session'; tools: number }
export type AddonId = 'compact' | 'bash';
export interface PiState {
  id: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  connected: boolean;
  model: PiModel | null;
  models: PiModelOption[];
  thinking: string;
  levels: string[];
  systemPrompt: string;
  tools: PiTool[];
  skills: PiSkill[];
  mcp: PiMcp[];
  canImport: boolean;
  messages: MessageView[];
  context: { tokens: number | null; window: number | null };
  error?: string;
  addons?: Record<AddonId, boolean>;
}

export interface PiSessionSummary { id: string; title: string; updatedAt: number; messageCount: number }
export interface PiWorkspace { cwd: string; name: string; sessions: PiSessionSummary[] }
export interface PiCatalog { currentId: string; workspaces: PiWorkspace[] }
export interface PiHistory { id: string; title: string; cwd: string; updatedAt: number; messages: MessageView[] }

export type Delivery = 'steer' | 'followUp';
export interface PromptPayload { text: string; mode?: Delivery; skill?: string }
export interface CompactPayload { focus?: string; enhanced?: true }
export interface SettingsPatch { title?: string; model?: ModelRef; thinking?: string; systemPrompt?: string; activeTools?: string[] }
export type SettingsDraft = Required<Omit<SettingsPatch, 'model'>> & { model: ModelRef | null };
export type ResourceAction =
  | { action: 'register-mcp'; name: string; transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[]; tokenEnv?: string; exposure?: string; confirmed: true }
  | { action: 'remove-mcp'; name: string }
  | { action: 'import-skill'; markdown: string; confirmed: true };
export interface ResourceResult { reloadRequired: boolean; name?: string }

export const statusLabels: Record<SessionStatus, string> = {
  idle: '空闲', running: '生成中', stopping: '正在停止', compacting: '压缩中',
};

export function applyPiDeltas<T extends Pick<PiState, 'status' | 'messages'>>(state: T, deltas: readonly Delta[], now = Date.now()): T {
  if (state.status !== 'running') return state;
  let next: MessageView[] | undefined;
  for (const delta of deltas) {
    if (!delta.messageId || (!delta.text && !delta.thinking)) continue;
    const current = next ?? state.messages;
    let index = current.length - 1;
    while (index >= 0 && current[index].id !== delta.messageId) index -= 1;
    const previous = current[index];
    if (previous && (previous.role !== 'assistant' || (previous.state && previous.state !== 'running'))) continue;
    const message: MessageView = previous ?? { id: delta.messageId, role: 'assistant', state: 'running', text: '', timestamp: now };
    const patched = { ...message, text: message.text + (delta.text ?? '') };
    if (delta.thinking) patched.thinking = (message.thinking ?? '') + delta.thinking;
    next ??= state.messages.slice();
    if (previous) next[index] = patched;
    else next.push(patched);
  }
  return next ? { ...state, messages: next } : state;
}

export function promptPayload(text: string, status: SessionStatus, delivery: Delivery, skill: string): PromptPayload | null {
  const value = text.trim();
  if (!value || (status !== 'idle' && status !== 'running')) return null;
  return { text: value, ...(status === 'running' && { mode: delivery }), ...(skill && { skill }) };
}

export function compactPayload(focus: string, enhanced: boolean, enabled: boolean): CompactPayload {
  const value = focus.trim();
  return { ...(value && { focus: value }), ...(enhanced && enabled && { enhanced: true }) };
}

export function modelKey(model: ModelRef | null) {
  return model ? JSON.stringify([model.provider, model.id]) : '';
}

export function settingsDraft(state: PiState): SettingsDraft {
  const { title, thinking, systemPrompt } = state;
  return { title, thinking, systemPrompt, model: state.model, activeTools: state.tools.filter((tool) => tool.active).map((tool) => tool.name) };
}

export function settingsPatch(original: SettingsDraft, draft: SettingsDraft): SettingsPatch {
  const patch: SettingsPatch = {};
  if (original.title !== draft.title && draft.title.trim() !== original.title) patch.title = draft.title.trim();
  if (original.systemPrompt !== draft.systemPrompt) patch.systemPrompt = draft.systemPrompt;
  if (original.thinking !== draft.thinking) patch.thinking = draft.thinking;
  if (draft.model && modelKey(original.model) !== modelKey(draft.model)) {
    patch.model = { provider: draft.model.provider, id: draft.model.id };
  }
  const active = new Set(original.activeTools);
  if (active.size !== draft.activeTools.length || draft.activeTools.some((name) => !active.has(name))) patch.activeTools = draft.activeTools;
  return patch;
}

export function visibleHistory<T extends { id: string }>(history: T | null, currentId?: string): T | null {
  return history?.id === currentId ? null : history;
}

export function workspaceLabel(cwd: string) {
  return cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd || '工作区';
}
