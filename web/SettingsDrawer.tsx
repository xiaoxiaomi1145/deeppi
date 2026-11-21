import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { errorText } from './api';
import { settingsPatch } from './client-logic';
import { Overlay, Panel } from './Overlay';
import type { Theme } from './theme';
import type { DefaultsPatch, Info, ModelConnection, ProbeInput, Provider, Settings, Thinking } from './types';
import { Button } from './upstream/Button';
import { DirectoryBrowser } from './WorkspaceDrawer';
import styles from './Client.module.css';

export const providerLabels: Record<Provider, string> = {
  deepseek: 'DeepSeek',
  'openai-compatible': 'OpenAI 兼容',
  anthropic: 'Anthropic',
  google: '谷歌 Gemini',
  mistral: 'Mistral 原生',
  azure: 'Azure OpenAI',
  demo: '离线演示',
};
const providerDescriptions: Record<Provider, string> = {
  deepseek: 'DeepSeek 官方 API。',
  'openai-compatible': 'OpenAI 官方 API 或 Chat Completions 兼容网关。',
  anthropic: 'Anthropic Messages API。',
  google: 'Google Gemini Developer API（不含 Vertex AI）。',
  mistral: 'Mistral Chat Completions API。',
  azure: 'Azure OpenAI Responses API，需使用 Azure 中的部署名称。',
  demo: '本机离线演示，不会访问网络。',
};
const initialModel: Record<Provider, string> = {
  deepseek: 'deepseek-flash',
  'openai-compatible': 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.5-flash',
  mistral: 'mistral-large-latest',
  azure: 'gpt-4.1-mini',
  demo: 'deeppi-demo',
};
const baseUrlPlaceholders: Record<Exclude<Provider, 'demo'>, string> = {
  deepseek: 'https://api.deepseek.com',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai',
  azure: 'https://your-resource.openai.azure.com/openai/v1',
};
const thinkingLabels: Record<Thinking, string> = { off: '关闭', low: '低', medium: '中', high: '高', max: '最高' };
const themeLabels: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
const bounds = {
  contextWindow: [4096, 2_000_000], maxOutputTokens: [256, 200_000], maxTurns: [1, 64], keepRecentTokens: [256, 500_000],
  bashTimeoutMs: [100, 900_000], maxToolOutput: [256, 100_000], maxSubagents: [0, 8],
} as const;
type LimitName = keyof typeof bounds;
export type SettingsScope = 'global' | 'session' | 'draft';

function Field({ label, children, note, wide = false }: { label: string; children: ReactNode; note?: string; wide?: boolean }) {
  return <label className={wide ? `${styles.field} ${styles.fieldWide}` : styles.field}>
    <span>{label}</span>{children}{note && <small>{note}</small>}
  </label>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <fieldset className={styles.formSection}><legend>{title}</legend><div className={styles.fields}>{children}</div></fieldset>;
}

function Limit({ name, label, settings }: { name: LimitName; label: string; settings: Settings }) {
  const [min, max] = bounds[name];
  return <Field label={label}><input type="number" inputMode="numeric" name={name} defaultValue={settings[name]} required min={min} max={max} /></Field>;
}

function catalogFor(info: Info, provider: Provider) {
  return provider === 'demo' ? [] : info.models?.[provider] ?? [];
}

export function SettingsDrawer({ info, settings, scope, connection, hasKeyOverride, theme, onTheme, onClose, onSave, onProbe, editable }: {
  info: Info;
  settings: Settings;
  scope: SettingsScope;
  connection: ModelConnection;
  hasKeyOverride: boolean;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
  onSave: (body: DefaultsPatch) => Promise<void>;
  onProbe: (body: ProbeInput, signal: AbortSignal) => Promise<{ model: string }>;
  editable: boolean;
}) {
  const global = scope === 'global';
  const title = global ? '应用设置' : scope === 'draft' ? '新会话设置' : '会话设置';
  const [provider, setProvider] = useState(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [customModel, setCustomModel] = useState(false);
  const [cwd, setCwd] = useState(settings.cwd);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [remember, setRemember] = useState<boolean>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<{ status: 'running' | 'ok' | 'error'; text: string }>();
  const probeController = useRef<AbortController>();
  const catalog = catalogFor(info, provider);
  const modelInfo = catalog.find(item => item.id === model);
  const showCustomModel = customModel || !modelInfo;
  const isAzure = provider === 'azure';
  const modelFieldLabel = isAzure ? '部署名称' : '模型 ID';
  const originalRoute = provider === settings.provider && baseUrl.trim() === settings.baseUrl;
  const canEdit = editable && !saving;
  useEffect(() => () => probeController.current?.abort(), []);

  function invalidateProbe() {
    probeController.current?.abort();
    setProbe(undefined);
  }

  function chooseProvider(next: Provider) {
    const options = catalogFor(info, next);
    const preferred = options.find(item => item.id === initialModel[next]) ?? options[0];
    setProvider(next);
    setModel(preferred?.id ?? initialModel[next]);
    setCustomModel(false);
    setBaseUrl('');
    setClearKey(false);
    setRemember(undefined);
    invalidateProbe();
  }

  function credentials(data: FormData): Pick<DefaultsPatch, 'apiKey'> {
    if (provider === 'demo') return {};
    const value = String(data.get('apiKey') ?? '').trim();
    return clearKey && originalRoute ? { apiKey: null } : value ? { apiKey: value } : {};
  }

  async function test(form: HTMLFormElement | null) {
    if (!form || saving || probe?.status === 'running') return;
    if (!model.trim()) { setProbe({ status: 'error', text: `请先填写${modelFieldLabel}。` }); return; }
    const controller = new AbortController();
    probeController.current?.abort();
    probeController.current = controller;
    setProbe({ status: 'running', text: '正在通过 Pi 测试…' });
    try {
      const checked = await onProbe({ settings: { provider, model: model.trim(), baseUrl: baseUrl.trim() }, ...credentials(new FormData(form)) }, controller.signal);
      if (!controller.signal.aborted) setProbe({ status: 'ok', text: `${checked.model} 连接成功` });
    } catch (cause) {
      if (!controller.signal.aborted) setProbe({ status: 'error', text: errorText(cause) });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    const data = new FormData(event.currentTarget);
    const text = (field: string) => String(data.get(field) ?? '');
    const limits = Object.fromEntries(Object.keys(bounds).map(name => [name, Number(text(name))])) as Pick<Settings, LimitName>;
    const next: Settings = {
      ...settings, ...limits, provider, model: model.trim(), baseUrl: baseUrl.trim(), cwd: global ? settings.cwd : cwd,
      systemPrompt: text('systemPrompt'), thinkingLevel: text('thinkingLevel') as Thinking,
      temperature: text('temperature') === '' ? null : Number(text('temperature')), autoCompact: data.has('autoCompact'),
      allowBash: !global && info.bashAvailable && data.has('allowBash'), subagentModel: text('subagentModel').trim(),
    };
    if (!next.model || next.maxOutputTokens + 1024 > next.contextWindow) {
      setError(!next.model ? `请填写${modelFieldLabel}。` : '上下文窗口至少应比输出上限多 1024 tokens。');
      return;
    }
    setError('');
    setSaving(true);
    const key = credentials(data).apiKey;
    try {
      await onSave({ ...settingsPatch(settings, next, key ?? '', key === null),
        ...(global && provider !== 'demo' && remember !== undefined ? { rememberKey: remember } : {}) });
      onClose();
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }

  return <Overlay side="right" title={title} onClose={onClose}>
    <Panel title={title} onClose={onClose} onSubmit={submit} footer={<>
      {error && <p className={styles.inlineError} role="alert">{error}</p>}
      <div className={styles.formActions}>
        <Button variant="outlined" onClick={onClose}>{editable ? '取消' : '关闭'}</Button>
        <Button type="submit" disabled={!canEdit}>{saving ? '保存中…' : '保存设置'}</Button>
      </div>
    </>}>
      <p className={styles.panelLead}>{global ? '连接与生成参数作为新会话的默认值，不会改写已有会话。' : scope === 'draft' ? '只对即将发送的会话生效；发送前不会创建记录。' : '只修改本会话；其他会话和应用默认值不变。'}</p>
      {!editable && <p className={styles.helper}>等当前操作完成后，即可修改设置。</p>}
      <Section title="模型与连接">
        <Field label="服务商" note={providerDescriptions[provider]}>
          <select value={provider} onChange={event => chooseProvider(event.target.value as Provider)}>
            {(Object.entries(providerLabels) as [Provider, string][]).filter(([value]) => value !== 'demo' || info.demo)
              .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        {catalog.length > 0 && <Field label="模型" note={modelInfo && !customModel ? `Pi 目录：${modelInfo.contextWindow.toLocaleString()} tokens 上下文` : undefined}>
          <select value={showCustomModel ? '' : model} onChange={event => {
            setCustomModel(!event.target.value);
            setModel(event.target.value);
            invalidateProbe();
          }}>
            {catalog.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value="">{isAzure ? '输入部署名称…' : '输入自定义模型 ID…'}</option>
          </select>
        </Field>}
        {provider !== 'demo' && showCustomModel && <Field label={modelFieldLabel} wide>
          <input value={model} required maxLength={256} spellCheck={false} placeholder={isAzure ? '输入 Azure 中的实际部署名称' : initialModel[provider]}
            onChange={event => { setCustomModel(true); setModel(event.target.value); invalidateProbe(); }} />
        </Field>}
        {provider !== 'demo' && <>
          <Field label="接口地址（Base URL）" wide note={isAzure
            ? '填写 Azure 资源的 API 根地址。已在服务端配置端点时可留空。'
            : '留空使用默认地址。自定义网关请填 API 根地址。'}>
            <input type="url" inputMode="url" spellCheck={false} value={baseUrl} maxLength={2048} placeholder={baseUrlPlaceholders[provider]}
              onChange={event => {
                setBaseUrl(event.target.value); setClearKey(false); setRemember(undefined); invalidateProbe();
              }} />
          </Field>
          <Field label="API 密钥" wide note={originalRoute && connection === 'configured' ? '留空保留当前连接配置。' : '如果已设服务端环境变量，或本机接口无需密钥，可留空。'}>
            <input key={provider} name="apiKey" type="password" autoComplete="off" maxLength={4096} disabled={clearKey} placeholder="输入新密钥" onChange={invalidateProbe} />
          </Field>
          {global && <label className={`${styles.check} ${styles.fieldWide}`}>
            <input type="checkbox" checked={remember ?? (originalRoute && info.rememberedKey)} disabled={clearKey}
              onChange={event => setRemember(event.target.checked)} /> 记住手动输入的密钥（保存在本机私有配置）
          </label>}
          {originalRoute && hasKeyOverride && <label className={`${styles.check} ${styles.fieldWide}`}>
            <input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); invalidateProbe(); }} />
            {global ? '清除手动密钥（不改环境变量）' : '清除本会话密钥，改用默认连接'}
          </label>}
          <div className={`${styles.fieldWide} ${styles.probeRow}`}>
            <Button variant="outlined" size="m" disabled={probe?.status === 'running' || saving}
              onClick={event => void test(event.currentTarget.form)}>{probe?.status === 'running' ? '测试中…' : '测试连接'}</Button>
            {probe && <span role={probe.status === 'error' ? 'alert' : 'status'} data-probe={probe.status}>{probe.text}</span>}
          </div>
        </>}
      </Section>
      <Section title="对话">
        <Field label="系统提示词" wide>
          <textarea name="systemPrompt" defaultValue={settings.systemPrompt} maxLength={32_000} rows={4} placeholder="可指定回答风格或会话约束" />
        </Field>
        <Field label="思考强度">
          <select defaultValue={settings.thinkingLevel} name="thinkingLevel">
            {(Object.entries(thinkingLabels) as [Thinking, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
      </Section>
      {!global && <Section title="工作目录与工具">
        <Field label="工作目录" wide note={cwd}>
          <select value={cwd} onChange={event => { setCwd(event.target.value); setBrowserOpen(false); }}>
            {!info.workspaces.some(entry => entry.path === cwd) && <option value={cwd}>当前会话目录</option>}
            {info.workspaces.map(entry => <option key={entry.path} value={entry.path}>{entry.name}</option>)}
          </select>
        </Field>
        <div className={styles.fieldWide}>
          <Button variant="outlined" size="m" aria-expanded={browserOpen} onClick={() => setBrowserOpen(open => !open)}>{browserOpen ? '收起目录浏览' : '浏览文件夹'}</Button>
          {browserOpen && <DirectoryBrowser initialPath={cwd} pickLabel="使用此目录" onPick={path => { setCwd(path); setBrowserOpen(false); }} />}
        </div>
        <label className={`${styles.check} ${styles.fieldWide}`}>
          <input type="checkbox" name="allowBash" defaultChecked={settings.allowBash} disabled={!info.bashAvailable} />允许本会话执行 Bash
        </label>
        <small className={`${styles.fieldWide} ${styles.helper}`}>{info.bashAvailable ? '命令以服务进程权限运行，不是沙箱。' : '需以 --allow-bash 启动服务。'}</small>
      </Section>}
      <details className={styles.advancedSettings} onInvalidCapture={event => { event.currentTarget.open = true; }}>
        <summary>高级设置 · 生成、上下文和工具</summary>
        <div className={styles.fields}>
          <Field label="采样温度" note="留空使用模型默认值"><input type="number" min={0} max={2} step="any" name="temperature" defaultValue={settings.temperature ?? ''} /></Field>
          <Limit name="maxOutputTokens" label="最大输出 tokens" settings={settings} />
          <Limit name="maxTurns" label="单条消息运行轮次" settings={settings} />
          <Limit name="maxSubagents" label="并发子代理上限" settings={settings} />
          <Limit name="contextWindow" label="上下文窗口（tokens）" settings={settings} />
          <Limit name="keepRecentTokens" label="压缩后保留 tokens" settings={settings} />
          <Limit name="bashTimeoutMs" label="Bash 超时（毫秒）" settings={settings} />
          <Limit name="maxToolOutput" label="工具输出上限" settings={settings} />
          <Field label="子代理模型 ID" wide note="留空跟随当前模型"><input name="subagentModel" defaultValue={settings.subagentModel} maxLength={256} spellCheck={false} /></Field>
          <label className={`${styles.check} ${styles.fieldWide}`}><input type="checkbox" name="autoCompact" defaultChecked={settings.autoCompact} />自动压缩上下文</label>
        </div>
      </details>
      {global && <div className={styles.preferences}>
        <Field label="主题" wide><select value={theme} onChange={event => onTheme(event.target.value as Theme)}>
          {(Object.entries(themeLabels) as [Theme, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></Field>
      </div>}
    </Panel>
  </Overlay>;
}
