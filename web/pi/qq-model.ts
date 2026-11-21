import type { ModelRef } from './model';

export const listFields = ['userAllow', 'userDeny', 'groupAllow', 'groupDeny', 'toolUsers'] as const;
export const numericFields = ['port', 'contextLimit', 'compactThreshold', 'keepRecentTokens', 'maxOutputTokens', 'cooldownMs'] as const;
export type SecretField = 'wsToken' | 'httpSecret' | 'httpToken';
export type ExtraTool = 'local_time' | 'text_count';
export const listLabels = { userAllow: '用户白名单', userDeny: '用户黑名单', groupAllow: '群聊白名单', groupDeny: '群聊黑名单', toolUsers: '工具用户白名单' } as const;
export const numericLabels = { port: '监听端口', contextLimit: '上下文容量', compactThreshold: '压缩阈值', keepRecentTokens: '保留近期上下文', maxOutputTokens: '最大输出', cooldownMs: '同一对话冷却时间' } as const;

type ListField = typeof listFields[number];
type NumericField = typeof numericFields[number];
type ListMode = 'all' | 'allowlist';
type Fields = {
  transport: 'ws' | 'http'; botId: string; httpApiUrl: string; model: ModelRef | null; thinking: string;
  privateEnabled: boolean; groupEnabled: boolean; groupTrigger: 'mention' | 'prefix' | 'all'; prefix: string;
  groupContext: 'shared' | 'per-user'; userMode: ListMode; groupMode: ListMode; extraTools: ExtraTool[];
  systemPrompt: string; compact: boolean; stickers: boolean; cacheRetention: 'none' | 'short' | 'long';
};
type Editable = Fields & Record<ListField, string[]> & Record<NumericField, number>;
export type QqDraft = Fields & Record<ListField | NumericField, string>;
export type SecretPatch = Partial<Record<SecretField, string>>;
export type QqPatch = Partial<Editable & { enabled: boolean; listen: boolean }> & SecretPatch;
export type QqSettings = Editable & {
  enabled: boolean; listen: boolean; hasWsToken: boolean; hasHttpSecret: boolean; hasHttpToken: boolean;
};
export type QqConversation = { id: string; label: string; updatedAt: number; compactions: number; messages: number; busy: boolean };
export type QqView = {
  settings: QqSettings;
  status: { listening: boolean; connected: boolean; wsUrl?: string; httpUrl?: string; lastEventAt?: number; lastError?: string };
  conversations: QqConversation[];
  pending: number;
  usage: Partial<Record<'requests' | 'input' | 'hit' | 'miss' | 'unreported' | 'output' | 'compactionInput', number>>;
};

export function draftOf(settings: QqSettings): QqDraft {
  const { listen: _listen, enabled: _enabled, hasWsToken: _ws, hasHttpSecret: _secret, hasHttpToken: _http, ...draft } = settings;
  return { ...draft,
    port: String(draft.port), contextLimit: String(draft.contextLimit), compactThreshold: String(draft.compactThreshold),
    keepRecentTokens: String(draft.keepRecentTokens), maxOutputTokens: String(draft.maxOutputTokens), cooldownMs: String(draft.cooldownMs),
    userAllow: draft.userAllow.join('\n'), userDeny: draft.userDeny.join('\n'), groupAllow: draft.groupAllow.join('\n'),
    groupDeny: draft.groupDeny.join('\n'), toolUsers: draft.toolUsers.join('\n'),
  };
}

export function qqPatch(settings: QqSettings, draft: QqDraft, secrets: SecretPatch): QqPatch {
  const patch: QqPatch = {};
  const baseline = draftOf(settings);
  for (const name of Object.keys(draft) as (keyof QqDraft)[]) {
    if (JSON.stringify(draft[name]) === JSON.stringify(baseline[name])) continue;
    if (name === 'userAllow' || name === 'userDeny' || name === 'groupAllow' || name === 'groupDeny' || name === 'toolUsers') {
      const values = [...new Set(draft[name].split(/[\s,，、;；]+/u).filter(Boolean))];
      if (values.length > 1000 || values.some(id => !/^[1-9][0-9]{0,19}$/u.test(id))) throw new Error(`${listLabels[name]}仅接受数字账号，最多 1000 项。`);
      if (values.length === settings[name].length && values.every(id => settings[name].includes(id))) continue;
      patch[name] = values;
    } else if (name === 'port' || name === 'contextLimit' || name === 'compactThreshold' || name === 'keepRecentTokens' || name === 'maxOutputTokens' || name === 'cooldownMs') {
      const value = Number(draft[name]);
      if (!/^\d+$/u.test(draft[name]) || !Number.isSafeInteger(value)) throw new Error(`${numericLabels[name]}需要整数。`);
      if (settings[name] !== value) patch[name] = value;
    } else Object.assign(patch, { [name]: draft[name] });
  }
  return { ...patch, ...secrets };
}
