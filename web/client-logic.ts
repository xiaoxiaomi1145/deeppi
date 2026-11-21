import type { Delta, MessageView, Session, SessionPatch, SessionUpdate, Settings, Usage } from './types';

export function appendDelta(session: Session, delta: Delta, now = Date.now()): Session {
  if ((!delta.text && !delta.thinking) || session.status === 'idle') return session;
  let index = -1;
  for (let candidate = session.messages.length - 1; candidate >= 0; candidate -= 1) {
    if (session.messages[candidate].id === delta.messageId) {
      index = candidate;
      break;
    }
  }
  const existing = index >= 0 ? session.messages[index] : undefined;
  if (existing && existing.role !== 'assistant') return session;

  const message: MessageView = existing ?? {
    id: delta.messageId, role: 'assistant', state: 'running', text: '', timestamp: now,
  };
  const next = { ...message, text: message.text + (delta.text ?? '') };
  if (delta.thinking) next.thinking = (message.thinking ?? '') + delta.thinking;
  const messages = session.messages.slice();
  if (existing) messages[index] = next;
  else messages.push(next);
  return { ...session, messages };
}

export function applySessionUpdate(session: Session, update: SessionUpdate): Session {
  const { messagesFrom, messages: tail, ...meta } = update;
  if (meta.id !== session.id || !Number.isInteger(messagesFrom) || messagesFrom < 0 || messagesFrom > session.messages.length) return session;
  const messages = messagesFrom === session.messages.length && tail.length === 0
    ? session.messages
    : [...session.messages.slice(0, messagesFrom), ...tail];
  return { ...meta, messages };
}

export function settingsPatch(original: Settings, edited: Settings, keyInput: string, clearKey: boolean): SessionPatch {
  const settings = Object.fromEntries(
    (Object.keys(original) as (keyof Settings)[])
      .filter((key) => original[key] !== edited[key])
      .map((key) => [key, edited[key]]),
  );
  const key = keyInput.trim();
  return { settings, ...(clearKey ? { apiKey: null } : key ? { apiKey: key } : {}) };
}

export function composerShortcut(event: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): 'send' | 'cancel' | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (event.key === 'Escape') return 'cancel';
  if (event.key === 'Enter' && !event.shiftKey) return 'send';
  return undefined;
}

export function cacheHitRate(usage: Pick<Usage, 'hit' | 'miss'>): number | undefined {
  const measured = usage.hit + usage.miss;
  return measured > 0 ? usage.hit / measured : undefined;
}
