import { Transaction, AuthorizeRequest, TransactionState } from '../types';
import { ITransactionStore } from '../storage/ITransactionStore';
import { transactionStore } from '../storage/SqliteTransactionStore';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(message: string, statusCode: number, errorCode: string): Error {
  const err = new Error(message);
  (err as any).statusCode = statusCode;
  (err as any).errorCode = errorCode;
  return err;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Business logic for the transaction state machine.
 *
 * Responsibilities:
 *   - Idempotency check for /authorize (lookup by terminalId+nsu).
 *   - Creating and retrieving transaction records.
 *   - Transitioning states (validate before delegating to storage).
 *
 * Deliberately does NOT call the external API — that is ResilienceService's job.
 * Separation keeps each layer independently testable.
 */
export class TransactionService {
  constructor(private readonly store: ITransactionStore = transactionStore) {}

  // ---------------------------------------------------------------------------
  // Authorize
  // ---------------------------------------------------------------------------

  /**
   * Returns an existing transaction when (terminalId, nsu) is already in the
   * DB (idempotent replay), or creates a new AUTHORIZED record.
   *
   * `isNew: false` → replay: route must NOT call the external API again.
   * `isNew: true`  → fresh transaction: route should call the external API.
   */
  authorize(req: AuthorizeRequest, correlationId: string): { transaction: Transaction; isNew: boolean } {
    const { nsu, terminalId, amount } = req;

    const existing = this.store.findByNsuAndTerminal(nsu, terminalId);
    if (existing) {
      logger.info('Authorize: idempotent replay — returning existing transaction', {
        correlationId,
        transactionId: existing.id,
        nsu,
        terminalId,
        state: existing.state,
      });
      return { transaction: existing, isNew: false };
    }

    const transaction = this.store.create(nsu, terminalId, amount);
    logger.info('Authorize: transaction created', {
      correlationId,
      transactionId: transaction.id,
      nsu,
      terminalId,
      amount,
    });

    return { transaction, isNew: true };
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /**
   * Returns the transaction or throws 404.
   */
  getById(transactionId: string, correlationId?: string): Transaction {
    const tx = this.store.findById(transactionId);
    if (!tx) {
      logger.warn('Transaction not found by id', { correlationId, transactionId });
      throw makeError(
        `Transaction ${transactionId} not found`,
        404,
        'transaction_not_found',
      );
    }
    return tx;
  }

  /**
   * Looks up by (nsu, terminalId) — used for void Form B.
   * Throws 404 if not found.
   */
  getByNsuAndTerminal(nsu: string, terminalId: string, correlationId?: string): Transaction {
    const tx = this.store.findByNsuAndTerminal(nsu, terminalId);
    if (!tx) {
      logger.warn('Transaction not found by nsu+terminalId', { correlationId, nsu, terminalId });
      throw makeError(
        `No transaction found for nsu=${nsu}, terminalId=${terminalId}`,
        404,
        'transaction_not_found',
      );
    }
    return tx;
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Validates the requested transition and updates state in storage.
   *
   * State machine (from ARQUITETURA.md):
   *   AUTHORIZED → CONFIRMED   ✓
   *   AUTHORIZED → VOIDED      ✓
   *   CONFIRMED  → VOIDED      ✓
   *   VOIDED     → any         → 409
   *   any        → same state  → 204 (caller handles, not an error here)
   */
  transition(
    transaction: Transaction,
    targetState: 'CONFIRMED' | 'VOIDED',
    correlationId?: string,
  ): Transaction {
    const { id, state: currentState } = transaction;

    // Idempotent — already in target state
    if (currentState === targetState) {
      logger.info('State transition: already in target state (no-op)', {
        correlationId,
        transactionId: id,
        state: currentState,
      });
      return transaction; // caller should return 204 without calling external API
    }

    // Invalid transitions
    if (currentState === 'VOIDED') {
      throw makeError(
        `Transaction ${id} is VOIDED and cannot be transitioned to ${targetState}`,
        409,
        'invalid_transaction_state',
      );
    }

    if (targetState === 'CONFIRMED' && currentState !== 'AUTHORIZED') {
      throw makeError(
        `Transaction ${id} must be AUTHORIZED to confirm (current: ${currentState})`,
        409,
        'invalid_transaction_state',
      );
    }

    // Apply
    const updated = this.store.updateState(id, targetState as TransactionState);
    logger.info('State transition applied', {
      correlationId,
      transactionId: id,
      from: currentState,
      to: targetState,
    });

    return updated;
  }
}

export const transactionService = new TransactionService();
