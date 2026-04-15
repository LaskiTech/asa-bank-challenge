import { Transaction, TransactionState } from '../types';

/**
 * Storage abstraction for transactions.
 *
 * Swap SQLite for PostgreSQL by implementing this interface and updating
 * the injection in SqliteTransactionStore — nothing else changes.
 */
export interface ITransactionStore {
  /**
   * Insert a new transaction in AUTHORIZED state.
   * Throws if (terminalId, nsu) already exists (UNIQUE constraint).
   */
  create(nsu: string, terminalId: string, amount: number): Transaction;

  /** Returns null when not found. */
  findById(transactionId: string): Transaction | null;

  /** Idempotency lookup for /authorize. Returns null when not found. */
  findByNsuAndTerminal(nsu: string, terminalId: string): Transaction | null;

  /**
   * Transition a transaction to a new state.
   * Throws with statusCode 404 if the transaction does not exist.
   */
  updateState(transactionId: string, newState: TransactionState): Transaction;
}
