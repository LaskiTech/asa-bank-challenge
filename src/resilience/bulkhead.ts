import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when the bulkhead concurrency limit is reached.
 * statusCode = 503 so the error handler returns 503 Service Unavailable.
 */
export class BulkheadError extends Error {
  readonly statusCode = 503;
  readonly errorCode = 'bulkhead_full';

  constructor(max: number) {
    super(`Too many concurrent requests to external service (limit: ${max})`);
    this.name = 'BulkheadError';
  }
}

// ---------------------------------------------------------------------------
// Bulkhead
// ---------------------------------------------------------------------------

/**
 * Concurrency limiter for calls to the external API.
 *
 * Why this matters in Node.js:
 *   Even though Node is single-threaded, concurrent I/O operations share the
 *   event loop.  If the external API is slow, 50 in-flight fetch() calls mean
 *   50 open sockets, 50 pending timers, and growing memory pressure.
 *   The bulkhead hard-caps that number.
 *
 * Placement in the resilience chain (mandatory — see ARQUITETURA.md):
 *   Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → ExternalAPI
 *
 *   Bulkhead comes FIRST so it rejects excess requests even when the circuit
 *   breaker is CLOSED.  A slow-but-not-failed external API would otherwise
 *   accumulate an unbounded number of waiting Promises.
 */
export class Bulkhead {
  private active = 0;

  constructor(private readonly maxConcurrent: number = 10) {}

  /**
   * Executes `fn` if a slot is available; throws BulkheadError otherwise.
   * The slot is released in a `finally` block — no leaks on error paths.
   */
  async call<T>(fn: () => Promise<T>, correlationId?: string): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      logger.warn('Bulkhead limit reached', {
        correlationId,
        active: this.active,
        max: this.maxConcurrent,
      });
      throw new BulkheadError(this.maxConcurrent);
    }

    this.active++;
    logger.info('Bulkhead: slot acquired', {
      correlationId,
      active: this.active,
      max: this.maxConcurrent,
    });

    try {
      return await fn();
    } finally {
      this.active--;
      logger.info('Bulkhead: slot released', {
        correlationId,
        active: this.active,
        max: this.maxConcurrent,
      });
    }
  }

  /** Exposed for health-check / monitoring endpoints. */
  get stats(): { active: number; max: number } {
    return { active: this.active, max: this.maxConcurrent };
  }
}
