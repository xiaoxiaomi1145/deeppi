import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorText } from '../api';
import { Overlay, Panel } from '../Overlay';
import type { Theme } from '../theme';
import { modelKey, settingsDraft, settingsPatch, thinkingFor, type AddonId, type PiModelOption, type PiState } from './model';
import { piApi } from './transport';
import { Resources } from './Resources';
import { ThinkingSlider } from './ThinkingSlider';
import { QqSettings } from './QqSettings';
import { WebModels } from './WebModels';
import styles from './Pi.module.css';

const sections = { model: '模型', conversation: '会话', tools: '工具', resources: '资源', qq: 'QQ', appearance: '外观' } as const;
export type SettingsSection = keyof typeof sections;
const number = new Intl.NumberFormat('zh-CN');

function Addons({ state, writable }: { state: PiState; writable: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState<AddonId | null>(null);
  const [error, setError] = useState('');
  const enabled = state.addons ?? { compact: false, bash: false };
  async function update(id: AddonId, on: boolean) {
    if (!writable || pending || (id === 'bash' && on && !confirm)) return;
    setPending(id);
    setError('');
    try {
      await piApi.addons(id, on);
      setConfirm(false);
    } catch (cause) { setError(errorText(cause)); }
    finally { setPending(null); }
  }
  return <section className={styles.settingsSection} aria-label="Deeppi 附加能力">
    <div className={styles.sectionHeading}><h3>Deeppi 附加能力</h3></div>
    <p className={styles.note}>独立于 Pi 原生能力，默认关闭。关闭不会停用 Pi 自带工具或原生压缩。</p>
    <label className={styles.checkRow}><input type="checkbox" checked={enabled.compact} onChange={() => void update('compact', !enabled.compact)} disabled={!writable || !!pending} />
      <span><strong>增强压缩</strong><small>启用后可在压缩面板手动选择，默认仍用 Pi 原生压缩。</small></span></label>
    <div className={styles.sectionHeading}>
      <div><strong>Bash 自定义工具</strong><p className={styles.note}>{enabled.bash ? '已启用。' : '未启用。'}允许模型定义和使用 Bash 工具。</p></div>
      <button type="button" className={styles.secondary} disabled={!writable || !!pending || confirm}
        onClick={() => enabled.bash ? void update('bash', false) : setConfirm(true)}>{pending === 'bash' ? '正在更新…' : enabled.bash ? '关闭 Bash' : '启用 Bash…'}</button>
    </div>
    {confirm && <div className={styles.confirmBox}>
      <p>自定义 Bash 工具会以当前 Pi 用户权限运行，不在沙箱中。请仅在信任当前会话和工具时启用。</p>
      <div className={styles.inlineActions}><button type="button" className={styles.secondary} disabled={!!pending} onClick={() => setConfirm(false)}>取消</button>
        <button type="button" className={styles.primary} disabled={!writable || !!pending} onClick={() => void update('bash', true)}>确认启用</button></div>
    </div>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}

export function PiSettings({ state, section: first, writable, connected, theme, setTheme, onClose }: {
  state: PiState; section: SettingsSection; writable: boolean; connected: boolean; theme: Theme; setTheme: (theme: Theme) => void; onClose: () => void;
}) {
  const [section, selectSection] = useState(first);
  const [initial, setInitial] = useState(() => settingsDraft(state));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; text: string } | null>(null);
  const probe = useRef<AbortController>();
  useEffect(() => () => probe.current?.abort(), []);
  const nextPatch = settingsPatch(initial, draft);
  const changed = Object.keys(nextPatch).length > 0;
  const currentKey = modelKey(state.model);
  const draftKey = modelKey(draft.model);
  const modelChanged = currentKey !== draftKey;
  const currentOption = state.models.find((candidate) => modelKey(candidate) === draftKey);
  const levels = modelChanged ? currentOption?.levels ?? ['off'] : currentOption?.levels ?? state.levels;
  const groups = new Map<string, PiModelOption[]>();
  for (const option of state.models) {
    if (!groups.has(option.provider)) groups.set(option.provider, []);
    groups.get(option.provider)?.push(option);
  }
  const fieldsetDisabled = !writable || saving;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (fieldsetDisabled || !changed) return;
    if ('title' in nextPatch && !nextPatch.title) { setError('会话标题不能为空。'); return; }
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await piApi.settings(nextPatch);
      const normalized = { ...draft, title: nextPatch.title ?? draft.title };
      setInitial(normalized);
      setDraft(normalized);
      setSaved(true);
    } catch (cause) { setError(errorText(cause)); }
    finally { setSaving(false); }
  }
  function mutate(update: Partial<typeof draft>) {
    setDraft((previous) => ({ ...previous, ...update }));
    setError('');
    setSaved(false);
  }
  async function testConnection() {
    if (!writable || !state.model || probing || modelChanged || saving) return;
    const controller = new AbortController();
    probe.current = controller;
    setProbing(true);
    setProbeResult(null);
    try {
      const { model } = await piApi.probe(controller.signal);
      if (!controller.signal.aborted) setProbeResult({ ok: true, text: `${model} 连接成功。` });
    } catch (cause) {
      if (!controller.signal.aborted) setProbeResult({ ok: false, text: errorText(cause) });
    } finally { if (!controller.signal.aborted) setProbing(false); }
  }
  function choice(next: SettingsSection) {
    if (next === section) return;
    setSaved(false);
    selectSection(next);
  }
  // Save is associated with one form, so resource forms never nest.
  const editable = section === 'model' || section === 'conversation' || section === 'tools';
  const footer = editable ? <>
    <span className={styles.footerNote} role="status">{saved ? '已保存到 Pi' : changed ? '有未保存的更改' : ''}</span>
    <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
    <button type="submit" form="pi-live-settings" className={styles.primary} disabled={fieldsetDisabled || !changed}>{saving ? '正在保存…' : '保存更改'}</button>
  </> : null;
  return <Overlay title="Pi 会话设置" side="right" onClose={onClose}>
    <Panel title="Pi 会话设置" onClose={onClose} footer={footer}>
      <nav className={styles.settingsNav} aria-label="设置分类">{Object.entries(sections).map(([id, label]) => <button type="button" key={id}
        data-initial-focus={id === first ? '' : undefined} onClick={() => choice(id as SettingsSection)} aria-pressed={section === id}>{label}</button>)}</nav>
      {!writable && section !== 'appearance' && section !== 'qq' && <p role="status" className={styles.notice}>Pi 空闲且网页已连接时才能修改会话设置。</p>}
      {editable && <form id="pi-live-settings" onSubmit={(event) => void submit(event)} className={styles.settingsStack}>
        <fieldset disabled={fieldsetDisabled} className={styles.settingsSection}>
          {section === 'model' && <>
            <legend>模型与推理</legend>
            <label className={styles.field}>模型<select value={draftKey} onChange={(event) => {
              const model = state.models.find((option) => modelKey(option) === event.target.value);
              if (model) { mutate({ model, thinking: thinkingFor(model.levels ?? ['off'], draft.thinking) }); setProbeResult(null); }
            }}>
              {!draftKey && <option disabled value="">未选模型</option>}
              {draftKey && !currentOption && <option value={draftKey}>{draft.model?.provider} / {draft.model?.id}</option>}
              {[...groups].map(([provider, options]) => <optgroup key={provider} label={provider}>{options.map((option) => <option key={modelKey(option)} value={modelKey(option)}>{option.name === option.id ? option.id : `${option.name} · ${option.id}`}</option>)}</optgroup>)}
            </select></label>
            {currentOption && <p className={styles.note}>{currentOption.contextWindow > 0 && `上下文 ${number.format(currentOption.contextWindow)} · `}最大输出 {number.format(currentOption.maxOutputTokens)} token</p>}
            <ThinkingSlider levels={levels} value={draft.thinking} onChange={thinking => mutate({ thinking })} />
            <div className={styles.sectionHeading}><div><h3>连接测试</h3><p className={styles.note}>{modelChanged ? '先保存模型，再测试。' : '用 Pi 已配置的凭据请求当前模型，不写入对话。'}</p></div>
              <button type="button" className={styles.secondary} disabled={probing || !state.model || modelChanged} onClick={() => void testConnection()}>{probing ? '测试中…' : '测试连接'}</button></div>
            {probeResult && <p className={probeResult.ok ? styles.notice : styles.error} role="status">{probeResult.text}</p>}
            {!state.models.length && <p className={styles.note}>尚无可用模型。可在下方添加自定义模型，或在 Pi 终端登录官方服务商。</p>}
          </>}
          {section === 'conversation' && <>
            <legend>会话信息</legend>
            <label className={styles.field}>标题<input value={draft.title} maxLength={160} onChange={(event) => mutate({ title: event.target.value })} /></label>
            <div className={styles.readOnly}><span>工作区</span><code>{state.cwd}</code><p className={styles.note}>会话目录由 Pi 管理。要在其他目录开始，请在终端打开相应工作区并运行 <code>/deeppi</code>。</p></div>
            <label className={styles.field}>系统提示词<textarea rows={9} spellCheck={false} value={draft.systemPrompt} onChange={(event) => mutate({ systemPrompt: event.target.value })} /></label>
          </>}
          {section === 'tools' && <>
            <legend>可用工具</legend>
            <p className={styles.note}>勾选允许模型在当前 Pi 会话使用的工具。</p>
            {state.tools.length ? <div className={styles.toolChecklist}>{state.tools.map((tool) => <label className={styles.checkRow} key={tool.name}>
              <input type="checkbox" checked={draft.activeTools.includes(tool.name)} onChange={(event) => mutate({ activeTools: event.target.checked ? [...draft.activeTools, tool.name] : draft.activeTools.filter((name) => name !== tool.name) })} />
              <span><strong>{tool.name}</strong><small>{tool.description}</small></span>
            </label>)}</div> : <p className={styles.note}>当前无可配置工具。</p>}
          </>}
        </fieldset>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>}
      {section === 'model' && <WebModels state={state} writable={writable && !saving} />}
      {section === 'tools' && <Addons state={state} writable={writable && !saving} />}
      {section === 'resources' && <Resources state={state} writable={writable && !saving} />}
      {section === 'qq' && <QqSettings state={state} connected={connected} />}
      {section === 'appearance' && <section className={styles.settingsSection} aria-label="浏览器外观">
        <div className={styles.sectionHeading}><h3>浏览器外观</h3></div>
        <label className={styles.field}>主题<select value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
          <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
        </select></label>
        <p className={styles.note}>只更改此浏览器的显示，不改变 Pi 终端的主题。</p>
      </section>}
    </Panel>
  </Overlay>;
}
