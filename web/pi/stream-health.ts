export interface StreamHealth { startedAt: number; lastActivity: number; ready: boolean }

// The server emits heartbeat comments every 15 seconds; tolerate two missed beats.
export const firstRetryMs = 450;
export const watchdogMs = 5_000;

export function staleStream(health: StreamHealth, now: number): boolean {
  return health.ready ? now - health.lastActivity >= 45_000 : now - health.startedAt >= 15_000;
}

export function shouldWakeStream(reason: 'visible' | 'online', stream: StreamHealth | undefined, now: number, online: boolean, terminal: boolean): boolean {
  return !terminal && online && (!stream || staleStream(stream, now) || (reason === 'online' && stream.ready));
}

export function retryAfter(previous: number): number {
  return Math.min(previous * 2, 5_000);
}
