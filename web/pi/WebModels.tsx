import { useState } from 'react';
import type { FormEvent } from 'react';
import { errorText } from '../api';
import { modelKey, type ModelProtocol, type PiState, type WebModel, type WebModelAction, type WebModelConfig } from './model';
import { piApi } from './transport';
import styles from './Pi.module.css';

const protocols: Record<ModelProtocol, string> = {
  'openai-completions': 'OpenAI 兼容 · Chat Completions',
  'openai-responses': 'OpenAI · Responses',
  'anthropic-messages': 'Anthropic · Messages',
  'google-generative-ai': 'Gemini Developer · GenerateContent',
  'mistral-conversations': 'Mistral · Chat Completions',
};
const urls: Record<ModelProtocol, string> = {
  'openai-completions': 'https://api.openai.com/v1', 'openai-responses': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com', 'google-generative-ai': 'https://generativelanguage.googleapis.com/v1beta',
  'mistral-conversations': 'https://api.mistral.ai',
};
const defaultConfig: WebModelConfig = { slug: '', protocol: 'openai-completions', modelId: '', name: '', baseUrl: '', contextWindow: 65_536, maxOutputTokens: 8192, reasoning: false };

export function WebModels({ state, writable }: { state: PiState; writable: boolean }) {
  const [editor, setEditor] = useState<WebModelConfig | null>(null);
  const [editing, setEditing] = useState<WebModel | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [use, setUse] = useState(true);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ message: string; error?: true } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  const registry = state.webModels;
  if (!registry) return null;
  const locked = !writable || pending || !!registry.error;

  function open(model: WebModel | null) {
    setEditing(model);
    setEditor(model ? { slug: model.slug, protocol: model.protocol, modelId: model.modelId, name: model.name, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, reasoning: model.reasoning } : defaultConfig);
    setApiKey('');
    setUse(model === null);
    setResult(null);
    setRemove(null);
  }
  function field<K extends keyof WebModelConfig>(key: K, value: WebModelConfig[K]) {
    setEditor(previous => previous && ({ ...previous, [key]: value }));
  }
  function close() { setEditor(null); setEditing(null); setApiKey(''); }
  async function update(action: WebModelAction) {
    if (locked) return;
    setPending(true);
    setResult(null);
    try {
      const response = await piApi.models(action);
      setResult({ message: response.notice ?? (action.action === 'remove' ? '已移除配置。' : '已保存到 Pi 模型目录。') });
      close();
      setRemove(null);
    } catch (cause) { setResult({ error: true, message: errorText(cause) }); }
    finally { setPending(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    void update({ ...editor, name: editor.name.trim() || editor.modelId.trim(), modelId: editor.modelId.trim(), slug: editor.slug.trim(),
      baseUrl: editor.baseUrl.trim() || urls[editor.protocol], action: 'save', editing: !!editing, use, ...(apiKey.trim() && { apiKey: apiKey.trim() }) });
  }
  const retainsKey = !!editing && editor?.protocol === editing.protocol && editor.baseUrl.trim().replace(/\/+$/u, '') === editing.baseUrl;
  return <section className={styles.settingsSection} aria-label="自定义模型">
    <div className={styles.sectionHeading}>
      <div><h3>自定义模型</h3><p className={styles.note}>配置你自己的网关或 API。凭据只保存在此 Pi 的私有数据目录。</p></div>
      {!editor && <button className={styles.secondary} type="button" disabled={locked} onClick={() => open(null)}>添加模型</button>}
    </div>
    {registry.error && <p className={styles.error} role="alert">{registry.error}</p>}
    {registry.models.map(model => {
      const selected = modelKey(state.model) === modelKey(model);
      return <div className={styles.modelEntry} key={model.slug}>
        <div><strong>{model.name}</strong><small>{model.modelId}{selected ? ' · 使用中' : ''}</small></div>
        {remove === model.slug ? <div className={styles.inlineActions}><button type="button" className={styles.secondary} onClick={() => setRemove(null)}>取消</button>
          <button type="button" className={styles.secondary} disabled={locked || selected} onClick={() => void update({ action: 'remove', slug: model.slug })}>确认移除</button></div>
          : <div className={styles.inlineActions}><button type="button" className={styles.secondary} disabled={locked} onClick={() => open(model)}>编辑</button>
            <button type="button" className={styles.secondary} disabled={locked || selected} title={selected ? '先切换当前模型再移除' : undefined} onClick={() => { setRemove(model.slug); close(); }}>移除</button></div>}
      </div>;
    })}
    {editor && <form className={styles.settingsStack} onSubmit={event => void submit(event)}>
      <fieldset className={styles.modelFields} disabled={locked}>
        <legend>{editing ? '编辑模型' : '新增模型'}</legend>
        <label className={styles.field}>协议<select value={editor.protocol} onChange={event => field('protocol', event.target.value as ModelProtocol)}>
          {Object.entries(protocols).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label className={styles.field}>Base URL<input type="url" spellCheck={false} value={editor.baseUrl} placeholder={urls[editor.protocol]} onChange={event => field('baseUrl', event.target.value)} /></label>
        <label className={styles.field}>API Key<input type="password" autoComplete="new-password" spellCheck={false} value={apiKey} required={!retainsKey}
          placeholder={retainsKey ? '留空保留已存密钥' : '输入该端点的密钥'} onChange={event => setApiKey(event.target.value)} /></label>
        <label className={styles.field}>模型 ID<input required maxLength={256} spellCheck={false} value={editor.modelId} placeholder="例如 deepseek-chat 或上游模型 ID" onChange={event => field('modelId', event.target.value)} /></label>
        <div className={styles.settingsPair}>
          <label className={styles.field}>配置标识<input required maxLength={48} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" spellCheck={false} readOnly={!!editing} value={editor.slug} placeholder="personal-gateway" onChange={event => field('slug', event.target.value)} /></label>
          <label className={styles.field}>显示名称<input maxLength={120} value={editor.name} placeholder="留空使用模型 ID" onChange={event => field('name', event.target.value)} /></label>
        </div>
        <div className={styles.settingsPair}>
          <label className={styles.field}>上下文窗口 (token)<input type="number" required min={4096} max={2_000_000} value={editor.contextWindow || ''} onChange={event => field('contextWindow', event.target.valueAsNumber)} /></label>
          <label className={styles.field}>最大输出 (token)<input type="number" required min={128} max={Math.min(editor.contextWindow - 1 || 200_000, 200_000)} value={editor.maxOutputTokens || ''} onChange={event => field('maxOutputTokens', event.target.valueAsNumber)} /></label>
        </div>
        <label className={styles.checkRow}><input type="checkbox" checked={editor.reasoning} onChange={event => field('reasoning', event.target.checked)} />模型支持思考强度</label>
        <label className={styles.checkRow}><input type="checkbox" checked={use} onChange={event => setUse(event.target.checked)} />保存后在当前 Pi 会话中使用</label>
        <div className={styles.inlineActions}><button type="button" className={styles.secondary} disabled={pending} onClick={close}>取消</button>
          <button type="submit" className={styles.primary}>{pending ? '正在保存…' : '保存模型'}</button></div>
      </fieldset>
    </form>}
    {result && <p className={result.error ? styles.error : styles.notice} role={result.error ? 'alert' : 'status'}>{result.message}</p>}
  </section>;
}
