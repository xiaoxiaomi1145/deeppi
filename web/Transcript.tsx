import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { Markdown } from './Chat';
import type { MessageView } from './types';
import {
  buildRounds,
  isNearBottom,
  nextRevealCount,
  preserveScrollAnchor,
  selectRoundWindow,
  summarizeTools,
  type TranscriptBlock,
  type TranscriptRound,
} from './transcript-model';
import {
  createHistoryNavigator,
  type HistoryNavigator,
  type HistorySample,
} from './transcript-gpu';
import styles from './Transcript.module.css';

export interface TranscriptProps {
  messages: readonly MessageView[];
}

function formatToolState(state: MessageView['state']) {
  if (state === 'running') return '执行中';
  if (state === 'error') return '失败';
  return '已完成';
}

function toolSummaryText(tools: readonly MessageView[]) {
  const { total, running, errors } = summarizeTools(tools);
  const parts = [`工具 ${total} 项`];
  if (running) parts.push(`${running} 项执行中`);
  if (errors) parts.push(`${errors} 项失败`);
  return parts.join(' · ');
}

function ToolResult({ message }: { message: MessageView }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={styles.toolResult}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{message.name || '工具调用'}</span>
        <span className={message.state === 'error' ? styles.errorText : styles.toolState}>
          {formatToolState(message.state)}
        </span>
      </summary>
      {open && (
        <div className={styles.toolBody}>
          {message.args && <><div className={styles.detailLabel}>参数</div><pre>{JSON.stringify(message.args, null, 2)}</pre></>}
          {message.text && <><div className={styles.detailLabel}>结果</div><pre>{message.text}</pre></>}
          {!message.args && !message.text && <p>{message.state === 'running' ? '等待工具返回…' : '无输出。'}</p>}
        </div>
      )}
    </details>
  );
}

function ToolGroup({ block, summary }: { block: Extract<TranscriptBlock, { kind: 'tools' }>; summary: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={styles.toolGroup}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{summary}</span>
        <span className={styles.toolHint}>{open ? '收起' : '展开查看'}</span>
      </summary>
      {open && <div className={styles.toolList}>{block.tools.map((tool) => <ToolResult key={tool.id} message={tool} />)}</div>}
    </details>
  );
}

function AssistantBlock({ message }: { message: MessageView }) {
  const hasThinking = Boolean(message.thinking?.trim());
  return (
    <article aria-label="助手回复" className={styles.assistant}>
      {hasThinking && (
        <details className={styles.thinking}>
          <summary>{message.state === 'running' && !message.text ? '思考中' : '思考过程'}</summary>
          <div className={styles.thinkingBody}><Markdown text={message.thinking ?? ''} /></div>
        </details>
      )}
      {message.text ? <Markdown text={message.text} /> : !hasThinking && message.state === 'running' ? (
        <div className={styles.working} role="status"><span className={styles.statusDot} />正在生成…</div>
      ) : null}
    </article>
  );
}

function Round({
  round,
  index,
  register,
}: {
  round: TranscriptRound;
  index: number;
  register: (node: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={register}
      className={styles.round}
      data-round-id={round.id}
      data-round-index={index}
      aria-label={`第 ${index + 1} 轮对话`}
    >
      {round.user && <article className={styles.userRow} aria-label="用户消息"><div className={styles.userBubble}>{round.user.text}</div></article>}
      <div className={styles.roundBody}>
        {round.blocks.map((block, blockIndex) => block.kind === 'tools' ? (
          <ToolGroup key={`tools-${blockIndex}`} block={block} summary={toolSummaryText(block.tools)} />
        ) : (
          <AssistantBlock key={block.message.id} message={block.message} />
        ))}
      </div>
    </section>
  );
}

function HistoryNavigator({
  rounds,
  onSelect,
}: {
  rounds: readonly TranscriptRound[];
  onSelect: (id: string, index: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const navigator = useRef<HistoryNavigator | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const points = useMemo<HistorySample[]>(() => rounds.map((round) => ({
    id: round.id,
    toolCount: round.toolSummary.total,
    hasError: round.toolSummary.errors > 0,
    active: !round.complete,
  })), [rounds]);

  useEffect(() => {
    if (!canvas.current) return undefined;
    const instance = createHistoryNavigator(canvas.current, {
      points,
      onSelect: (id, index) => onSelectRef.current(id, index),
    });
    navigator.current = instance;
    return () => {
      instance.destroy();
      if (navigator.current === instance) navigator.current = null;
    };
  }, []);

  useEffect(() => {
    navigator.current?.update(points);
  }, [points]);

  return (
    <div className={styles.historyNavigator} aria-label="会话历史导航">
      <span className={styles.historyLabel}>历史</span>
      <canvas ref={canvas} className={styles.historyCanvas} width={320} height={28} aria-hidden="true" />
      <span className={styles.historyCount}>{rounds.length} 轮</span>
    </div>
  );
}

export function Transcript({ messages }: TranscriptProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pendingAnchor = useRef<{ height: number; top: number } | null>(null);
  const roundNodes = useRef(new Map<string, HTMLElement>());
  const [revealedEarlier, setRevealedEarlier] = useState(0);
  const [showJump, setShowJump] = useState(false);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const rounds = useMemo(() => buildRounds(messages), [messages]);
  const window = useMemo(() => selectRoundWindow(rounds, { revealedEarlier }), [rounds, revealedEarlier]);
  const selectedIndex = Math.max(0, rounds.findIndex((round) => round.id === selectedRoundId));

  function goToRound(id: string, index: number) {
    setSelectedRoundId(id);
    if (!roundNodes.current.has(id) && window.hiddenCount > 0) {
      setRevealedEarlier((current) => current + window.hiddenCount);
    }
    roundNodes.current.get(id)?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  function moveRound(direction: -1 | 1) {
    if (rounds.length === 0) return;
    const next = Math.min(rounds.length - 1, Math.max(0, selectedIndex + direction));
    goToRound(rounds[next].id, next);
  }

  useEffect(() => {
    if (!selectedRoundId) return;
    roundNodes.current.get(selectedRoundId)?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [selectedRoundId, window.visible.length]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const anchor = pendingAnchor.current;
    if (anchor) {
      element.scrollTop = preserveScrollAnchor(anchor.height, anchor.top, element.scrollHeight);
      pendingAnchor.current = null;
    } else if (follow.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, window.visible.length, window.revealedEarlier]);

  useLayoutEffect(() => {
    const element = scroll.current;
    const content = flow.current;
    if (!element || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  function revealEarlier() {
    const element = scroll.current;
    if (element) pendingAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
    setRevealedEarlier(nextRevealCount(window));
  }

  function collapseEarlier() {
    setRevealedEarlier(0);
  }

  const registerRound = (id: string) => (node: HTMLElement | null) => {
    if (node) roundNodes.current.set(id, node);
    else roundNodes.current.delete(id);
  };

  return (
    <div className={styles.frame}>
      <HistoryNavigator rounds={rounds} onSelect={goToRound} />
      <div className={styles.navigatorControls}>
        <button type="button" onClick={() => moveRound(-1)} disabled={!rounds.length || selectedIndex <= 0}>上一轮</button>
        <span aria-live="polite">{rounds.length ? `第 ${selectedIndex + 1} / ${rounds.length} 轮` : '暂无对话'}</span>
        <button type="button" onClick={() => moveRound(1)} disabled={!rounds.length || selectedIndex >= rounds.length - 1}>下一轮</button>
      </div>
      <div
        ref={scroll}
        className={styles.scroll}
        role="region"
        aria-label="对话消息"
        tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearEnd = isNearBottom({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            scrollTop: element.scrollTop,
          });
          follow.current = nearEnd;
          setShowJump(!nearEnd);
        }}
      >
        <div ref={flow} className={styles.flow}>
          {(window.hiddenCount > 0 || window.revealedEarlier > 0) && (
            <div className={styles.earlierActions}>
              {window.hiddenCount > 0 && <button type="button" onClick={revealEarlier}>
                查看更早的 {window.hiddenCount} 轮
              </button>}
              {window.revealedEarlier > 0 && <button type="button" onClick={collapseEarlier}>只显示最近 12 轮</button>}
            </div>
          )}
          {window.visible.map((round) => (
            <Round
              key={round.id}
              round={round}
              index={rounds.findIndex((candidate) => candidate.id === round.id)}
              register={registerRound(round.id)}
            />
          ))}
          {!messages.length && <p className={styles.empty}>发送第一条消息，开始与 Deeppi 对话。</p>}
        </div>
      </div>
      {showJump && <button className={styles.jump} type="button" onClick={() => {
        if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
        follow.current = true;
        setShowJump(false);
      }} aria-label="回到最新消息">回到最新</button>}
    </div>
  );
}
