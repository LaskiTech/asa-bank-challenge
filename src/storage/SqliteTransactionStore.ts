import * as Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { Transaction, TransactionState } from '../core/types';
import { ITransactionStore } from './ITransactionStore';

// Row shape returned by better-sqlite3 for the transactions table
interface TransactionRow {
  id: string;
  nsu: string;
  terminal_id: string;
  amount: number;
  state: TransactionState;
  external_api_id: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteTransactionStore implements ITransactionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = config.DATABASE_PATH) {
    // Ensure the data directory exists before opening the file
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);

    // WAL mode: readers don't block writers, better concurrency on a single process
    this.db.pragma('journal_mode = WAL');
    // Referential integrity (no FKs yet, but good practice)
    this.db.pragma('foreign_keys = ON');

    this.migrate();

    logger.info('SqliteTransactionStore initialised', { dbPath });
  }

  // Schema is self-contained — no external SQL scripts required.
  // The UNIQUE index on (terminal_id, nsu) enforces idempotency at the DB level,
  // acting as a second safety net beyond the application-level lookup.
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id              TEXT    PRIMARY KEY,
        nsu             TEXT    NOT NULL,
        terminal_id     TEXT    NOT NULL,
        amount          REAL    NOT NULL,
        state           TEXT    NOT NULL
          CHECK (state IN ('AUTHORIZED', 'CONFIRMED', 'VOIDED')),
        external_api_id TEXT,
        created_at      TEXT    NOT NULL,
        updated_at      TEXT    NOT NULL
      );

      -- Unique index guarantees idempotency at the storage level:
      -- a duplicate (terminalId, nsu) pair will never produce a second row.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_nsu
        ON transactions (terminal_id, nsu);

      -- Optional: speeds up state-machine lookups
      CREATE INDEX IF NOT EXISTS idx_state
        ON transactions (state);
    `);
  }

  create(nsu: string, terminalId: string, amount: number): Transaction {
    const id = uuidv4().toUpperCase();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO transactions
           (id, nsu, terminal_id, amount, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'AUTHORIZED', ?, ?)`
      )
      .run(id, nsu, terminalId, amount, now, now);

    // Read back to produce a fully-typed Transaction (avoids duplicating mapping logic)
    return this.findById(id) as Transaction;
  }

  findById(transactionId: string): Transaction | null {
    const row = this.db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(transactionId) as TransactionRow | undefined;

    return row ? this.toTransaction(row) : null;
  }

  findByNsuAndTerminal(nsu: string, terminalId: string): Transaction | null {
    const row = this.db
      .prepare('SELECT * FROM transactions WHERE terminal_id = ? AND nsu = ?')
      .get(terminalId, nsu) as TransactionRow | undefined;

    return row ? this.toTransaction(row) : null;
  }

  updateState(transactionId: string, newState: TransactionState): Transaction {
    const now = new Date().toISOString();

    const result = this.db
      .prepare(
        `UPDATE transactions
         SET state = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(newState, now, transactionId);

    if (result.changes === 0) {
      const err = new Error(`Transaction not found: ${transactionId}`);
      (err as any).statusCode = 404;
      throw err;
    }

    return this.findById(transactionId) as Transaction;
  }

  private toTransaction(row: TransactionRow): Transaction {
    const base = {
      id: row.id,
      nsu: row.nsu,
      terminalId: row.terminal_id,
      amount: row.amount,
      state: row.state,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    // exactOptionalPropertyTypes: must omit the key entirely rather than setting undefined
    return row.external_api_id !== null
      ? { ...base, externalApiId: row.external_api_id }
      : base;
  }
}

// Module-level singleton — imported as `{ transactionStore }` everywhere.
// To swap storage backend: change only this line and the import above it.
export const transactionStore: ITransactionStore = new SqliteTransactionStore();
