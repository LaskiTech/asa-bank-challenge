/**
 * Endpoint integration tests — real in-memory SQLite, mocked external API.
 *
 * The external API service is mocked so tests don't depend on a running mock
 * server. The full middleware stack (HMAC, timestamp, idempotency, state
 * machine) runs against real SQLite (:memory:).
 */
import supertest = require('supertest');
const request = supertest;
import { createHmac } from 'crypto';
import { createApp } from '../../app';
import type { Express } from 'express';

// Mock the external API service before any module is loaded
jest.mock('../../services/externalApiService', () => ({
  externalApiService: {
    authorize: jest.fn().mockResolvedValue({ success: true, message: 'authorized' }),
    confirm: jest.fn().mockResolvedValue({ success: true, message: 'confirmed' }),
    void: jest.fn().mockResolvedValue({ success: true, message: 'voided' }),
  },
  ExternalApiService: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-secret';

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function validHeaders(body: string) {
  return {
    'Content-Type': 'application/json',
    'X-Signature': sign(body),
    'X-Timestamp': new Date().toISOString(),
  };
}

// Unique NSU per call to avoid idempotency collisions across tests
let nsuCounter = 0;
function nextNsu() { return `TST-${++nsuCounter}`; }

let app: Express;

beforeAll(() => {
  app = createApp();
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('retorna 200 sem autenticação', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.circuitBreaker).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /authorize
// ---------------------------------------------------------------------------

describe('POST /v1/pos/transactions/authorize', () => {
  it('retorna 200 com transactionId para nova transação', async () => {
    const body = JSON.stringify({ nsu: nextNsu(), amount: 99.9, terminalId: 'T-1' });
    const res = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set(validHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.transactionId).toBeTruthy();
    expect(res.body.status).toBe('AUTHORIZED');
  });

  it('idempotência — replay retorna o mesmo transactionId', async () => {
    const nsu = nextNsu();
    const body = JSON.stringify({ nsu, amount: 10, terminalId: 'T-1' });
    const first = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set(validHeaders(body))
      .send(body);
    const second = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set(validHeaders(body))
      .send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.transactionId).toBe(first.body.transactionId);
  });

  it('retorna 401 sem X-Signature', async () => {
    const body = JSON.stringify({ nsu: nextNsu(), amount: 10, terminalId: 'T-1' });
    const res = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set({ 'Content-Type': 'application/json', 'X-Timestamp': new Date().toISOString() })
      .send(body);
    expect(res.status).toBe(401);
  });

  it('retorna 400 para body inválido', async () => {
    const body = JSON.stringify({ nsu: nextNsu() }); // faltam amount e terminalId
    const res = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set(validHeaders(body))
      .send(body);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /confirm
// ---------------------------------------------------------------------------

describe('POST /v1/pos/transactions/confirm', () => {
  async function authorize(nsu: string) {
    const body = JSON.stringify({ nsu, amount: 1, terminalId: 'T-1' });
    const res = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set(validHeaders(body))
      .send(body);
    return res.body.transactionId as string;
  }

  it('retorna 204 para transação AUTHORIZED', async () => {
    const txId = await authorize(nextNsu());
    const body = JSON.stringify({ transactionId: txId });
    const res = await request(app)
      .post('/v1/pos/transactions/confirm')
      .set(validHeaders(body))
      .send(body);
    expect(res.status).toBe(204);
  });

  it('idempotência — confirm repetido retorna 204 sem efeitos colaterais', async () => {
    const txId = await authorize(nextNsu());
    const body = JSON.stringify({ transactionId: txId });
    await request(app).post('/v1/pos/transactions/confirm').set(validHeaders(body)).send(body);
    const second = await request(app)
      .post('/v1/pos/transactions/confirm')
      .set(validHeaders(body))
      .send(body);
    expect(second.status).toBe(204);
  });

  it('retorna 404 para transactionId inexistente', async () => {
    const body = JSON.stringify({ transactionId: 'DOES-NOT-EXIST' });
    const res = await request(app)
      .post('/v1/pos/transactions/confirm')
      .set(validHeaders(body))
      .send(body);
    expect(res.status).toBe(404);
  });

  it('retorna 409 ao tentar confirmar uma transação VOIDED', async () => {
    const txId = await authorize(nextNsu());

    // void primeiro
    const voidBody = JSON.stringify({ transactionId: txId });
    await request(app)
      .post('/v1/pos/transactions/void')
      .set(validHeaders(voidBody))
      .send(voidBody);

    // confirm após void → 409
    const confirmBody = JSON.stringify({ transactionId: txId });
    const res = await request(app)
      .post('/v1/pos/transactions/confirm')
      .set(validHeaders(confirmBody))
      .send(confirmBody);
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /void
// ---------------------------------------------------------------------------

describe('POST /v1/pos/transactions/void', () => {
  async function authorize(nsu: string): Promise<{ txId: string; nsu: string }> {
    const body = JSON.stringify({ nsu, amount: 1, terminalId: 'T-VOID' });
    const res = await request(app)
      .post('/v1/pos/transactions/authorize')
      .set(validHeaders(body))
      .send(body);
    return { txId: res.body.transactionId as string, nsu };
  }

  it('Forma A — void por transactionId retorna 204', async () => {
    const { txId } = await authorize(nextNsu());
    const body = JSON.stringify({ transactionId: txId });
    const res = await request(app)
      .post('/v1/pos/transactions/void')
      .set(validHeaders(body))
      .send(body);
    expect(res.status).toBe(204);
  });

  it('Forma B — void por nsu + terminalId retorna 204', async () => {
    const nsu = nextNsu();
    await authorize(nsu);
    const body = JSON.stringify({ nsu, terminalId: 'T-VOID' });
    const res = await request(app)
      .post('/v1/pos/transactions/void')
      .set(validHeaders(body))
      .send(body);
    expect(res.status).toBe(204);
  });

  it('idempotência — void repetido retorna 204', async () => {
    const { txId } = await authorize(nextNsu());
    const body = JSON.stringify({ transactionId: txId });
    await request(app).post('/v1/pos/transactions/void').set(validHeaders(body)).send(body);
    const second = await request(app)
      .post('/v1/pos/transactions/void')
      .set(validHeaders(body))
      .send(body);
    expect(second.status).toBe(204);
  });

  it('void de transação CONFIRMED também retorna 204', async () => {
    const { txId } = await authorize(nextNsu());
    const confirmBody = JSON.stringify({ transactionId: txId });
    await request(app)
      .post('/v1/pos/transactions/confirm')
      .set(validHeaders(confirmBody))
      .send(confirmBody);

    const voidBody = JSON.stringify({ transactionId: txId });
    const res = await request(app)
      .post('/v1/pos/transactions/void')
      .set(validHeaders(voidBody))
      .send(voidBody);
    expect(res.status).toBe(204);
  });
});
