import { Router, Request, Response } from 'express';
import { AuthorizeRequest, ConfirmRequest, VoidRequest } from '../types';
import { transactionService } from '../services/transactionService';
import { resilienceService } from '../services/resilienceService';
import { logger } from '../logger';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Throws a 400 error that Express v5 propagates to the global error handler.
 * Using `never` lets TypeScript treat callers as unreachable after this call.
 */
function badRequest(message: string): never {
  const err = new Error(message);
  (err as any).statusCode = 400;
  (err as any).errorCode = 'invalid_request';
  throw err;
}

// ---------------------------------------------------------------------------
// POST /authorize
//
// Behaviour (API_SPEC.md §1):
//   1. Validate payload.
//   2. Idempotency: if (terminalId, nsu) already exists → return 200 with the
//      existing transactionId WITHOUT calling the external API again.
//   3. New transaction: call external API → persist AUTHORIZED state → return 200.
// ---------------------------------------------------------------------------

router.post('/authorize', async (req: Request, res: Response) => {
  const body = req.body as Partial<AuthorizeRequest>;
  const { nsu, amount, terminalId } = body;

  if (!nsu || typeof nsu !== 'string') badRequest('nsu is required and must be a string');
  if (amount === undefined || amount === null || typeof amount !== 'number')
    badRequest('amount is required and must be a number');
  if (!terminalId || typeof terminalId !== 'string')
    badRequest('terminalId is required and must be a string');

  const { transaction, isNew } = transactionService.authorize(
    { nsu, amount, terminalId },
    req.correlationId,
  );

  if (isNew) {
    // Only call external API for new transactions.
    // If this throws (503, circuit_breaker_open, bulkhead_full …) Express v5
    // propagates it directly to errorHandler — no try/catch needed.
    logger.info('Calling external API for new authorize', {
      correlationId: req.correlationId,
      transactionId: transaction.id,
    });
    await resilienceService.callAuthorize(nsu, amount, terminalId, req.correlationId);
  }

  logger.info('Authorize complete', {
    correlationId: req.correlationId,
    transactionId: transaction.id,
    isNew,
  });

  res.status(200).json({
    nsu: transaction.nsu,
    amount: transaction.amount,
    terminalId: transaction.terminalId,
    transactionId: transaction.id,
    status: transaction.state,
  });
});

// ---------------------------------------------------------------------------
// POST /confirm
//
// Behaviour (API_SPEC.md §2):
//   - 404 if transactionId not found.
//   - 204 immediately if already CONFIRMED (idempotent).
//   - 409 if VOIDED (cannot confirm a voided transaction).
//   - AUTHORIZED → call external → update to CONFIRMED → 204.
// ---------------------------------------------------------------------------

router.post('/confirm', async (req: Request, res: Response) => {
  const body = req.body as Partial<ConfirmRequest>;
  const { transactionId } = body;

  if (!transactionId || typeof transactionId !== 'string')
    badRequest('transactionId is required and must be a string');

  const tx = transactionService.getById(transactionId, req.correlationId);

  // Idempotent — already in the target state, no side effects.
  if (tx.state === 'CONFIRMED') {
    logger.info('Confirm: already CONFIRMED, returning 204 (idempotent)', {
      correlationId: req.correlationId,
      transactionId,
    });
    res.status(204).send();
    return;
  }

  // Invalid transition — VOIDED transactions cannot be confirmed.
  if (tx.state === 'VOIDED') {
    const err = new Error(`Transaction ${transactionId} is VOIDED and cannot be confirmed`);
    (err as any).statusCode = 409;
    (err as any).errorCode = 'invalid_transaction_state';
    throw err;
  }

  // tx.state === 'AUTHORIZED' — valid, proceed.
  await resilienceService.callConfirm(transactionId, req.correlationId);
  transactionService.transition(tx, 'CONFIRMED', req.correlationId);

  logger.info('Confirm complete', { correlationId: req.correlationId, transactionId });
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// POST /void
//
// Behaviour (API_SPEC.md §3):
//   Accepts two request shapes:
//     Form A: { transactionId }
//     Form B: { nsu, terminalId }
//
//   - 404 if transaction not found.
//   - 204 immediately if already VOIDED (idempotent).
//   - AUTHORIZED or CONFIRMED → call external → update to VOIDED → 204.
//   (No 409 for void — both AUTHORIZED and CONFIRMED are valid sources.)
// ---------------------------------------------------------------------------

router.post('/void', async (req: Request, res: Response) => {
  const body = req.body as Partial<VoidRequest>;
  const { transactionId, nsu, terminalId } = body;

  const hasFormA = typeof transactionId === 'string' && transactionId.length > 0;
  const hasFormB =
    typeof nsu === 'string' && nsu.length > 0 &&
    typeof terminalId === 'string' && terminalId.length > 0;

  if (!hasFormA && !hasFormB) {
    badRequest('Provide transactionId (Form A) OR nsu + terminalId (Form B)');
  }

  // Lookup — getById / getByNsuAndTerminal throw 404 if not found.
  const tx = hasFormA
    ? transactionService.getById(transactionId!, req.correlationId)
    : transactionService.getByNsuAndTerminal(nsu!, terminalId!, req.correlationId);

  // Idempotent.
  if (tx.state === 'VOIDED') {
    logger.info('Void: already VOIDED, returning 204 (idempotent)', {
      correlationId: req.correlationId,
      transactionId: tx.id,
    });
    res.status(204).send();
    return;
  }

  // AUTHORIZED and CONFIRMED are both valid for void.
  await resilienceService.callVoid(tx.id, req.correlationId);
  transactionService.transition(tx, 'VOIDED', req.correlationId);

  logger.info('Void complete', { correlationId: req.correlationId, transactionId: tx.id });
  res.status(204).send();
});

export default router;
