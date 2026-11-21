import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { AppError } from '../settings.mjs';

const web = {
  model: ['选择或切换 Pi 模型', '[服务商/模型]'], thinking: ['设置当前模型思考强度', '[档位]'],
  settings: ['打开网页设置'], session: ['查看会话和上下文'], context: ['配置会话上下文'],
  name: ['重命名当前会话', '<标题>'], new: ['在当前工作区启动 Pi 新会话'], resume: ['查看或切换已有会话', '[会话 ID]'],
  compact: ['执行 Pi 原生压缩', '[保留重点]'], stop: ['停止当前生成或压缩'], reload: ['重新加载 Pi 扩展和技能'],
  mcp: ['在网页查看和管理 MCP'], 'deeppi-addons': ['打开 Deeppi 附加能力设置'],
  'deeppi-compact': ['使用 Deeppi 增强压缩', '[保留重点]'], copy: ['复制最后一条助手回复'], help: ['查看网页可用指令'],
};
const terminal = {
  tree: '在终端逐分支导航', 'scoped-models': '调整终端模型范围', login: '在终端完成官方服务商认证', logout: '退出官方服务商认证',
  export: '原生会话导出', import: '原生会话导入', share: '原生分享', bug: '向 Pi 报告问题', fork: '从历史消息分叉',
  clone: '克隆会话', trust: '配置项目可信状态', hotkeys: '终端快捷键', changelog: 'Pi 更新日志', quit: '退出 Pi',
};
const commandPattern = /^\/([\w][\w.:-]*)(?:[\t\n ]+([\s\S]*))?$/u;

export function webCommands(registered) {
  const commands = new Map(Object.entries(web).map(([name, [description, argumentHint]]) => [name, { name, kind: 'native', description, argumentHint }]));
  for (const [name, description] of Object.entries(terminal)) commands.set(name, { name, kind: 'terminal', description });
  // Pi gives extension command handlers precedence over templates with the same invocation name.
  const ordered = [...registered].sort((a, b) => Number(b.source === 'extension') - Number(a.source === 'extension'));
  for (const { name, source, description } of ordered) {
    if (typeof name !== 'string' || name.length > 128 || !commandPattern.test(`/${name}`) || commands.has(name)) continue;
    const kind = source === 'prompt' || source === 'skill' ? source : 'terminal';
    commands.set(name, { name, kind, description: typeof description === 'string' ? description.slice(0, 400) : '' });
  }
  return [...commands.values()];
}

export function slashCommand(value, registered) {
  const matched = commandPattern.exec(value.trim());
  if (!matched) return null;
  const [, name, args = ''] = matched;
  const found = webCommands(registered).find(command => command.name === name);
  if (!found) throw new AppError(400, '未找到此 Pi 指令。输入 /help 查看可用指令，或在开头加反斜杠发送原文。');
  if (found.kind === 'terminal') throw new AppError(400, `/${name} 需要 Pi 终端，未发送给模型。`);
  return { name, args: args.trim(), kind: found.kind };
}

const mentionPattern = /(`+)[\s\S]*?\1|~~~[^\n]*\n[\s\S]*?~~~|(?<![\\\w@])@skills:([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![\w/-])/gu;
const maxSkillBytes = 256 * 1024;
const attr = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function readSkill(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSkillBytes) throw new Error('Invalid skill file');
    const buffer = Buffer.alloc(maxSkillBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxSkillBytes) throw new Error('Skill too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch { throw new AppError(409, '无法读取 Pi 已注册的技能。请在 Pi 重载资源并重试。'); }
  finally { await file?.close(); }
}

export async function expandSkillMentions(value, registered, stripFrontmatter = text => text) {
  const names = [...new Set([...value.matchAll(mentionPattern)].map(match => match[2]).filter(Boolean))];
  if (!names.length) return value;
  if (names.length > 8) throw new AppError(400, '一次最多引用 8 个技能。');
  const skills = new Map(registered.filter(command => command.source === 'skill').map(command => [command.name, command.sourceInfo?.path]));
  const blocks = await Promise.all(names.map(async name => {
    const path = skills.get(`skill:${name}`);
    if (typeof path !== 'string' || !isAbsolute(path)) throw new AppError(400, `技能 ${name} 不属于当前 Pi 会话。`);
    const body = stripFrontmatter(await readSkill(path)).trim();
    return `<skill name="${attr(name)}" location="${attr(path)}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`;
  }));
  if (blocks.reduce((size, block) => size + Buffer.byteLength(block), Buffer.byteLength(value)) > 512 * 1024) {
    throw new AppError(400, '引用技能和消息合计不能超过 512 KiB。');
  }
  return `${blocks.join('\n\n')}\n\n${value}`;
}
