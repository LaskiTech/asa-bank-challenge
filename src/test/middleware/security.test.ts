import { createHmac } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { validateSignature, validateTimestamp } from '../../middleware/security';

// Use the same secret that setup.ts injects into process.env
const SECRET = 'test-secret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function isoNow(offsetSec = 0): string {
  return new Date(Date.now() + offsetSec * 1000).toISOString();
}

type MockRes = {
  status: jest.Mock;
  json: jest.Mock;
};

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    headers: {},
    rawBody: '',
    correlationId: 'test-cid',
    path: '/test',
    ...overrides,
  } as unknown as Request;
}

function makeRes(): MockRes & Response {
  const res = {} as MockRes & Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ---------------------------------------------------------------------------
// validateSignature
// ---------------------------------------------------------------------------

describe('validateSignature — métodos não-mutantes', () => {
  it('ignora GET (chama next sem validar)', () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateSignature(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('validateSignature — header ausente', () => {
  it('retorna 401 quando X-Signature não é enviado', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_signature' }));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('validateSignature — assinatura inválida', () => {
  it('retorna 401 para assinatura errada', () => {
    const body = '{"nsu":"1"}';
    const req = makeReq({
      rawBody: body,
      headers: { 'x-signature': 'wrong-signature' },
    });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_signature' }));
  });
});

describe('validateSignature — assinatura válida', () => {
  it('chama next() com a assinatura correta', () => {
    const body = '{"nsu":"123","amount":10,"terminalId":"T-1"}';
    const req = makeReq({
      rawBody: body,
      headers: { 'x-signature': sign(body) },
    });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateSignature(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejeita se o body mudou após a assinatura (canonicalization)', () => {
    const signed = '{"nsu":"123"}';
    const actual = '{"nsu":"123","extra":"injected"}';
    const req = makeReq({
      rawBody: actual,
      headers: { 'x-signature': sign(signed) },
    });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateSignature(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// validateTimestamp
// ---------------------------------------------------------------------------

describe('validateTimestamp — header ausente', () => {
  it('retorna 401 quando X-Timestamp não é enviado', () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'missing_timestamp' }));
  });
});

describe('validateTimestamp — formato inválido', () => {
  it('retorna 401 para timestamp não-ISO', () => {
    const req = makeReq({ headers: { 'x-timestamp': 'not-a-date' } });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_timestamp' }));
  });
});

describe('validateTimestamp — janela de tempo', () => {
  it('aceita timestamp atual', () => {
    const req = makeReq({ headers: { 'x-timestamp': isoNow() } });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('aceita timestamp levemente no futuro (dentro da tolerância de 30s)', () => {
    // +20s = 20s no futuro → ageSec ≈ -20 → dentro de [-30, 300] → válido
    const req = makeReq({ headers: { 'x-timestamp': isoNow(+20) } });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejeita timestamp no futuro além de 30s', () => {
    // +60s = 60s no futuro → ageSec ≈ -60 → abaixo de -30 → rejeitado
    const req = makeReq({ headers: { 'x-timestamp': isoNow(+60) } });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'timestamp_out_of_range' }));
  });

  it('rejeita timestamp expirado (> 300s)', () => {
    const req = makeReq({ headers: { 'x-timestamp': isoNow(-400) } });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'timestamp_out_of_range' }));
  });

  it('ignora GET (não valida timestamp)', () => {
    const req = makeReq({ method: 'GET', headers: {} });
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    validateTimestamp(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
