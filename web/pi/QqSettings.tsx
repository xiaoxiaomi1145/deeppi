import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorText } from '../api';
import { modelKey, thinkingFor, type PiState } from './model';
import { draftOf, listLabels, numericLabels, qqPatch, type ExtraTool, type QqDraft, type QqSettings as Saved, type QqView, type SecretField, type SecretPatch } from './qq-model';
import { ThinkingSlider } from './ThinkingSlider';
import { piApi } from './transport';
import styles from './Pi.module.css';

type Form = { original: Saved; values: QqDraft; secrets: SecretPatch };
type Operation = 'save' | 'listen' | 'enable' | 'probe' | 'reset';
const fmt = new Intl.NumberFormat('zh-CN');
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const extras: Record<ExtraTool, string> = { local_time: '本机时间', text_count: '统计字符数' };
const stored = { wsToken: 'hasWsToken', httpSecret: 'hasHttpSecret', httpToken: 'hasHttpToken' } as const;
const editForm = (original: Saved): Form => ({ original, values: draftOf(original), secrets: {} });
const modified = ({ original, values, secrets }: Form) => JSON.stringify(draftOf(original)) !== JSON.stringify(values) || Object.keys(secrets).length !== 0;

export function QqSettings({ state, connected }: { state: PiState; connected: boolean }) {
  const [view, setView] = useState<QqView>();
  const [form, setForm] = useState<Form>();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [confirmReset, setConfirmReset] = useState<string>();
  const [loadError, setLoadError] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const running = useRef<AbortController>();
  const updateVersion = useRef(0);
  const receive = useCallback((response: QqView, reset?: boolean) => {
    setView(response);
    setForm(previous => !previous || reset || !modified(previous) ? editForm(response.settings) : previous);
    setLoadError('');
  }, []);
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    if (!connected) return;
    const reader = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const before = updateVersion.current;
      if (!running.current) {
        try {
          const response = await piApi.qq(reader.signal);
          if (!reader.signal.aborted && before === updateVersion.current) receive(response);
        } catch (error) {
          if (!reader.signal.aborted && before === updateVersion.current) setLoadError(errorText(error));
        }
      }
      if (!reader.signal.aborted) timer = setTimeout(() => void refresh(), 2200);
    }
    void refresh();
    return () => { clearTimeout(timer); reader.abort(); };
  }, [connected, receive]);

  async function operate(kind: Operation, call: (signal: AbortSignal) => Promise<{ response: QqView; message: string }>) {
    if (!connected || running.current) return;
    const controller = new AbortController();
    running.current = controller;
    updateVersion.current += 1;
    setResult(undefined);
    setOperation(kind);
    try {
      const { response, message } = await call(controller.signal);
      if (controller.signal.aborted) return;
      receive(response, kind === 'save');
      setResult({ ok: true, text: message });
      if (kind === 'reset') setConfirmReset(undefined);
    } catch (error) {
      if (!controller.signal.aborted) setResult({ ok: false, text: errorText(error) });
    } finally {
      running.current = undefined;
      if (!controller.signal.aborted) setOperation(null);
    }
  }

  if (!view || !form) return <section className={styles.settingsSection} aria-label="QQ / OneBot">
    <h3>QQ / OneBot v11</h3><p className={loadError ? styles.error : styles.note} role={loadError ? 'alert' : 'status'}>
      {loadError || (connected ? '正在读取 QQ 配置…' : '等待 Pi 网页连接…')}
    </p>
  </section>;

  const { values: draft, secrets } = form;
  const { status, settings, usage } = view;
  const disabled = !connected || !!operation;
  const dirty = modified(form);
  const connectionDirty = ['transport', 'botId', 'port', 'httpApiUrl'].some(key => {
    const field = key as 'transport' | 'botId' | 'port' | 'httpApiUrl';
    return String(form.original[field]) !== draft[field];
  }) || Object.keys(secrets).length > 0;
  const endpoint = status.wsUrl || status.httpUrl;
  const selected = state.models.find(candidate => modelKey(candidate) === modelKey(draft.model));
  const modelLevels = (model: typeof selected) => ['inherit', ...(model?.levels ?? (model ? ['off'] : state.levels))];
  const change = <K extends keyof QqDraft>(key: K, value: QqDraft[K]) => {
    setForm(previous => previous && ({ ...previous, values: { ...previous.values, [key]: value } }));
    setResult(undefined);
  };
  const secretChange = (key: SecretField, value?: string) => {
    setForm(previous => {
      if (!previous) return previous;
      const next = { ...previous.secrets };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return { ...previous, secrets: next };
    });
    setResult(undefined);
  };
  function secretField(key: SecretField, label: string, optional = false) {
    const present = settings[stored[key]];
    return <div className={styles.secretField}><label className={styles.field}>{label}
      <input type="password" autoComplete="new-password" spellCheck={false} minLength={8} maxLength={512}
        value={secrets[key] ?? ''} placeholder={secrets[key] === '' ? '保存后清除' : present ? '已配置；留空保留' : optional ? '本机接口可留空' : '至少 8 位字符'}
        onChange={event => secretChange(key, event.currentTarget.value || undefined)} />
    </label>{present && <button type="button" className={styles.secondary} onClick={() => secretChange(key, secrets[key] === '' ? undefined : '')}>
      {secrets[key] === '' ? '撤销清除' : '清除'}
    </button>}</div>;
  }
  function numberField(key: keyof typeof numericLabels, min: number, max: number) {
    return <label className={styles.field}>{numericLabels[key]}<input type="number" inputMode="numeric" min={min} max={max} step={1} required
      value={draft[key]} onChange={event => change(key, event.currentTarget.value)} /></label>;
  }
  function listField(key: keyof typeof listLabels) {
    return <label className={styles.field}>{listLabels[key]}<textarea rows={2} spellCheck={false} maxLength={21000} placeholder="用空格、逗号或换行分隔"
      value={draft[key]} onChange={event => change(key, event.currentTarget.value)} /></label>;
  }
  function check(key: 'privateEnabled' | 'groupEnabled' | 'compact' | 'stickers', label: string, note?: string) {
    return <label className={styles.checkRow}><input type="checkbox" checked={draft[key]} onChange={event => change(key, event.currentTarget.checked)} />
      <span><strong>{label}</strong>{note && <small>{note}</small>}</span></label>;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !dirty) return;
    await operate('save', async signal => ({ response: await piApi.qqSettings(qqPatch(form.original, form.values, form.secrets), signal), message: 'QQ 设置已保存。' }));
  }
  const toggleListen = () => void operate('listen', async signal => ({
    response: await piApi.qqSettings({ listen: !settings.listen }, signal),
    message: settings.listen ? '已停止监听和回复。' : '监听已启动，请连接 OneBot。',
  }));
  const toggleEnable = () => void operate('enable', async signal => ({
    response: await piApi.qqSettings({ enabled: !settings.enabled }, signal),
    message: settings.enabled ? '已停止自动回复，保留监听。' : 'QQ 回复已开启。',
  }));
  const test = () => void operate('probe', async signal => {
    const { botId, nickname } = await piApi.qqProbe(signal);
    return { response: await piApi.qq(signal), message: `OneBot 账号验证成功：${nickname ? `${nickname} · ` : ''}${botId}` };
  });

  return <section className={styles.settingsStack} aria-label="QQ / OneBot">
    <div className={styles.qqStatus}>
      <div className={styles.sectionHeading}><h3>QQ / OneBot v11</h3><span className={styles.qqBadge} data-online={status.connected || undefined}>
        {!status.listening ? '未监听' : status.connected ? '已连接' : '等待连接'}
      </span></div>
      <p className={styles.note}>{settings.enabled ? '自动回复已启用。' : '自动回复已关闭。'}{status.lastEventAt ? ` 最近事件 ${clock.format(status.lastEventAt)}。` : ''}</p>
      {endpoint && <code className={styles.qqUrl}>{endpoint}</code>}
      {status.lastError && <p className={styles.error} role="status">{status.lastError}</p>}
      {!connected && <p role="status" className={styles.note}>Pi 网页未连接，暂不能操作。</p>}
      <div className={styles.inlineActions}>
        <button type="button" className={styles.secondary} disabled={disabled || (!settings.listen && connectionDirty)} onClick={toggleListen}>
          {operation === 'listen' ? '正在处理…' : settings.listen ? '停止监听' : '开始监听'}</button>
        <button type="button" className={styles.secondary} disabled={disabled || !status.listening || connectionDirty} onClick={test}>{operation === 'probe' ? '测试中…' : '测试连接'}</button>
        <button type="button" className={settings.enabled ? styles.secondary : styles.primary}
          disabled={disabled || (!settings.enabled && (!status.connected || dirty))} onClick={toggleEnable}>
          {operation === 'enable' ? '正在更新…' : settings.enabled ? '关闭自动回复' : '开启自动回复'}</button>
      </div>
      <p className={styles.note}>先保存配置，再开启监听、连接 OneBot，最后开启自动回复。更换连接会自动关闭回复。</p>
    </div>
    {loadError && <p className={styles.error} role="status">{loadError}</p>}
    {result && <p className={result.ok ? styles.notice : styles.error} role={result.ok ? 'status' : 'alert'}>{result.text}</p>}
    <form onSubmit={event => void save(event)} className={styles.settingsStack}>
      <details className={styles.qqGroup} open>
        <summary>连接配置</summary>
        <fieldset disabled={disabled}>
          <label className={styles.field}>协议<select value={draft.transport} onChange={event => change('transport', event.currentTarget.value as QqDraft['transport'])}>
            <option value="ws">反向 WebSocket</option><option value="http">反向 HTTP</option></select></label>
          <div className={styles.fieldPair}>
            <label className={styles.field}>机器人 QQ 号<input inputMode="numeric" autoComplete="off" maxLength={20} value={draft.botId} onChange={event => change('botId', event.currentTarget.value)} /></label>
            {numberField('port', 0, 65535)}
          </div>
          {draft.transport === 'ws' ? <>{secretField('wsToken', 'WebSocket Token')}<p className={styles.note}>OneBot 使用反向 WS，填写同一个 Token。支持 Universal 或分离的 API / Event。</p></> : <>
            <label className={styles.field}>OneBot HTTP API 地址<input type="url" autoComplete="off" value={draft.httpApiUrl} placeholder="http://127.0.0.1:3000" onChange={event => change('httpApiUrl', event.currentTarget.value)} /></label>
            {secretField('httpSecret', '回调签名密钥')}{secretField('httpToken', 'HTTP API Token', true)}
            <p className={styles.note}>OneBot 上报需要开启签名；回复通过已验证 QQ 账号的 OneBot HTTP API 发送。</p>
          </>}
        </fieldset>
      </details>
      <details className={styles.qqGroup}>
        <summary>私聊与群聊</summary>
        <fieldset disabled={disabled}>
          <div className={styles.fieldPair}>{check('privateEnabled', '私聊回复')}{check('groupEnabled', '群聊回复')}</div>
          <div className={styles.fieldPair}>
            <label className={styles.field}>群聊触发<select value={draft.groupTrigger} onChange={event => change('groupTrigger', event.currentTarget.value as QqDraft['groupTrigger'])}>
              <option value="mention">@ 机器人</option><option value="prefix">消息前缀</option><option value="all">所有消息</option></select></label>
            <label className={styles.field}>群聊上下文<select value={draft.groupContext} onChange={event => change('groupContext', event.currentTarget.value as QqDraft['groupContext'])}>
              <option value="shared">同群共享</option><option value="per-user">按成员独立</option></select></label>
          </div>
          {draft.groupTrigger === 'prefix' && <label className={styles.field}>触发前缀<input maxLength={24} required value={draft.prefix} onChange={event => change('prefix', event.currentTarget.value)} /></label>}
          {draft.groupTrigger === 'all' && <p className={styles.note}>会回复允许群组的每条有效文本，可能增加模型用量。</p>}
          <div className={styles.fieldPair}>{(['userMode', 'groupMode'] as const).map(key => <label key={key} className={styles.field}>{key === 'userMode' ? '用户准入' : '群聊准入'}
            <select value={draft[key]} onChange={event => change(key, event.currentTarget.value as QqDraft[typeof key])}><option value="allowlist">仅白名单</option><option value="all">除黑名单外允许</option></select>
          </label>)}</div>
          <div className={styles.fieldPair}>{listField('userAllow')}{listField('userDeny')}</div>
          <div className={styles.fieldPair}>{listField('groupAllow')}{listField('groupDeny')}</div>
          <p className={styles.note}>黑名单优先。若选择仅白名单但列表为空，则无人或无群能触发。</p>
          {numberField('cooldownMs', 0, 60000)}<p className={styles.note}>冷却时间单位为毫秒。</p>
        </fieldset>
      </details>
      <details className={styles.qqGroup}>
        <summary>模型、上下文与缓存</summary>
        <fieldset disabled={disabled}>
          <label className={styles.field}>QQ 模型<select value={modelKey(draft.model)} onChange={event => {
            const key = event.currentTarget.value;
            const option = state.models.find(candidate => modelKey(candidate) === key);
            const model = option ? { provider: option.provider, id: option.id } : null;
            setForm(previous => previous && ({ ...previous, values: { ...previous.values, model, thinking: thinkingFor(modelLevels(option), previous.values.thinking) } }));
            setResult(undefined);
          }}>
            <option value="">跟随当前 Pi 模型</option>
            {draft.model && !selected && <option value={modelKey(draft.model)}>当前配置不可用：{draft.model.id}</option>}
            {state.models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.provider} / {model.name}</option>)}
          </select></label>
          <ThinkingSlider levels={modelLevels(selected)} value={draft.thinking} onChange={value => change('thinking', value)} />
          <label className={styles.field}>QQ 附加系统提示词<textarea rows={4} maxLength={4000} value={draft.systemPrompt} onChange={event => change('systemPrompt', event.currentTarget.value)} /></label>
          <div className={styles.fieldPair}>{numberField('contextLimit', 4096, 262144)}{numberField('maxOutputTokens', 128, 16384)}</div>
          {check('compact', '超过阈值自动压缩', '摘要旧消息并保留近期完整往返；关闭时仍会限制发送给模型的历史。')}
          <div className={styles.fieldPair}>{numberField('compactThreshold', 512, 261632)}{numberField('keepRecentTokens', 128, 131072)}</div>
          <p className={styles.note}>容量与阈值按 token 估算；预算会为输出和模型窗口留余量。</p>
          <label className={styles.field}>缓存保留<select value={draft.cacheRetention} onChange={event => change('cacheRetention', event.currentTarget.value as QqDraft['cacheRetention'])}>
            <option value="none">不请求缓存保留</option><option value="short">短期（默认）</option><option value="long">长期（取决于服务商）</option>
          </select></label>
        </fieldset>
      </details>
      <details className={styles.qqGroup}>
        <summary>工具权限与表情</summary>
        <fieldset disabled={disabled}>
          {check('stickers', '允许表情工具', 'Agent 可把收到的表情保存到当前对话、写备注，并按序号发送；不会跨聊共享。')}
          {listField('toolUsers')}
          <p className={styles.note}>仅名单内当前发言人可触发下列额外工具；Pi 的 Bash、MCP 和文件工具不会暴露给 QQ。</p>
          {Object.entries(extras).map(([id, label]) => <label key={id} className={styles.checkRow}>
            <input type="checkbox" checked={draft.extraTools.includes(id as ExtraTool)} onChange={event => change('extraTools', event.currentTarget.checked ? [...draft.extraTools, id as ExtraTool] : draft.extraTools.filter(tool => tool !== id))} /><span>{label}</span>
          </label>)}
        </fieldset>
      </details>
      <div className={styles.inlineActions}>
        <button type="submit" className={styles.primary} disabled={disabled || !dirty}>{operation === 'save' ? '正在保存…' : '保存 QQ 设置'}</button>
        {dirty && <button type="button" className={styles.secondary} disabled={!!operation} onClick={() => { setForm(editForm(settings)); setResult(undefined); }}>撤销未保存更改</button>}
      </div>
    </form>
    <details className={styles.qqGroup}>
      <summary>用量与对话 <span>{view.conversations.length}</span></summary>
      <div className={styles.qqActivity}>
        <dl className={styles.qqMetrics}>{([['请求', usage.requests], ['输入', usage.input], ['缓存命中', usage.hit], ['未报告', usage.unreported], ['压缩输入', usage.compactionInput]] as const)
          .map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{fmt.format(count ?? 0)}</dd></div>)}</dl>
        {view.pending > 0 && <p className={styles.note}>{view.pending} 条等待或正在生成。</p>}
        {view.conversations.length === 0 ? <p className={styles.note}>目前没有 QQ 对话。</p> : <ul className={styles.resourceList}>
          {view.conversations.map(conversation => <li key={conversation.id}>
            <div><strong>{conversation.label}</strong><small>{conversation.busy ? '生成中 · ' : ''}{conversation.messages} 条近期消息 · 压缩 {conversation.compactions} 次</small></div>
            {confirmReset === conversation.id ? <div className={styles.inlineActions}>
              <button type="button" className={styles.secondary} disabled={!!operation} onClick={() => setConfirmReset(undefined)}>取消</button>
              <button type="button" className={styles.primary} disabled={disabled || conversation.busy} onClick={() => void operate('reset', async signal => ({ response: await piApi.qqReset(conversation.id, signal), message: '对话上下文已清除。' }))}>确认清除</button>
            </div> : <button type="button" className={styles.secondary} title="仅清除聊天上下文和缓存，不删除已保存的表情" disabled={disabled || conversation.busy}
              onClick={() => setConfirmReset(conversation.id)}>清除上下文</button>}
          </li>)}
        </ul>}
      </div>
    </details>
  </section>;
}
