import { Bulkhead } from '../resilience/bulkhead';
import { CircuitBreaker } from '../resilience/circuitBreaker';
import { retryWithBackoff } from '../resilience/retryPolicy';
import { withTimeout } from '../resilience/timeout';
import { ExternalApiService, ExternalApiResult, externalApiService } from './externalApiService';
import { config } from '../config';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full resilience protection chain around every external API
 * call.  The mandatory order (from ARQUITETURA.md / CLAUDE.md) is:
 *
 *   Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → ExternalAPI
 *
 *   Bulkhead first  — caps in-flight calls even when CB is CLOSED.
 *   CB second       — fast-fails when the external API is known to be down.
 *   Retry third     — retries transient failures (5xx, timeout) with backoff.
 *   Timeout innermost — each individual attempt gets its own per-call deadline.
 *
 * Resilience instances are singletons on this service so state (failure count,
 * CB state) persists across requests for the lifetime of the process.
 */
export class ResilienceService {
  private readonly bulkhead: Bulkhead;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(
    private readonly external: ExternalApiService = externalApiService,
    bulkhead?: Bulkhead,
    circuitBreaker?: CircuitBreaker,
  ) {
    this.bulkhead = bulkhead ?? new Bulkhead(config.BULKHEAD_MAX_CONCURRENT);
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker(
      config.CIRCUIT_BREAKER_THRESHOLD,
      2, // successThreshold: 2 successes in HALF_OPEN → CLOSED
      config.CIRCUIT_BREAKER_TIMEOUT_MS,
    );
  }

  // ---------------------------------------------------------------------------
  // Public: per-operation wrappers
  // ---------------------------------------------------------------------------

  callAuthorize(
    nsu: string,
    amount: number,
    terminalId: string,
    correlationId: string,
  ): Promise<ExternalApiResult> {
    return this.protect(
      () => this.external.authorize(nsu, amount, terminalId, correlationId),
      'authorize',
      correlationId,
    );
  }

  callConfirm(transactionId: string, correlationId: string): Promise<ExternalApiResult> {
    return this.protect(
      () => this.external.confirm(transactionId, correlationId),
      'confirm',
      correlationId,
    );
  }

  callVoid(transactionId: string, correlationId: string): Promise<ExternalApiResult> {
    return this.protect(
      () => this.external.void(transactionId, correlationId),
      'void',
      correlationId,
    );
  }

  /** Exposes CB state for health-check / monitoring. */
  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  /** Exposes bulkhead stats for health-check / monitoring. */
  getBulkheadStats(): { active: number; max: number } {
    return this.bulkhead.stats;
  }

  // ---------------------------------------------------------------------------
  // Private: the chain
  // ---------------------------------------------------------------------------

  /**
   * Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → fn
   *
   * Every layer receives `correlationId` so structured log lines are traceable.
   */
  private async protect(
    fn: () => Promise<ExternalApiResult>,
    operation: string,
    correlationId: string,
  ): Promise<ExternalApiResult> {
    try {
      return await this.bulkhead.call(
        () =>
          this.circuitBreaker.call(
            () =>
              retryWithBackoff(
                // Factory: each retry starts a fresh request + a fresh timeout.
                () => withTimeout(fn(), config.EXTERNAL_API_TIMEOUT_MS),
                config.RETRY_MAX_ATTEMPTS,
                config.RETRY_BASE_DELAY_MS,
                correlationId,
              ),
            correlationId,
          ),
        correlationId,
      );
    } catch (err) {
      logger.error('External API call failed after full protection chain', {
        correlationId,
        operation,
        error: err instanceof Error ? err.message : String(err),
        cbState: this.circuitBreaker.getState(),
        bulkhead: this.bulkhead.stats,
      });
      throw err;
    }
  }
}

export const resilienceService = new ResilienceService();
