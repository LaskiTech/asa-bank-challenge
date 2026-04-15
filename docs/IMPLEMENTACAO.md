# IMPLEMENTACAO.md - Guia Passo-a-Passo

## Fase 1: Setup Inicial (15-20 min)

### 1.1 Criar projeto Node.js + TypeScript

```bash
mkdir pos-transaction-api
cd pos-transaction-api

npm init -y

# Dependências de runtime
npm install express cors dotenv uuid better-sqlite3

# Dependências de desenvolvimento (Node.js 22 LTS)
npm install -D typescript@5 @types/node@22 @types/express @types/better-sqlite3 ts-node nodemon
npm install -D @tsconfig/node22

# Inicializar tsconfig.json
npx tsc --init --target ES2022 --module commonjs --lib ES2022
```

### 1.2 Estrutura de Pastas

```
src/
├── index.ts                    # Entry point
├── app.ts                      # Express setup
├── types.ts                    # TypeScript interfaces
├── config.ts                   # Env vars
├── logger.ts                   # Logging simple
│
├── routes/
│   └── transactions.ts         # /v1/pos/transactions/*
│
├── services/
│   ├── transactionService.ts   # Business logic
│   ├── externalApiService.ts   # Mock API externa
│   └── resilienceService.ts    # Circuit breaker + retry
│
├── middleware/
│   ├── security.ts             # HMAC + timestamp
│   ├── correlation.ts          # Correlation ID
│   └── errorHandler.ts         # Erro global
│
├── storage/
│   └── transactionStore.ts     # In-memory ou DB
│
└── resilience/
    ├── circuitBreaker.ts
    ├── retryPolicy.ts
    └── timeout.ts
```

### 1.3 package.json Scripts

```json
{
  "scripts": {
    "dev": "ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "watch": "nodemon --exec ts-node src/index.ts"
  }
}
```

---

## Fase 2: Core Types & Config (10 min)

### 2.1 src/types.ts

```typescript
export type TransactionState = 'AUTHORIZED' | 'CONFIRMED' | 'VOIDED';

export interface Transaction {
  id: string;                    // transactionId (UUID)
  nsu: string;
  terminalId: string;
  amount: number;
  state: TransactionState;
  createdAt: Date;
  updatedAt: Date;
  externalApiId?: string;        // ID da API externa (se tiver)
}

export interface AuthorizeRequest {
  nsu: string;
  amount: number;
  terminalId: string;
}

export interface ConfirmRequest {
  transactionId: string;
}

export interface VoidRequest {
  transactionId?: string;
  nsu?: string;
  terminalId?: string;
}

export interface AppError extends Error {
  statusCode: number;
  errorCode: string;
}
```

### 2.2 src/config.ts

```typescript
export const config = {
  // Server
  PORT: parseInt(process.env['PORT'] ?? '3000'),
  NODE_ENV: process.env['NODE_ENV'] ?? 'development',

  // Security
  SHARED_SECRET: process.env['SHARED_SECRET'] ?? 'dev-secret-key-change-in-production',
  TIMESTAMP_MAX_AGE_SEC: parseInt(process.env['TIMESTAMP_MAX_AGE_SEC'] ?? '300'),

  // Storage
  DATABASE_PATH: process.env['DATABASE_PATH'] ?? './data/transactions.db',

  // External API
  EXTERNAL_API_URL: process.env['EXTERNAL_API_URL'] ?? 'http://localhost:4000',
  EXTERNAL_API_TIMEOUT_MS: parseInt(process.env['EXTERNAL_API_TIMEOUT_MS'] ?? '5000'),

  // Resilience
  RETRY_MAX_ATTEMPTS: parseInt(process.env['RETRY_MAX_ATTEMPTS'] ?? '3'),
  RETRY_BASE_DELAY_MS: parseInt(process.env['RETRY_BASE_DELAY_MS'] ?? '1000'),
  CIRCUIT_BREAKER_THRESHOLD: parseInt(process.env['CIRCUIT_BREAKER_THRESHOLD'] ?? '5'),
  CIRCUIT_BREAKER_TIMEOUT_MS: parseInt(process.env['CIRCUIT_BREAKER_TIMEOUT_MS'] ?? '30000'),
  BULKHEAD_MAX_CONCURRENT: parseInt(process.env['BULKHEAD_MAX_CONCURRENT'] ?? '10'),
};

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
```

### 2.3 src/logger.ts

```typescript
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  correlationId?: string;
  [key: string]: any;
}

class Logger {
  info(message: string, metadata?: Record<string, any>) {
    this.log('info', message, metadata);
  }
  
  warn(message: string, metadata?: Record<string, any>) {
    this.log('warn', message, metadata);
  }
  
  error(message: string, metadata?: Record<string, any>) {
    this.log('error', message, metadata);
  }
  
  private log(level: string, message: string, metadata?: Record<string, any>) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: level as any,
      message,
      ...metadata
    };
    console.log(JSON.stringify(entry));
  }
}

export const logger = new Logger();
```

---

## Fase 3: Middleware de Segurança (20 min)

### 3.1 src/middleware/security.ts

```typescript
import { Request, Response, NextFunction } from 'express';
import { createHmac } from 'crypto';
import { config } from '../config';

export interface SecureRequest extends Request {
  correlationId: string;
  rawBody: string;
}

export function createSignature(body: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(body)
    .digest('hex');
}

export function validateSignature(body: string, headerSignature: string, secret: string): boolean {
  const expectedSignature = createSignature(body, secret);
  return expectedSignature === headerSignature;
}

export function signatureMiddleware(req: SecureRequest, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return next();
  }
  
  const signature = req.headers['x-signature'] as string;
  if (!signature) {
    return res.status(401).json({
      error: 'missing_signature',
      message: 'X-Signature header is required'
    });
  }
  
  if (!validateSignature(req.rawBody, signature, config.SHARED_SECRET)) {
    return res.status(401).json({
      error: 'invalid_signature',
      message: 'X-Signature does not match payload'
    });
  }
  
  next();
}

export function timestampMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return next();
  }
  
  const timestamp = req.headers['x-timestamp'] as string;
  if (!timestamp) {
    return res.status(401).json({
      error: 'missing_timestamp',
      message: 'X-Timestamp header is required'
    });
  }
  
  const clientTime = new Date(timestamp).getTime();
  if (isNaN(clientTime)) {
    return res.status(401).json({
      error: 'invalid_timestamp',
      message: 'X-Timestamp must be ISO-8601 format'
    });
  }
  
  const ageMs = Date.now() - clientTime;
  const ageSec = ageMs / 1000;
  
  if (ageSec < -30 || ageSec > config.TIMESTAMP_MAX_AGE_SEC) {
    return res.status(401).json({
      error: 'timestamp_out_of_range',
      message: `Request age is ${ageSec.toFixed(1)}s`
    });
  }
  
  next();
}
```

### 3.2 src/middleware/correlation.ts

```typescript
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export interface CorrelatedRequest extends Request {
  correlationId: string;
}

export function correlationIdMiddleware(req: CorrelatedRequest, res: Response, next: NextFunction) {
  const correlationId = (req.headers['correlation-id'] as string) || uuidv4();
  req.correlationId = correlationId;
  res.setHeader('Correlation-ID', correlationId);
  next();
}
```

---

## Fase 4: Storage com SQLite (15 min)

SQLite foi escolhido no lugar de PostgreSQL por ser suficiente para o escopo do desafio: persiste dados entre restarts, é transacional (ACID), e não exige nenhum serviço adicional. O código usa uma **interface** para facilitar a troca por PostgreSQL futuramente.

### 4.1 src/storage/ITransactionStore.ts

```typescript
import { Transaction, TransactionState } from '../types';

// Interface que desacopla a lógica de negócio do storage concreto.
// Trocar SQLite por PostgreSQL = implementar esta interface + atualizar a injeção.
export interface ITransactionStore {
  create(nsu: string, terminalId: string, amount: number): Transaction;
  findById(transactionId: string): Transaction | null;
  findByNsuAndTerminal(nsu: string, terminalId: string): Transaction | null;
  updateState(transactionId: string, newState: TransactionState): Transaction;
}
```

### 4.2 src/storage/SqliteTransactionStore.ts

```typescript
import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Transaction, TransactionState } from '../types';
import { ITransactionStore } from './ITransactionStore';

// better-sqlite3 é síncrono — sem callbacks, sem Promises.
// Simples, rápido, e correto para um processo único.
export class SqliteTransactionStore implements ITransactionStore {
  private db: Database.Database;

  constructor(dbPath: string = process.env.DATABASE_PATH || './data/transactions.db') {
    // Garante que o diretório existe antes de abrir o arquivo
    const dir = path.dirname(dbPath);
    require('fs').mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');   // Write-Ahead Logging: melhor concorrência
    this.db.pragma('foreign_keys = ON');

    this.migrate();
  }

  // Schema criado na inicialização — sem script externo necessário
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id              TEXT PRIMARY KEY,
        nsu             TEXT NOT NULL,
        terminal_id     TEXT NOT NULL,
        amount          REAL NOT NULL,
        state           TEXT NOT NULL CHECK(state IN ('AUTHORIZED','CONFIRMED','VOIDED')),
        external_api_id TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Índice ÚNICO garante idempotência no nível do banco (não só na aplicação)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_nsu
        ON transactions (terminal_id, nsu);
    `);
  }

  create(nsu: string, terminalId: string, amount: number): Transaction {
    const id = uuidv4().toUpperCase();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO transactions (id, nsu, terminal_id, amount, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'AUTHORIZED', ?, ?)
    `).run(id, nsu, terminalId, amount, now, now);

    return this.findById(id)!;
  }

  findById(transactionId: string): Transaction | null {
    const row = this.db.prepare(
      'SELECT * FROM transactions WHERE id = ?'
    ).get(transactionId) as any;

    return row ? this.toTransaction(row) : null;
  }

  findByNsuAndTerminal(nsu: string, terminalId: string): Transaction | null {
    const row = this.db.prepare(
      'SELECT * FROM transactions WHERE terminal_id = ? AND nsu = ?'
    ).get(terminalId, nsu) as any;

    return row ? this.toTransaction(row) : null;
  }

  updateState(transactionId: string, newState: TransactionState): Transaction {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE transactions
      SET state = ?, updated_at = ?
      WHERE id = ?
    `).run(newState, now, transactionId);

    if (result.changes === 0) throw new Error(`Transaction not found: ${transactionId}`);
    return this.findById(transactionId)!;
  }

  private toTransaction(row: any): Transaction {
    return {
      id: row.id,
      nsu: row.nsu,
      terminalId: row.terminal_id,
      amount: row.amount,
      state: row.state as TransactionState,
      externalApiId: row.external_api_id ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const transactionStore: ITransactionStore = new SqliteTransactionStore();
```

---

## Fase 5: Resiliência (Circuit Breaker + Retry) (30 min)

### 5.1 src/resilience/circuitBreaker.ts

```typescript
import { logger } from '../logger';

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  
  constructor(
    readonly failureThreshold: number = 5,
    readonly successThreshold: number = 2,
    readonly openTimeout: number = 30000
  ) {}
  
  getState() {
    return this.state;
  }
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.openTimeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        logger.info('Circuit breaker transitioned to HALF_OPEN', {
          cbState: 'HALF_OPEN',
          openDuration: elapsed
        });
      } else {
        throw new CircuitBreakerOpenError('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
  
  private onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        logger.info('Circuit breaker CLOSED (recovered)');
      }
    }
  }
  
  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state !== 'OPEN' && this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.warn('Circuit breaker OPENED', {
        cbState: 'OPEN',
        failureCount: this.failureCount
      });
    }
  }
}
```

### 5.2 src/resilience/retryPolicy.ts

```typescript
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }
  
  throw lastError || new Error('Unknown error during retry');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 5.3 src/resilience/timeout.ts

```typescript
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new TimeoutError(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}
```

### 5.4 src/resilience/bulkhead.ts

Requisito obrigatório do desafio: limitar chamadas simultâneas à API externa para proteger recursos locais (sockets, event loop, memória).

```typescript
import { logger } from '../logger';

export class BulkheadError extends Error {
  constructor(max: number) {
    super(`Bulkhead limit reached: max ${max} concurrent external calls`);
    this.name = 'BulkheadError';
  }
}

export class Bulkhead {
  private active = 0;

  constructor(
    private readonly maxConcurrent: number = 10
  ) {}

  async call<T>(fn: () => Promise<T>, correlationId?: string): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      logger.warn('Bulkhead limit reached', {
        correlationId,
        active: this.active,
        max: this.maxConcurrent
      });
      throw new BulkheadError(this.maxConcurrent);
    }

    this.active++;
    logger.info('Bulkhead: call started', { correlationId, active: this.active });

    try {
      return await fn();
    } finally {
      this.active--;
      logger.info('Bulkhead: call finished', { correlationId, active: this.active });
    }
  }
}
```

---

## Fase 6: Serviços (20 min)

### 6.1 src/services/transactionService.ts

```typescript
import { Transaction, AuthorizeRequest } from '../types';
import { transactionStore } from '../storage/SqliteTransactionStore';
import { logger } from '../logger';

export class TransactionService {
  async authorize(req: AuthorizeRequest, correlationId: string): Promise<Transaction> {
    const { nsu, terminalId, amount } = req;
    
    // Lookup idempotência
    const existing = transactionStore.findByNsuAndTerminal(nsu, terminalId);
    if (existing) {
      logger.info('Transaction already exists (idempotency)', {
        correlationId,
        transactionId: existing.id,
        nsu,
        terminalId
      });
      return existing;
    }
    
    // Criar nova transação
    const transaction = transactionStore.create(nsu, terminalId, amount);
    logger.info('Transaction authorized', {
      correlationId,
      transactionId: transaction.id,
      nsu,
      amount
    });
    
    return transaction;
  }
  
  findById(transactionId: string): Transaction {
    const transaction = transactionStore.findById(transactionId);
    if (!transaction) {
      const err = new Error(`Transaction not found: ${transactionId}`);
      (err as any).statusCode = 404;
      throw err;
    }
    return transaction;
  }
  
  updateState(transactionId: string, newState: 'CONFIRMED' | 'VOIDED'): Transaction {
    const transaction = transactionStore.updateState(transactionId, newState);
    logger.info('Transaction state updated', {
      transactionId,
      newState,
      oldState: transaction.state
    });
    return transaction;
  }
}

export const transactionService = new TransactionService();
```

### 6.2 src/services/externalApiService.ts

```typescript
import { config } from '../config';
import { logger } from '../logger';

export class ExternalApiService {
  async authorize(nsu: string, amount: number, terminalId: string, correlationId: string) {
    return this.call(`${config.EXTERNAL_API_URL}/authorize`, {
      nsu,
      amount,
      terminalId
    }, correlationId);
  }
  
  async confirm(transactionId: string, correlationId: string) {
    return this.call(`${config.EXTERNAL_API_URL}/confirm`, {
      transactionId
    }, correlationId);
  }
  
  async void(transactionId: string, correlationId: string) {
    return this.call(`${config.EXTERNAL_API_URL}/void`, {
      transactionId
    }, correlationId);
  }
  
  private async call(url: string, body: any, correlationId: string) {
    logger.info('External API call', {
      correlationId,
      url,
      body
    });
    
    // Simular sucesso (em produção: usar fetch)
    return { success: true, message: 'Success' };
  }
}

export const externalApiService = new ExternalApiService();
```

### 6.3 src/services/resilienceService.ts

```typescript
import { CircuitBreaker } from '../resilience/circuitBreaker';
import { Bulkhead } from '../resilience/bulkhead';
import { retryWithBackoff } from '../resilience/retryPolicy';
import { withTimeout } from '../resilience/timeout';
import { externalApiService } from './externalApiService';
import { config } from '../config';
import { logger } from '../logger';

export class ResilienceService {
  // Bulkhead: proteção de recursos locais — máx 10 chamadas simultâneas
  private bulkhead = new Bulkhead(10);

  // Circuit Breaker: falha rápida quando API externa está degradada
  private circuitBreaker = new CircuitBreaker(
    config.CIRCUIT_BREAKER_THRESHOLD,   // 5 falhas → OPEN
    2,                                   // 2 sucessos em HALF_OPEN → CLOSED
    config.CIRCUIT_BREAKER_TIMEOUT_MS   // 30s em OPEN → tenta HALF_OPEN
  );

  async callAuthorize(nsu: string, amount: number, terminalId: string, correlationId: string) {
    return this.protect(
      () => externalApiService.authorize(nsu, amount, terminalId, correlationId),
      'authorize',
      correlationId
    );
  }

  async callConfirm(transactionId: string, correlationId: string) {
    return this.protect(
      () => externalApiService.confirm(transactionId, correlationId),
      'confirm',
      correlationId
    );
  }

  async callVoid(transactionId: string, correlationId: string) {
    return this.protect(
      () => externalApiService.void(transactionId, correlationId),
      'void',
      correlationId
    );
  }

  // Cadeia: Bulkhead → CircuitBreaker → Retry → Timeout
  private async protect(fn: () => Promise<any>, operation: string, correlationId: string) {
    try {
      return await this.bulkhead.call(async () => {
        return await this.circuitBreaker.call(async () => {
          return await retryWithBackoff(
            () => withTimeout(fn(), config.EXTERNAL_API_TIMEOUT_MS),
            config.RETRY_MAX_ATTEMPTS,
            config.RETRY_BASE_DELAY_MS
          );
        });
      }, correlationId);
    } catch (err) {
      logger.error(`External API call failed: ${operation}`, {
        correlationId,
        error: (err as Error).message,
        cbState: this.circuitBreaker.getState()
      });
      throw err;
    }
  }
}

export const resilienceService = new ResilienceService();
```

---

## Fase 7: Rotas (20 min)

### 7.1 src/routes/transactions.ts

```typescript
import { Router, Response } from 'express';
import { SecureRequest } from '../middleware/security';
import { transactionService } from '../services/transactionService';
import { resilienceService } from '../services/resilienceService';
import { AuthorizeRequest, ConfirmRequest, VoidRequest } from '../types';
import { logger } from '../logger';

const router = Router();

router.post('/authorize', async (req: SecureRequest, res: Response) => {
  try {
    const body: AuthorizeRequest = req.body;
    const { nsu, amount, terminalId } = body;
    
    // Validar payload
    if (!nsu || amount === undefined || !terminalId) {
      return res.status(400).json({ error: 'invalid_request', message: 'Missing required fields' });
    }
    
    // Autorizar
    const transaction = await transactionService.authorize(body, req.correlationId);
    
    // Chamar API externa (com proteção)
    try {
      await resilienceService.callAuthorize(nsu, amount, terminalId, req.correlationId);
    } catch (err) {
      logger.error('Failed to call external API during authorize', {
        correlationId: req.correlationId,
        error: (err as Error).message
      });
      return res.status(503).json({
        error: 'external_api_failure',
        message: 'Failed to authorize transaction',
        correlationId: req.correlationId
      });
    }
    
    return res.status(200).json({
      nsu: transaction.nsu,
      terminalId: transaction.terminalId,
      amount: transaction.amount,
      transactionId: transaction.id,
      status: transaction.state
    });
  } catch (err) {
    const error = err as any;
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      error: 'internal_error',
      message: error.message
    });
  }
});

router.post('/confirm', async (req: SecureRequest, res: Response) => {
  try {
    const body: ConfirmRequest = req.body;
    const { transactionId } = body;
    
    if (!transactionId) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    
    // Validar transação existe
    const transaction = transactionService.findById(transactionId);
    if (transaction.state === 'CONFIRMED') {
      logger.info('Transaction already confirmed', {
        correlationId: req.correlationId,
        transactionId
      });
      return res.status(204).send();
    }
    
    // Chamar API externa
    try {
      await resilienceService.callConfirm(transactionId, req.correlationId);
    } catch (err) {
      logger.error('Failed to call external API during confirm', {
        correlationId: req.correlationId,
        error: (err as Error).message
      });
      return res.status(503).json({
        error: 'external_api_failure',
        message: 'Failed to confirm transaction'
      });
    }
    
    // Atualizar estado
    transactionService.updateState(transactionId, 'CONFIRMED');
    
    return res.status(204).send();
  } catch (err) {
    const error = err as any;
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: 'internal_error' });
  }
});

router.post('/void', async (req: SecureRequest, res: Response) => {
  try {
    const body: VoidRequest = req.body;
    const { transactionId, nsu, terminalId } = body;
    
    // Validar que temum dos dois formatos
    if (!transactionId && (!nsu || !terminalId)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    
    let txId: string;
    if (transactionId) {
      txId = transactionId;
    } else {
      const transaction = transactionService.findByNsuAndTerminal(nsu!, terminalId!);
      txId = transaction?.id || '';
    }
    
    if (!txId) {
      return res.status(404).json({ error: 'transaction_not_found' });
    }
    
    const transaction = transactionService.findById(txId);
    if (transaction.state === 'VOIDED') {
      logger.info('Transaction already voided', {
        correlationId: req.correlationId,
        transactionId: txId
      });
      return res.status(204).send();
    }
    
    // Chamar API externa
    try {
      await resilienceService.callVoid(txId, req.correlationId);
    } catch (err) {
      logger.error('Failed to call external API during void', {
        correlationId: req.correlationId,
        error: (err as Error).message
      });
      return res.status(503).json({
        error: 'external_api_failure',
        message: 'Failed to void transaction'
      });
    }
    
    // Atualizar estado
    transactionService.updateState(txId, 'VOIDED');
    
    return res.status(204).send();
  } catch (err) {
    const error = err as any;
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: 'internal_error' });
  }
});

export default router;
```

---

## Fase 8: Express App Setup (10 min)

> **⚠️ Nota Express v5 (v5.2.1)**: A versão disponível via npm é a v5.x (não mais a v4).
> Diferenças relevantes para este projeto:
> - Erros em rotas `async` são propagados automaticamente para o error handler (try/catch ainda funciona normalmente)
> - `res.json()` retorna uma Promise — não há necessidade de await, pois o código abaixo não encadeia `.then()`
> - O padrão de error handler com 4 parâmetros `(err, req, res, next)` continua idêntico
> - O código desta Fase é **totalmente compatível** com Express v5

### 8.1 src/app.ts

```typescript
import * as express from 'express';
import cors = require('cors');
import { correlationMiddleware } from './middleware/correlation';
import { validateSignature, validateTimestamp } from './middleware/security';
import { errorHandler } from './middleware/errorHandler';
import transactionRoutes from './routes/transactions';

// Factory — returns a configured Express app instance.
// Using a factory (not a singleton) lets tests create isolated instances.
export function createApp(): express.Express {
  const app = express();

  // Capture raw body bytes for HMAC validation (must precede JSON parsing)
  app.use(express.raw({ type: 'application/json' }));
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction): void => {
    const raw = req.body;
    if (raw instanceof Buffer) {
      req.rawBody = raw.length > 0 ? raw.toString('utf8') : '';
      req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
    } else {
      req.rawBody = '';
      if (req.body === undefined) req.body = {};
    }
    next();
  });

  app.use(cors());

  // Security middleware (correlation ID first so rejections carry a correlationId)
  app.use(correlationMiddleware);
  app.use(validateSignature);
  app.use(validateTimestamp);

  // Business routes
  app.use('/v1/pos/transactions', transactionRoutes);

  // Health check — no security headers required
  app.get('/health', (_req: express.Request, res: express.Response): void => {
    res.status(200).json({ status: 'ok' });
  });

  // Global error handler — must be last
  app.use(errorHandler);

  return app;
}
```

### 8.2 src/index.ts

```typescript
import app from './app';
import { config } from './config';
import { logger } from './logger';

const server = app.listen(config.PORT, () => {
  logger.info('Server started', {
    port: config.PORT,
    environment: config.NODE_ENV
  });
});

process.on('SIGINT', () => {
  logger.info('Shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});
```

---

## Fase 9: Teste & Empacotar (15 min)

### 9.1 .env.example

```env
PORT=3000
NODE_ENV=development

SHARED_SECRET=dev-secret-key-change-in-production
TIMESTAMP_MAX_AGE_SEC=300

EXTERNAL_API_TIMEOUT_MS=5000
RETRY_MAX_ATTEMPTS=3
RETRY_BASE_DELAY_MS=1000
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_TIMEOUT_MS=30000

EXTERNAL_API_URL=http://localhost:4000
```

### 9.2 Build & Run

```bash
npm install
npm run build
npm start
```

### 9.3 Testar

```bash
# Health check
curl http://localhost:3000/health

# Autorizar
BODY='{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}'
SECRET="dev-secret-key"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d "$BODY"
```

### 9.4 Empacotar

```bash
# Criar .zip
zip -r pos-transaction-api.zip \
  src/ \
  dist/ \
  package.json \
  package-lock.json \
  tsconfig.json \
  .env.example \
  README.md \
  ARQUITETURA.md \
  API_SPEC.md \
  RESILIENCIA.md \
  SEGURANCA.md \
  IMPLEMENTACAO.md

# Enviar por email
```

---

## Checklist Final

- [ ] Todos os arquivos criados e compiláveis
- [ ] `npm run build` sem erros
- [ ] `npm start` inicia servidor em porta 3000
- [ ] GET /health retorna 200
- [ ] POST /authorize funciona com signature válida
- [ ] POST /authorize retorna 401 com signature inválida
- [ ] POST /confirm funciona
- [ ] POST /void funciona (ambas formas)
- [ ] Idempotência testada (replay retorna mesmo transactionId)
- [ ] Circuit breaker testado (simule falha da API externa)
- [ ] README documentado com exemplos
- [ ] .zip criado e pronto para enviar
