import { config } from '../core/config';
import { logger } from '../core/logger';

// ---------------------------------------------------------------------------
// Response shape returned by the external authorization API
// ---------------------------------------------------------------------------

export interface ExternalApiResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Thin HTTP client for the external authorization API.
 *
 * This class is ONLY responsible for making the HTTP calls.  All resilience
 * concerns (timeout, retry, circuit breaker) are applied by ResilienceService
 * which wraps every method here.  Keeping the two concerns separate means each
 * layer is testable in isolation.
 *
 * Error handling convention:
 *   - Non-2xx responses throw an Error with `statusCode` set to the HTTP status.
 *   - 4xx → propagates without retry (RetryPolicy sees statusCode 4xx → not retryable).
 *   - 5xx / network errors → retried by RetryPolicy.
 *   - When EXTERNAL_API_URL is unreachable (dev/test) a network error is thrown,
 *     which the retry/circuit-breaker chain handles.
 */
export class ExternalApiService {
  private readonly baseUrl: string;

  constructor(baseUrl: string = config.EXTERNAL_API_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // strip trailing slash
  }

  async authorize(
    nsu: string,
    amount: number,
    terminalId: string,
    correlationId: string,
  ): Promise<ExternalApiResult> {
    return this.post('/authorize', { nsu, amount, terminalId }, correlationId);
  }

  async confirm(transactionId: string, correlationId: string): Promise<ExternalApiResult> {
    return this.post('/confirm', { transactionId }, correlationId);
  }

  async void(transactionId: string, correlationId: string): Promise<ExternalApiResult> {
    return this.post('/void', { transactionId }, correlationId);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async post(
    path: string,
    body: Record<string, unknown>,
    correlationId: string,
  ): Promise<ExternalApiResult> {
    const url = `${this.baseUrl}${path}`;
    const bodyJson = JSON.stringify(body);

    logger.info('External API request', { correlationId, url, body });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Correlation-ID': correlationId,
        },
        body: bodyJson,
      });
    } catch (networkErr) {
      // ECONNREFUSED, DNS failure, network timeout from AbortController, etc.
      // These are all "the external API is unreachable" — map to 503 so the
      // retry policy retries them and the circuit breaker counts them.
      logger.warn('External API unreachable (network error)', {
        correlationId,
        url,
        reason: networkErr instanceof Error ? networkErr.message : String(networkErr),
      });
      const err = new Error(
        `External API ${path} unreachable: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
      );
      (err as any).statusCode = 503;
      throw err;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      logger.warn('External API returned non-2xx', {
        correlationId,
        url,
        status: response.status,
        payload,
      });

      const err = new Error(
        `External API ${path} failed with status ${response.status}`,
      );
      (err as NodeJS.ErrnoException & { statusCode: number }).statusCode = response.status;
      throw err;
    }

    logger.info('External API response', { correlationId, url, status: response.status, payload });

    return payload as ExternalApiResult;
  }
}

export const externalApiService = new ExternalApiService();
