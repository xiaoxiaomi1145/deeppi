import { randomUUID } from 'node:crypto';
import { cleanupSessionResources } from '@earendil-works/pi-ai/session-resources';
import { Agent } from '@earendil-works/pi-agent-core';
import { bool, obj, opt, str } from '@earendil-works/pi-schema';
import { createRoute } from './provider.mjs';

const resultLimit = 4000;
const failure = content => ({ content: [{ type: 'text', text: content }], isError: true });

export function createDelegation({ settings, mainRoute, override, sessionId, systemPrompt, signal, seed, bashTools, onChild, onUsage }) {
  const queue = [];
  const running = new Set();
  let delegated = 0;
  let savedRoute;

  function update(child, status, result) {
    Object.assign(child, { status, result, updatedAt: Date.now() });
    onChild(child);
  }

  async function work({ child, messages, useBash }) {
    signal.throwIfAborted();
    const route = settings.subagentModel && settings.subagentModel !== settings.model
      ? (savedRoute ??= createRoute(settings, override, settings.subagentModel)) : mainRoute;
    const tools = useBash ? bashTools.filter(tool => tool.name !== 'define_tool') : [];
    const childSessionId = `${sessionId}-child-${child.id}`;
    let turns = 0;
    const agent = new Agent({
      initialState: { model: route.model, systemPrompt, tools, messages, thinkingLevel: settings.thinkingLevel },
      sessionId: childSessionId,
      streamFn: (model, context, options) => route.stream(model, context, options, onUsage, 'child'),
      finishTurn: () => (++turns >= Math.min(8, settings.maxTurns) ? { action: 'end' } : undefined),
    });
    const abort = () => agent.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await agent.prompt(`You are a subagent. Treat preceding messages as context, complete only the task below, and report findings, changes and blockers concisely.\n\n${child.task}`);
      signal.throwIfAborted();
      if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      const answer = agent.state.messages.findLast(message => message.role === 'assistant');
      if (answer?.stopReason === 'length') {
        throw new Error('子代理输出达到 token 上限。请缩短任务或提高最大输出 tokens。');
      }
      if (answer?.stopReason === 'toolUse') {
        throw new Error('子代理达到工具调用轮次上限。请拆分任务或提高最大运行轮次。');
      }
      if (answer?.stopReason !== 'stop') throw new Error('子代理没有完成最终回答。');
      const text = answer.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      if (!text) throw new Error('子代理没有返回文本总结。');
      return text.length > resultLimit ? `${text.slice(0, resultLimit)}\n[结果已截断]` : text;
    } finally {
      signal.removeEventListener('abort', abort);
      cleanupSessionResources(childSessionId);
    }
  }

  function pump() {
    while (!signal.aborted && running.size < settings.maxSubagents && queue.length) {
      const job = queue.shift();
      const completion = (async () => {
        try {
          update(job.child, 'running');
          const result = await work(job);
          update(job.child, 'done', result);
          job.resolve({ content: [{ type: 'text', text: result }], details: { childId: job.child.id } });
        } catch (error) {
          const message = signal.aborted ? '子代理已停止。' : (error.message || '子代理失败。').slice(0, 500);
          try { update(job.child, signal.aborted ? 'cancelled' : 'error', message); }
          finally { job.resolve(failure(message)); }
        }
      })().catch(() => {});
      running.add(completion);
      void completion.then(() => { running.delete(completion); pump(); });
    }
  }

  const cancelQueue = () => {
    for (const job of queue.splice(0)) {
      try { update(job.child, 'cancelled', '子代理已停止。'); }
      catch { /* Continue releasing every queued caller on shutdown. */ }
      job.resolve(failure('子代理已停止。'));
    }
  };
  signal.addEventListener('abort', cancelQueue, { once: true });

  const tool = {
    name: 'delegate', label: '子代理', executionMode: 'parallel',
    description: 'Delegate one independent task to a child agent that inherits the settled conversation prefix. Multiple calls can run in parallel, with one result per call. Set useBash only for a task that needs local shell work and has a clearly disjoint write scope. Children cannot delegate or register tools.',
    parameters: obj({ name: str({ minLength: 1, maxLength: 64 }), task: str({ minLength: 1, maxLength: 8000 }), useBash: opt(bool()) }),
    execute(_id, { name, task, useBash }) {
      if (signal.aborted) return Promise.resolve(failure('子代理已停止。'));
      if (useBash && !settings.allowBash) return Promise.resolve(failure('此会话未启用 Bash。'));
      if (++delegated > Math.max(4, settings.maxSubagents * 3)) return Promise.resolve(failure('本轮的子代理配额已用完。'));
      const child = { id: randomUUID(), name: name.trim() || '子代理', task, status: 'queued', updatedAt: Date.now() };
      onChild(child);
      const messages = seed();
      return new Promise(resolve => {
        queue.push({ child, messages, useBash, resolve });
        pump();
      });
    },
  };
  return { tool, async settle() {
    signal.removeEventListener('abort', cancelQueue);
    cancelQueue();
    await Promise.all(running);
  } };
}
