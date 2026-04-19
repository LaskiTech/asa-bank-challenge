import { logger } from '../core/logger';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown by CircuitBreaker.call() when the breaker is OPEN.
 * statusCode = 503 so the error handler maps it to 503 Service Unavailable.
 */
export class CircuitBreakerOpenError extends Error {
  readonly statusCode = 503;
  readonly errorCode = 'circuit_breaker_open';

  constructor() {
    super('External authorization service is temporarily unavailable. Please retry after 30 seconds.');
    this.name = 'CircuitBreakerOpenError';
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Single-process circuit breaker.
 *
 * State transitions:
 *   CLOSED    → OPEN       : failureCount reaches failureThreshold
 *   OPEN      → HALF_OPEN  : openTimeoutMs has elapsed since last failure
 *   HALF_OPEN → CLOSED     : successCount reaches successThreshold
 *   HALF_OPEN → OPEN       : any failure (resets the open timer)
 *
 * Counting semantics:
 *   - Counts CONSECUTIVE failures in CLOSED (reset to 0 on any success).
 *   - Counts CONSECUTIVE successes in HALF_OPEN (reset to OPEN on any failure).
 *
 * Known limitation (documented in ARQUITETURA.md §8.2):
 *   State is per-process — not synchronised across pods.  Production solution:
 *   share state via Redis.
 */
export class CircuitBreaker {
  private state: CBState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private openedAt = 0; // timestamp when the breaker last opened

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly successThreshold: number = 2,
    private readonly openTimeoutMs: number = 30_000,
  ) {}

  getState(): CBState {
    return this.state;
  }

  /**
   * Executes `fn` through the breaker.
   * - OPEN  → throws CircuitBreakerOpenError immediately (no I/O).
   * - CLOSED / HALF_OPEN → runs fn, records success or failure.
   */
  async call<T>(fn: () => Promise<T>, correlationId?: string): Promise<T> {
    this.transitionIfNeeded(correlationId);

    if (this.state === 'OPEN') {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.recordSuccess(correlationId);
      return result;
    } catch (err) {
      this.recordFailure(correlationId);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Promotes OPEN → HALF_OPEN once the open timeout has expired.
   * Called at the start of every `call()` invocation.
   */
  private transitionIfNeeded(correlationId?: string): void {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.openTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        logger.info('Circuit breaker → HALF_OPEN', {
          correlationId,
          openDurationMs: elapsed,
        });
      }
    }
  }

  private recordSuccess(correlationId?: string): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      logger.info('Circuit breaker success in HALF_OPEN', {
        correlationId,
        successCount: this.successCount,
        successThreshold: this.successThreshold,
      });

      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        logger.info('Circuit breaker → CLOSED (recovered)', { correlationId });
      }
    } else {
      // CLOSED: reset consecutive failure counter on any success
      this.failureCount = 0;
    }
  }

  private recordFailure(correlationId?: string): void {
    this.openedAt = Date.now(); // update timer on every failure (resets HALF_OPEN probe)

    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN re-opens the breaker immediately
      this.state = 'OPEN';
      this.successCount = 0;
      logger.warn('Circuit breaker → OPEN (probe failed in HALF_OPEN)', {
        correlationId,
        failureThreshold: this.failureThreshold,
      });
      return;
    }

    this.failureCount++;
    logger.warn('Circuit breaker failure recorded', {
      correlationId,
      state: this.state,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
    });

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.warn('Circuit breaker → OPEN (threshold reached)', {
        correlationId,
        failureCount: this.failureCount,
      });
    }
  }
}
