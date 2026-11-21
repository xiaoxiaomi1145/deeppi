import type { SessionStatus } from '../types';
import type { PiCommand, PiSkill } from './model';

export interface InputToken { kind: 'slash' | 'skill'; start: number; end: number; query: string }
export interface InputSuggestion { name: string; value: string; description: string; hint?: string; terminal?: boolean }
const word = /^([A-Za-z0-9_.:-]*)/u;
const slashLine = /^\/([\w][\w.:-]*)(?=\s|$)/u;

export function isSlashInput(value: string): boolean { return slashLine.test(value.trimStart()); }

export function inputToken(value: string, caret: number): InputToken | null {
  const before = value.slice(0, caret);
  const after = value.slice(caret);
  const slash = /^(\s*)\/([A-Za-z0-9_.:-]*)$/u.exec(before);
  if (slash && !/^[\/]/u.test(after)) return { kind: 'slash', start: slash[1].length, end: caret + (word.exec(after)?.[1].length ?? 0), query: slash[2] };
  const skill = /(?:^|[^\w@\\])@(s(?:k(?:i(?:l(?:l(?:s(?::([A-Za-z0-9_-]*))?)?)?)?)?)?)?$/u.exec(before);
  if (!skill) return null;
  const start = before.lastIndexOf('@');
  const suffix = /^[A-Za-z0-9_:-]*/u.exec(after)?.[0].length ?? 0;
  return { kind: 'skill', start, end: caret + suffix, query: skill[2] ?? '' };
}

export function inputSuggestions(token: InputToken | null, skills: readonly PiSkill[], commands: readonly PiCommand[]): InputSuggestion[] {
  if (!token) return [];
  const query = token.query.toLowerCase();
  const values = token.kind === 'skill'
    ? skills.map(skill => ({ name: skill.name, value: `@skills:${skill.name}`, description: skill.description }))
    : commands.map(command => ({ name: command.name, value: `/${command.name}`, description: command.description ?? '', hint: command.argumentHint,
      terminal: command.kind === 'terminal' }));
  const matches = (value: InputSuggestion) => `${value.name} ${value.description}`.toLowerCase().includes(query);
  const rank = (value: InputSuggestion) => (value.name.toLowerCase().startsWith(query) ? 0 : 1) + (value.terminal ? 2 : 0);
  return values.filter(matches).sort((left, right) => rank(left) - rank(right)).slice(0, 8);
}

export function insertInputToken(text: string, token: InputToken, value: string) {
  const tail = text.slice(token.end);
  const prefix = text.slice(0, token.start) + value;
  return { text: prefix + (/^[\t ]/u.test(tail) ? '' : ' ') + tail, caret: prefix.length + 1 };
}

export function composerControl(status: SessionStatus, hasText: boolean, slash: boolean) {
  if ((!hasText && status === 'running') || status === 'compacting' || status === 'stopping') {
    return { primary: 'stop' as const, label: status === 'stopping' ? '正在停止' : '停止当前操作', alternate: false };
  }
  const alternate = status === 'running' && hasText && !slash;
  return { primary: 'send' as const, label: slash ? '执行指令' : alternate ? '排队发送' : '发送消息', alternate };
}
