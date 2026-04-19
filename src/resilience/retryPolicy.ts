import { logger } from '../core/logger';

/**
 * Determines whether an error warrants a retry.
 *
 * 4xx responses are client errors — the payload is wrong and retrying the
 * same request will always fail.  Every other failure (timeout, network error,
 * 5xx) is potentially transient and worth retrying.
 */
function isRetryable(err: unknown): boolean {
  const status = (err as Record<string, unknown>)?.['statusCode'];
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff.
 *
 * Delay schedule (baseDelayMs = 1 000):
 *   attempt 1 → no wait (fails fast)
 *   attempt 2 → wait 1 s
 *   attempt 3 → wait 2 s
 *   (attempt 4 would wait 4 s, but default maxAttempts is 3)
 *
 * Non-retryable (4xx) errors surface immediately without waiting.
 *
 * @param fn          Factory that produces a fresh Promise each attempt.
 *                    Must be a factory (not the Promise itself) so that each
 *                    retry starts a new operation rather than observing the
 *                    same already-settled Promise.
 * @param maxAttempts Maximum number of total attempts (default 3).
 * @param baseDelayMs Base delay in ms; doubles on each subsequent attempt.
 * @param correlationId Attached to retry log lines for tracing.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  baseDelayMs: number = 1000,
  correlationId?: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Surface client errors immediately — retrying won't help.
      if (!isRetryable(err)) {
        logger.warn('Retry skipped: non-retryable error', {
          correlationId,
          attempt,
          errorCode: (err as Record<string, unknown>)?.['statusCode'],
          reason: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (attempt < maxAttempts) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // 1s, 2s, 4s …
        logger.warn('Retry scheduled', {
          correlationId,
          attempt,
          maxAttempts,
          delayMs,
          reason: err instanceof Error ? err.message : String(err),
        });
        await sleep(delayMs);
      } else {
        logger.warn('All retry attempts exhausted', {
          correlationId,
          attempt,
          maxAttempts,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  throw lastError;
}
