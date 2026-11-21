import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { errorText } from '../api';
import type { PiState, ResourceAction, ResourceResult } from './model';
import { piApi } from './transport';
import styles from './Pi.module.css';

const exposures = {
  codemode: '代码模式', deferred: '按需加载', direct: '直接提供', hidden: '隐藏',
} as const;

type Form = 'mcp' | 'skill' | null;
const mcpName = /^[A-Za-z0-9_-]+$/u;
const mcpEnv = /^MCP_[A-Z0-9_]+$/u;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

function HttpEndpoint({ url, setUrl, tokenEnv, setTokenEnv }: {
  url: string; setUrl: (value: string) => void; tokenEnv: string; setTokenEnv: (value: string) => void;
}) {
  const noteId = useId();
  return <>
    <label className={styles.field}>服务地址<input type="url" placeholder="https://mcp.example.org/mcp" value={url} onChange={(event) => setUrl(event.target.value)} required /></label>
    <label className={styles.field}>令牌环境变量（可选）<input aria-describedby={noteId} value={tokenEnv} placeholder="MCP_EXAMPLE_TOKEN" autoComplete="off" spellCheck={false} onChange={(event) => setTokenEnv(event.target.value)} /></label>
    <p className={styles.note} id={noteId}>只填写以 <code>MCP_</code> 开头的变量名，密钥留在终端环境里。不要在服务地址中填写密钥。</p>
  </>;
}

function RegistrationForm({ kind, disabled, pending, onSubmit, onCancel }: {
  kind: Exclude<Form, null>; disabled: boolean; pending: boolean; onSubmit: (action: ResourceAction) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [tokenEnv, setTokenEnv] = useState('');
  const [exposure, setExposure] = useState<keyof typeof exposures>('codemode');
  const [markdown, setMarkdown] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || disabled || pending) return;
    setValidation('');
    if (kind === 'skill') {
      if (markdown.trim()) await onSubmit({ action: 'import-skill', markdown, confirmed: true });
      return;
    }
    if (!mcpName.test(name.trim())) {
      setValidation('MCP 名称只能使用英文字母、数字、下划线或连字符。');
      return;
    }
    const stub = { action: 'register-mcp' as const, name: name.trim(), transport, exposure, confirmed: true as const };
    if (transport === 'stdio') {
      if (!command.trim()) return;
      const params = args.split(/\r?\n/u).filter(Boolean);
      await onSubmit({ ...stub, command: command.trim(), ...(params.length && { args: params }) });
    } else {
      let address: URL;
      try { address = new URL(url.trim()); } catch { setValidation('请输入完整的 HTTP 或 HTTPS 地址。'); return; }
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
        setValidation('请填写不含账号、密码、查询参数或片段的 HTTP(S) 地址。');
        return;
      }
      if (address.protocol === 'http:' && !loopback.has(address.hostname)) {
        setValidation('远程 MCP 服务必须使用 HTTPS。本机回环地址可使用 HTTP。');
        return;
      }
      const environment = tokenEnv.trim();
      if (environment && !mcpEnv.test(environment)) {
        setValidation('令牌环境变量须以 MCP_ 开头，且仅使用大写字母、数字和下划线。');
        return;
      }
      await onSubmit({ ...stub, url: address.href, ...(environment && { tokenEnv: environment }) });
    }
  }
  return <form className={styles.resourceForm} onSubmit={(event) => void submit(event)} aria-label={kind === 'mcp' ? '登记 MCP 服务' : '导入技能'}>
    <fieldset disabled={disabled || pending}>
      <legend>{kind === 'mcp' ? '登记 MCP 服务' : '导入技能'}</legend>
      {kind === 'mcp' ? <>
        <div className={styles.fieldPair}>
          <label className={styles.field}>名称<input required maxLength={64} value={name} placeholder="my-server" autoComplete="off" spellCheck={false} onChange={(event) => setName(event.target.value)} /></label>
          <label className={styles.field}>传输方式<select value={transport} onChange={(event) => { setTransport(event.target.value as typeof transport); setConfirmed(false); }}>
            <option value="http">HTTP</option><option value="stdio">stdio（本地命令）</option>
          </select></label>
        </div>
        {transport === 'http' ? <HttpEndpoint url={url} setUrl={setUrl} tokenEnv={tokenEnv} setTokenEnv={setTokenEnv} /> : <>
          <label className={styles.field}>命令<input value={command} onChange={(event) => setCommand(event.target.value)} spellCheck={false} autoComplete="off" required /></label>
          <label className={styles.field}>参数（每行一项）<textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} spellCheck={false} /></label>
        </>}
        <label className={styles.field}>工具如何提供<select value={exposure} onChange={(event) => setExposure(event.target.value as typeof exposure)}>
          {Object.entries(exposures).map(([id, label]) => <option key={id} value={id}>{label}（{id}）</option>)}
        </select></label>
      </> : <label className={styles.field}>SKILL.md<textarea rows={8} spellCheck={false} placeholder={'---\nname: my-skill\ndescription: …\n---'} value={markdown} onChange={(event) => setMarkdown(event.target.value)} required /></label>}
      <label className={`${styles.checkRow} ${styles.trust}`}>
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>{kind === 'skill' ? '我信任该技能内容。Pi 使用技能时会读取其中的指令。'
          : transport === 'stdio' ? '我信任此命令及参数，并了解 Pi 将以当前用户权限执行它。'
            : '我信任此服务，并了解调用工具时可能向它发送会话数据。'}</span>
      </label>
      {validation && <p className={styles.error} role="alert">{validation}</p>}
    </fieldset>
    <div className={styles.inlineActions}>
      <button className={styles.secondary} type="button" onClick={onCancel} disabled={pending}>取消</button>
      <button className={styles.primary} type="submit" disabled={disabled || pending || !confirmed}>{pending ? '正在提交…' : kind === 'mcp' ? '登记服务' : '安装技能'}</button>
    </div>
  </form>;
}

export function Resources({ state, writable }: { state: PiState; writable: boolean }) {
  const [form, setForm] = useState<Form>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ResourceResult & { action: ResourceAction['action'] } | null>(null);
  const [error, setError] = useState('');
  const [remove, setRemove] = useState('');
  async function apply(action: ResourceAction) {
    if (pending || !writable) return;
    setPending(true);
    setError('');
    setResult(null);
    try {
      setResult({ ...await piApi.resources(action), action: action.action });
      setForm(null);
      setRemove('');
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(false); }
  }
  return <div className={styles.settingsStack}>
    <section className={styles.settingsSection} aria-label="MCP 服务">
      <div className={styles.sectionHeading}><h3>MCP 服务</h3><button type="button" className={styles.secondary} disabled={!writable || !state.canImport || pending || !!form} onClick={() => { setRemove(''); setForm('mcp'); }}>登记服务</button></div>
      <p className={styles.note}>Pi 管理并调用这些工具。工具数量不代表服务已连接。</p>
      {state.mcp.length > 0 ? <ul className={styles.resourceList}>{state.mcp.map((server) => <li key={server.name}>
        <div><strong>{server.name}</strong><small>{[server.transport === 'http' ? 'HTTP' : 'stdio', server.enabled ? '已启用' : '未启用', `${server.tools} 个工具`, typeof server.exposure === 'string' && (exposures[server.exposure as keyof typeof exposures] ?? server.exposure), server.source === 'pi' ? 'Pi 配置' : '本会话'].filter(Boolean).join(' · ')}</small></div>
        {server.source === 'session' && (remove === server.name ? <div className={styles.inlineActions}>
          <button type="button" className={styles.secondary} disabled={pending} onClick={() => setRemove('')}>取消</button>
          <button type="button" className={`${styles.secondary} ${styles.danger}`} disabled={!writable || pending} onClick={() => void apply({ action: 'remove-mcp', name: server.name })}>确认移除</button>
        </div> : <button type="button" className={styles.secondary} disabled={!writable || pending || !!form} aria-label={`移除 ${server.name}`} onClick={() => setRemove(server.name)}>移除</button>)}
      </li>)}</ul> : <p className={styles.note}>未登记 MCP 服务。</p>}
      {form === 'mcp' && <RegistrationForm kind="mcp" disabled={!writable} pending={pending} onSubmit={apply} onCancel={() => setForm(null)} />}
    </section>
    <section className={styles.settingsSection} aria-label="技能">
      <div className={styles.sectionHeading}><h3>技能</h3><button type="button" className={styles.secondary} disabled={!writable || !state.canImport || pending || !!form} onClick={() => { setRemove(''); setForm('skill'); }}>导入技能</button></div>
      <p className={styles.note}>{state.canImport ? '导入可信的 SKILL.md，也可在发送消息时使用已有技能。' : '当前 Pi 不接受网页导入。可在终端管理技能。'}</p>
      {state.skills.length > 0 ? <ul className={styles.resourceList}>{state.skills.map((skill) => <li key={skill.name}><div><strong>{skill.name}</strong><small>{skill.description || '无说明'}</small></div></li>)}</ul> : <p className={styles.note}>当前没有可用技能。</p>}
      {form === 'skill' && <RegistrationForm kind="skill" disabled={!writable} pending={pending} onSubmit={apply} onCancel={() => setForm(null)} />}
    </section>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {result && <p className={styles.notice} role="status">{result.action === 'import-skill' ? '技能已安装。' : result.action === 'remove-mcp' ? 'MCP 服务已移除。' : 'MCP 服务已登记。'}{result.reloadRequired && <>请在 Pi 终端运行 <code>/reload</code> 加载变更，再通过 <code>/deeppi</code> 打开网页。</>}</p>}
  </div>;
}
