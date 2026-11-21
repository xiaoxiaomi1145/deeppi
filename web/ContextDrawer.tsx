import { useState } from 'react';
import type { FormEvent } from 'react';
import { errorText } from './api';
import { cacheHitRate } from './client-logic';
import { Overlay, Panel } from './Overlay';
import type { ChildView, Session, Usage } from './types';
import { Button } from './upstream/Button';
import styles from './Client.module.css';

const number = new Intl.NumberFormat('zh-CN');
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const childStatus: Record<ChildView['status'], string> = { queued: '排队中', running: '运行中', done: '已完成', error: '失败', cancelled: '已取消' };

function Metric({ label, value }: { label: string; value: number | string }) {
  return <div><dt>{label}</dt><dd>{typeof value === 'number' ? number.format(value) : value}</dd></div>;
}

function UsageMetrics({ usage }: { usage: Usage }) {
  const hitRate = cacheHitRate(usage);
  return <dl className={styles.metrics}>
    <Metric label="输入 tokens" value={usage.input} />
    <Metric label="输出 tokens" value={usage.output} />
    <Metric label="缓存命中" value={usage.hit} />
    <Metric label="缓存未命中" value={usage.miss} />
    <Metric label="缓存未报告" value={usage.unreported} />
    <Metric label="缓存命中率" value={hitRate === undefined ? '未知' : percent.format(hitRate)} />
  </dl>;
}

export function ContextDrawer({ session, blocked, onClose, onCompact, onRemove }: {
  session: Session;
  blocked: boolean;
  onClose: () => void;
  onCompact: (focus: string) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
}) {
  const [focus, setFocus] = useState('');
  const [error, setError] = useState('');
  const [remove, setRemove] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const locked = pending || blocked || session.status !== 'idle';

  async function act(action: () => Promise<void>) {
    if (locked) return;
    setError('');
    setPending(true);
    try { await action(); } catch (cause) { setError(errorText(cause)); } finally { setPending(false); }
  }

  function compact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async () => { await onCompact(focus.trim()); setFocus(''); });
  }

  return (
    <Overlay side="right" title="上下文" onClose={onClose}>
      <Panel title="上下文" onClose={onClose}>
        {error && <p className={styles.inlineError} role="alert">{error}</p>}
        <section className={styles.contextSection}>
          <h3>上下文用量</h3>
          <dl className={styles.metrics}>
            <Metric label="预计 tokens" value={session.context.estimatedTokens} />
            <Metric label="窗口上限" value={session.settings.contextWindow} />
            <Metric label="摘要已覆盖消息" value={session.context.coveredMessages} />
          </dl>
          <progress value={session.context.estimatedTokens} max={session.settings.contextWindow} aria-label="上下文用量" />
          <form className={styles.compactForm} onSubmit={compact}>
            <label className={styles.field}><span>优先保留（可选）</span>
              <input value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="例如：保留待办任务和路径" maxLength={2000} />
            </label>
            <Button variant="outlined" size="m" type="submit" disabled={locked}>{session.status === 'compacting' ? '正在压缩…' : '压缩上下文'}</Button>
          </form>
        </section>
        <section className={styles.contextSection}>
          <h3>模型缓存</h3>
          <dl className={styles.metrics}>
            <Metric label="请求数" value={session.cache.requests} />
            <Metric label="压缩输入 tokens" value={session.cache.compactionInput} />
          </dl>
          <UsageMetrics usage={session.cache} />
          {session.cache.last && <details className={styles.trace}>
            <summary>最近一次请求</summary><div className={styles.traceBody}><UsageMetrics usage={session.cache.last} /></div>
          </details>}
        </section>
        <section className={styles.contextSection}>
          <h3>压缩记录 <span>{session.compactions.length}</span></h3>
          {session.compactions.length === 0 && <p className={styles.helper}>暂无压缩记录</p>}
          {[...session.compactions].reverse().map((entry) => (
            <details className={styles.trace} key={entry.id}>
              <summary><time dateTime={new Date(entry.at).toISOString()}>{date.format(entry.at)}</time>
                <span className={styles.traceState}>{number.format(entry.beforeTokens)} → {number.format(entry.afterTokens)} tokens</span>
              </summary>
              <div className={styles.traceBody}><p>覆盖 {number.format(entry.summarizedMessages)} 条消息</p><pre>{entry.summary}</pre></div>
            </details>
          ))}
        </section>
        <section className={styles.contextSection}>
          <h3>子代理 <span>{session.agents.length}</span></h3>
          {session.agents.length === 0 && <p className={styles.helper}>暂无子代理</p>}
          {session.agents.map((agent) => (
            <details className={styles.trace} key={agent.id}>
              <summary><span>{agent.name}</span><span className={styles.traceState}>{childStatus[agent.status]}</span></summary>
              <div className={styles.traceBody}>
                <time dateTime={new Date(agent.updatedAt).toISOString()}>{date.format(agent.updatedAt)}</time>
                <div>任务</div><pre>{agent.task}</pre>
                {agent.result && <><div>结果</div><pre>{agent.result}</pre></>}
              </div>
            </details>
          ))}
        </section>
        <section className={styles.contextSection}>
          <h3>已注册工具 <span>{session.tools.length}</span></h3>
          {session.tools.length === 0 && <p className={styles.helper}>暂无已注册工具</p>}
          {session.tools.map((tool) => (
            <details className={styles.trace} key={tool.name}>
              <summary>{tool.name}</summary>
              <div className={styles.traceBody}>
                <p>{tool.description}</p>
                {tool.parameters.length > 0 && <ul>{tool.parameters.map((parameter) => <li key={parameter.name}>
                  <code>{parameter.name}</code>{parameter.required && '（必填）'}{parameter.description && ` · ${parameter.description}`}
                </li>)}</ul>}
                {tool.script && <><div>脚本</div><pre>{tool.script}</pre></>}
                <div className={styles.formActions}>
                  {remove === tool.name ? <>
                    <Button variant="outlined" size="s" onClick={() => setRemove(null)}>取消</Button>
                    <Button variant="danger" size="s" disabled={locked} onClick={() => void act(async () => {
                      await onRemove(tool.name);
                      setRemove(null);
                    })}>确认移除</Button>
                  </> : <Button variant="dangerOutlined" size="s" disabled={locked} onClick={() => setRemove(tool.name)}>移除工具</Button>}
                </div>
              </div>
            </details>
          ))}
        </section>
      </Panel>
    </Overlay>
  );
}
