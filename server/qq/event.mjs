import { plainObject } from '../settings.mjs';
import { qqId } from './settings.mjs';

const limits = { raw: 48_000, text: 12_000, images: 6, segments: 160 };
const decode = value => value.replace(/&#91;/gu, '[').replace(/&#93;/gu, ']').replace(/&amp;/gu, '&');
const param = value => decode(value.replace(/&#44;/gu, ','));

function parseCq(message) {
  const value = message.slice(0, limits.raw);
  const segments = [];
  let end = 0;
  for (const match of value.matchAll(/\[CQ:([a-zA-Z_]{1,32})(?:,([^\[\]]{0,8192}))?\]/gu)) {
    if (segments.length >= limits.segments - 2) break;
    if (match.index > end) segments.push({ type: 'text', data: { text: decode(value.slice(end, match.index)) } });
    const type = match[1];
    if (type === 'at' || type === 'image') {
      const data = Object.create(null);
      for (const pair of (match[2] ?? '').split(',')) {
        const equals = pair.indexOf('=');
        const key = pair.slice(0, equals);
        if (equals > 0 && (key === 'qq' || key === 'file' || key === 'url')) data[key] = param(pair.slice(equals + 1));
      }
      segments.push({ type, data });
    }
    end = match.index + match[0].length;
  }
  if (end < value.length) segments.push({ type: 'text', data: { text: decode(value.slice(end)) } });
  return segments;
}

const gate = (id, mode, allow, deny) => !deny.includes(id) && (mode === 'all' || allow.includes(id));
const eventId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  return (typeof value === 'string' || typeof value === 'number') && /^-?[0-9]{1,20}$/u.test(String(value)) ? String(value) : '';
};

export function normalizeQqEvent(event, settings) {
  if (!settings.enabled || !plainObject(event) || event.post_type !== 'message') return null;
  const bot = qqId(event.self_id);
  const user = qqId(event.user_id);
  const id = eventId(event.message_id);
  const group = event.message_type === 'group' ? qqId(event.group_id) : '';
  if (!bot || bot !== settings.botId || !id || !user || user === bot ||
      !gate(user, settings.userMode, settings.userAllow, settings.userDeny)) return null;
  if (event.message_type === 'private') {
    if (!settings.privateEnabled) return null;
  } else if (event.message_type !== 'group' || !group || !settings.groupEnabled ||
      !gate(group, settings.groupMode, settings.groupAllow, settings.groupDeny)) return null;

  const wire = event.message ?? event.raw_message;
  const segments = Array.isArray(wire) ? wire.slice(0, limits.segments) : typeof wire === 'string' ? parseCq(wire) : [];
  const images = [];
  let mentioned = false, text = '';
  for (const segment of segments) {
    if (!plainObject(segment?.data)) continue;
    const { type, data } = segment;
    if (type === 'at' && qqId(data.qq) === bot) mentioned = true;
    if (type === 'text' && typeof data.text === 'string' && text.length < limits.text) {
      text += data.text.slice(0, limits.text - text.length);
    }
    if (settings.stickers && type === 'image' && images.length < limits.images) {
      const source = {};
      if (typeof data.url === 'string' && data.url.length <= 8192) source.url = data.url;
      if (typeof data.file === 'string' && data.file.length <= 2_900_000) source.file = data.file;
      if (source.url || source.file) images.push(source);
    }
  }
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  if (group && settings.groupTrigger === 'mention' && !mentioned) return null;
  if (group && settings.groupTrigger === 'prefix') {
    const tail = text.slice(settings.prefix.length);
    if (!text.startsWith(settings.prefix) || (tail && !/^\s/u.test(tail))) return null;
    text = tail.trim();
  }
  if (!text && !images.length) return null;
  const scope = group ? `${bot}:g:${group}${settings.groupContext === 'per-user' ? `:u:${user}` : ''}` : `${bot}:p:${user}`;
  return {
    id, bot, user, group, scope, text, images,
    label: group ? `群 ${group}${settings.groupContext === 'per-user' ? ` · QQ ${user}` : ''}` : `私聊 ${user}`,
    allowedExtra: settings.toolUsers.includes(user),
  };
}
