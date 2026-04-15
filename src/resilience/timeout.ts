/**
 * Per-attempt timeout wrapper.
 *
 * Design notes:
 * - Takes an already-started Promise so the caller decides when to begin work.
 * - Clears the timer in a `finally` block — no leaked timers regardless of
 *   whether the race resolves, rejects, or throws.
 * - TimeoutError has no `statusCode` so the retry policy treats it as a
 *   retryable transient failure (unlike 4xx client errors).
 */

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Races `promise` against a timer.  Rejects with `TimeoutError` if the
 * timer fires first.
 *
 * Usage in the resilience chain:
 *   retryWithBackoff(() => withTimeout(externalCall(), TIMEOUT_MS), ...)
 *
 * The timeout is per-attempt (not cumulative), so each retry gets a fresh
 * 5-second window.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // timer! is assigned synchronously inside the Promise constructor — safe to
  // reference in finally before the outer async function awaits.
  let timer!: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    // Always clear the timer so we don't keep the event loop alive after
    // the operation completes (success or failure).
    clearTimeout(timer);
  }
}
