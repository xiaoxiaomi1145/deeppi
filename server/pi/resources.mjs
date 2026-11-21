import { readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, isLoopback, plainObject } from '../settings.mjs';

const exposures = new Set(['codemode', 'deferred', 'direct', 'hidden']);
const validServerName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const namespace = name => name.replaceAll('-', '_');
const skillsFor = pi => pi.getCommands().filter(command => command.source === 'skill' && command.name.startsWith('skill:'))
  .map(command => ({ name: command.name.slice(6), description: command.description ?? '' }));

function configFile(path) {
  try {
    if (statSync(path).size > 1024 * 1024) return [];
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
    if (plainObject(value?.mcpServers)) return Object.entries(value.mcpServers);
  } catch { /* Pi reports invalid configurations in its own UI. */ }
  return [];
}

function registration(input) {
  if (input.confirmed !== true) throw new AppError(403, '请先确认信任此 MCP 服务。');
  const config = {};
  if (input.exposure !== undefined) {
    if (!exposures.has(input.exposure)) throw new AppError(400, 'MCP 工具暴露设置无效。');
    config.exposure = input.exposure;
  }
  if (input.transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const args = input.args ?? [];
    if (!command || command.length > 1024 || /[\x00-\x1f\x7f]/u.test(command) || !Array.isArray(args) || args.length > 32 ||
        args.some(value => typeof value !== 'string' || value.length > 2000 || value.includes('\0'))) {
      throw new AppError(400, '请提供单个可执行命令和分开的参数。');
    }
    return { ...config, command, args };
  }
  if (input.transport !== 'http') throw new AppError(400, 'MCP 传输方式无效。');
  let address;
  if (typeof input.url === 'string' && input.url.length <= 2048) {
    try { address = new URL(input.url); } catch { /* report below */ }
  }
  if (!address || address.username || address.password || address.search || address.hash ||
      (address.protocol !== 'https:' && (address.protocol !== 'http:' || !isLoopback(address.hostname)))) {
    throw new AppError(400, 'MCP 地址须为不含凭据、参数或片段的 HTTPS 地址，或本机 HTTP。');
  }
  if (input.tokenEnv !== undefined) {
    if (typeof input.tokenEnv !== 'string' || !/^MCP_[A-Z0-9_]{1,100}$/u.test(input.tokenEnv)) {
      throw new AppError(400, '仅支持 MCP_ 开头的 MCP 令牌环境变量。');
    }
    config.headers = { Authorization: `Bearer \${${input.tokenEnv}}` };
  }
  return { ...config, url: address.href };
}

export function createPiResources({ pi, agentDir, configDirName, parseFrontmatter }) {
  const own = new Set();

  function configured(ctx) {
    const result = new Map();
    const files = [join(agentDir, 'mcp.json')];
    if (ctx.isProjectTrusted()) files.push(join(ctx.cwd, configDirName, 'mcp.json'));
    for (const path of files) {
      for (const [name, config] of configFile(path)) {
        if (!validServerName(name) || !plainObject(config)) continue;
        if ([...result.keys()].some(other => other !== name && namespace(other) === namespace(name))) continue;
        if (typeof config.command === 'string' || typeof config.url === 'string') result.set(name, config);
        else if (result.has(name)) {
          const previous = result.get(name);
          result.set(name, { ...previous, enabled: config.enabled ?? previous.enabled, exposure: config.exposure ?? previous.exposure });
        }
      }
    }
    return result;
  }

  function snapshot(ctx, tools) {
    const rows = new Map();
    const configuredServers = configured(ctx);
    const add = (name, config, source) => {
      const prefix = `mcp__${namespace(name)}__`;
      rows.set(namespace(name), { name, transport: typeof config.url === 'string' ? 'http' : 'stdio',
        enabled: config.enabled !== false, exposure: exposures.has(config.exposure) ? config.exposure : 'codemode',
        source, tools: tools.filter(tool => tool.name.startsWith(prefix)).length });
    };
    for (const { name, config } of pi.getMcpServers()) add(name, config, own.has(name) ? 'session' : 'pi');
    for (const [name, config] of configuredServers) add(name, config, 'pi');
    return { skills: skillsFor(pi), mcp: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)), canImport: true };
  }

  async function importSkill(markdown) {
    if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 256 * 1024 || markdown.includes('\0')) {
      throw new AppError(400, 'SKILL.md 须为不超过 256 KiB 的 UTF-8 文本。');
    }
    let frontmatter;
    try { ({ frontmatter } = parseFrontmatter(markdown)); } catch { throw new AppError(400, '技能的 YAML 元数据无效。'); }
    const { name, description } = frontmatter ?? {};
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64 ||
        typeof description !== 'string' || !description.trim() || description.length > 1024) {
      throw new AppError(400, 'SKILL.md 需要有效的 name 和 description，名称只能使用小写字母、数字及单连字符。');
    }
    const root = join(agentDir, 'skills');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw new AppError(409, 'Pi 用户技能目录不是普通目录。');
    const dest = join(root, name);
    try { await mkdir(dest, { mode: 0o700 }); } catch (error) {
      if (error.code === 'EEXIST') throw new AppError(409, '同名技能已存在，未覆盖。');
      throw error;
    }
    try { await writeFile(join(dest, 'SKILL.md'), markdown, { flag: 'wx', mode: 0o600, encoding: 'utf8' }); }
    catch (error) { await rmdir(dest).catch(() => {}); throw error; }
    return { reloadRequired: true, name };
  }

  async function apply(ctx, input) {
    if (input.action === 'import-skill') {
      if (input.confirmed !== true) throw new AppError(403, '请先确认信任此技能的内容。');
      return importSkill(input.markdown);
    }
    const { name } = input;
    if (!validServerName(name)) throw new AppError(400, 'MCP 名称只允许字母、数字、下划线和连字符。');
    if (input.action === 'remove-mcp') {
      if (!own.has(name)) throw new AppError(404, '仅可移除通过 Deeppi 在此会话登记的服务。');
      pi.unregisterMcpServer(name);
      own.delete(name);
    } else if (input.action === 'register-mcp') {
      const config = registration(input);
      const taken = [...configured(ctx).keys(), ...pi.getMcpServers().map(item => item.name)].some(other => namespace(other) === namespace(name));
      if (taken) throw new AppError(409, '该 MCP 名称已被使用。');
      try { pi.registerMcpServer(name, config); } catch { throw new AppError(400, 'Pi 未接受此 MCP 配置，请查看终端中的 /mcp。'); }
      own.add(name);
    } else throw new AppError(400, '资源操作无效。');
    return { reloadRequired: false, name };
  }
  return { snapshot, apply, skills: () => skillsFor(pi) };
}
