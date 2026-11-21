import { AppError, plainObject } from '../settings.mjs';

export const defaultContextPolicy = Object.freeze({ threshold: null, focus: '' });

export function updateContextPolicy(previous, patch) {
  if (!plainObject(patch)) throw new AppError(400, '上下文设置无效。');
  const threshold = patch.threshold === undefined ? previous.threshold : patch.threshold;
  if (threshold !== null && (!Number.isInteger(threshold) || threshold < 30 || threshold > 95)) {
    throw new AppError(400, '自动压缩阈值须在 30% 至 95% 之间。');
  }
  const focus = patch.focus === undefined ? previous.focus : patch.focus;
  if (typeof focus !== 'string' || focus.length > 2000 || focus.includes('\0')) throw new AppError(400, '压缩保留重点不能超过 2000 字。');
  return { threshold, focus: focus.trim() };
}

export function autoCompactionThreshold(policy, window) {
  return policy.threshold === null || !Number.isFinite(window) || window <= 0 ? null : Math.floor(window * policy.threshold / 100);
}

export function nativeCompaction(settings, model, defaults = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }) {
  const compaction = settings?.compaction;
  const override = model && compaction?.modelOverrides?.[`${model.provider}/${model.id}`];
  const nonnegative = (...values) => values.find(value => Number.isSafeInteger(value) && value >= 0);
  return {
    enabled: typeof compaction?.enabled === 'boolean' ? compaction.enabled : defaults.enabled,
    reserveTokens: nonnegative(override?.reserveTokens, compaction?.reserveTokens, defaults.reserveTokens),
    keepRecentTokens: nonnegative(override?.keepRecentTokens, compaction?.keepRecentTokens, defaults.keepRecentTokens),
  };
}
