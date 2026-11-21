import { useState } from 'react';
import { errorText } from '../api';
import { Overlay, Panel } from '../Overlay';
import { compactPayload, type ContextPolicy, type PiState } from './model';
import { piApi } from './transport';
import styles from './Pi.module.css';

const number = new Intl.NumberFormat('zh-CN');
const defaultPolicy: ContextPolicy = { threshold: null, focus: '' };

export function ContextPanel({ state, writable, onClose }: { state: PiState; writable: boolean; onClose: () => void }) {
  const applied = state.context.policy ?? defaultPolicy;
  const [rule, setRule] = useState<ContextPolicy>(applied);
  const [focus, setFocus] = useState('');
  const [enhanced, setEnhanced] = useState(false);
  const [pending, setPending] = useState<'save' | 'compact' | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const { tokens, window: limit, native, thresholdTokens } = state.context;
  const canEdit = writable && !pending;
  const canCompact = canEdit && !!state.model;
  const changed = rule.threshold !== applied.threshold || rule.focus.trim() !== applied.focus;
  const valid = rule.threshold === null || (Number.isInteger(rule.threshold) && rule.threshold >= 30 && rule.threshold <= 95);

  async function save() {
    if (!canEdit || !changed || !valid) return;
    setPending('save');
    setMessage(null);
    try {
      await piApi.settings({ context: rule });
      setMessage({ error: false, text: '已保存此 Pi 会话的上下文规则。' });
    } catch (cause) { setMessage({ error: true, text: errorText(cause) }); }
    finally { setPending(null); }
  }
  async function compact() {
    if (!canCompact) return;
    setPending('compact');
    setMessage(null);
    try {
      await piApi.compact(compactPayload(focus, enhanced, !!state.addons?.compact));
      onClose();
    } catch (cause) { setMessage({ error: true, text: errorText(cause) }); }
    finally { setPending(null); }
  }
  function update(patch: Partial<ContextPolicy>) { setRule(previous => ({ ...previous, ...patch })); setMessage(null); }

  return <Overlay title="上下文" side="right" onClose={onClose}>
    <Panel title="上下文" onClose={onClose} footer={<>
      <button type="button" className={styles.secondary} onClick={onClose}>关闭</button>
      <button type="button" className={styles.primary} onClick={() => void compact()} disabled={!canCompact}>{pending === 'compact' ? '正在启动…' : '立即压缩'}</button>
    </>}>
      <div className={styles.settingsStack}>
        <section className={styles.settingsSection} aria-label="上下文用量">
          <h3>当前用量</h3>
          <p className={styles.contextMetrics}><strong>{tokens !== null ? number.format(tokens) : '—'}</strong><span>/ {limit !== null ? number.format(limit) : '—'} token</span></p>
          {tokens !== null && limit !== null && limit > 0 && <progress aria-label="上下文用量" value={Math.max(0, Math.min(tokens, limit))} max={limit} />}
          <p className={styles.note}>{tokens === null ? 'Pi 尚未报告 token 用量。' : '上下文统计来自 Pi。'}</p>
          {native && <p className={styles.note}>Pi 原生自动压缩：{native.enabled ? '开启' : '关闭'} · 预留 {number.format(native.reserveTokens)} · 保留最近 {number.format(native.keepRecentTokens)} token。网页额外规则不会改动这组原生设置。</p>}
        </section>
        <section className={styles.settingsSection} aria-label="自动压缩设置">
          <h3>会话自动压缩</h3>
          <p className={styles.note}>只作用于此 Pi 会话。达到阈值时，等到本轮结束且没有排队消息，再用 Pi 执行压缩。</p>
          <label className={styles.checkRow}><input type="checkbox" checked={rule.threshold !== null} disabled={!canEdit}
            onChange={event => update({ threshold: event.target.checked ? applied.threshold ?? 80 : null })} />启用额外阈值</label>
          {rule.threshold !== null && <label className={styles.field}>自动压缩阈值 (%)<input type="number" min={30} max={95} step={1} value={Number.isNaN(rule.threshold) ? '' : rule.threshold}
            disabled={!canEdit} onChange={event => update({ threshold: event.target.valueAsNumber })} /></label>}
          {thresholdTokens != null && <p className={styles.note}>当前已保存阈值约为 {number.format(thresholdTokens)} token。</p>}
          <label className={styles.field}>默认保留重点<textarea rows={3} maxLength={2000} value={rule.focus} disabled={!canEdit}
            placeholder="例如：保留接口决策、未完成事项与测试结果" onChange={event => update({ focus: event.target.value })} /></label>
          <button className={styles.secondary} type="button" disabled={!canEdit || !changed || !valid} onClick={() => void save()}>{pending === 'save' ? '保存中…' : '保存上下文设置'}</button>
        </section>
        <section className={styles.settingsSection}>
          <h3>手动压缩</h3><p className={styles.note}>压缩模型收到的历史，不删除网页上的聊天记录。</p>
          <label className={styles.field}>本次保留重点（可选）<textarea rows={3} maxLength={2000} value={focus} disabled={!canCompact}
            onChange={event => setFocus(event.target.value)} placeholder="留空使用已保存的默认重点" /></label>
          {state.addons?.compact && <label className={styles.checkRow}><input type="checkbox" checked={enhanced} onChange={event => setEnhanced(event.target.checked)} disabled={!canCompact} />使用 Deeppi 增强压缩（仅本次）</label>}
          {!canCompact && !pending && <p className={styles.note}>Pi 空闲且选定模型后可手动压缩。</p>}
        </section>
        {message && <p className={message.error ? styles.error : styles.notice} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      </div>
    </Panel>
  </Overlay>;
}
