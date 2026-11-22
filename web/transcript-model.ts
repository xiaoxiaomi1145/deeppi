import type { MessageView } from './types';

export interface ToolSummary {
  total: number;
  running: number;
  errors: number;
}

export type TranscriptBlock =
  | { kind: 'assistant'; message: MessageView }
  | { kind: 'tools'; tools: MessageView[] };

export interface TranscriptRound {
  id: string;
  user?: MessageView;
  blocks: TranscriptBlock[];
  complete: boolean;
  toolSummary: ToolSummary;
}

export interface RoundWindow {
  visible: TranscriptRound[];
  hiddenCount: number;
  revealedEarlier: number;
}

const RECENT_COMPLETE_ROUNDS = 12;
const REVEAL_BATCH = 6;

function isVisibleAssistant(message: MessageView) {
  if (message.role !== 'assistant') return false;
  if (message.text.trim() || message.thinking?.trim()) return true;
  return message.state === 'running';
}

function isRunning(message: MessageView) {
  return message.state === 'running';
}

export function summarizeTools(tools: readonly MessageView[]): ToolSummary {
  let running = 0;
  let errors = 0;
  for (const tool of tools) {
    if (tool.state === 'running') running += 1;
    if (tool.state === 'error') errors += 1;
  }
  return { total: tools.length, running, errors };
}

function addBlock(round: TranscriptRound, message: MessageView) {
  if (message.role === 'tool') {
    const last = round.blocks.at(-1);
    if (last?.kind === 'tools') {
      last.tools.push(message);
    } else {
      round.blocks.push({ kind: 'tools', tools: [message] });
    }
    // Tool messages are appended in transcript order. Keep the summary as a
    // small counter instead of flattening every preceding tool block for each
    // new tool (which made long tool-heavy rounds quadratic).
    round.toolSummary = {
      total: round.toolSummary.total + 1,
      running: round.toolSummary.running + (message.state === 'running' ? 1 : 0),
      errors: round.toolSummary.errors + (message.state === 'error' ? 1 : 0),
    };
    return;
  }

  if (isVisibleAssistant(message)) {
    round.blocks.push({ kind: 'assistant', message });
  }
}

export function buildRounds(messages: readonly MessageView[]): TranscriptRound[] {
  const rounds: TranscriptRound[] = [];
  let current: TranscriptRound | undefined;

  for (const message of messages) {
    if (message.role === 'user') {
      if (current) rounds.push(current);
      current = {
        id: `round-${message.id}`,
        user: message,
        blocks: [],
        complete: true,
        toolSummary: { total: 0, running: 0, errors: 0 },
      };
      continue;
    }

    if (!current) {
      current = {
        id: 'round-prelude',
        blocks: [],
        complete: true,
        toolSummary: { total: 0, running: 0, errors: 0 },
      };
    }

    addBlock(current, message);
    if (isRunning(message)) current.complete = false;
  }

  if (current) rounds.push(current);
  return rounds;
}

export type RoundActivity = { kind: 'thinking' | 'tool'; message: MessageView };

export function roundContent(round: TranscriptRound) {
  const activity: RoundActivity[] = [];
  const body: MessageView[] = [];
  for (const block of round.blocks) {
    if (block.kind === 'tools') {
      for (const message of block.tools) activity.push({ kind: 'tool', message });
    } else {
      const { message } = block;
      if (message.thinking?.trim()) activity.push({ kind: 'thinking', message });
      if (message.text.trim()) body.push(message);
    }
  }
  return { activity, body };
}

export function selectRoundWindow(
  rounds: readonly TranscriptRound[],
  options: { revealedEarlier?: number } = {},
): RoundWindow {
  if (rounds.length === 0) return { visible: [], hiddenCount: 0, revealedEarlier: 0 };

  let lastIncomplete = -1;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (!rounds[index].complete) {
      lastIncomplete = index;
      break;
    }
  }
  const activeTail = lastIncomplete >= 0 ? rounds.slice(lastIncomplete) : [];
  const completeEnd = lastIncomplete >= 0 ? lastIncomplete : rounds.length;
  const completeRounds = rounds.slice(0, completeEnd);
  const reveal = Math.min(
    Math.max(0, options.revealedEarlier ?? 0),
    Math.max(0, completeRounds.length - RECENT_COMPLETE_ROUNDS),
  );
  const visibleStart = Math.max(0, completeRounds.length - RECENT_COMPLETE_ROUNDS - reveal);
  const hiddenCount = visibleStart;

  return {
    visible: [...completeRounds.slice(visibleStart), ...activeTail],
    hiddenCount,
    revealedEarlier: completeRounds.length - RECENT_COMPLETE_ROUNDS > 0 ? reveal : 0,
  };
}

export function nextRevealCount(window: RoundWindow) {
  return window.revealedEarlier + Math.min(REVEAL_BATCH, window.hiddenCount);
}

export function preserveScrollAnchor(previousScrollHeight: number, previousScrollTop: number, nextScrollHeight: number) {
  return previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
}

export function isNearBottom({
  scrollHeight,
  clientHeight,
  scrollTop,
  threshold = 80,
}: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  threshold?: number;
}) {
  return scrollHeight - clientHeight - scrollTop <= threshold;
}
