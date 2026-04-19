import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../core/config';
import { logger } from '../core/logger';

// Global augmentation — rawBody is set by the body-capture middleware in app.ts
// before validateSignature runs.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody: string;
    }
  }
}

/**
 * Convenience alias used by route handlers that want to be explicit about
 * requiring both correlationId (from correlation middleware) and rawBody
 * (from body-capture middleware). At runtime it is identical to `Request`.
 */
export type SecureRequest = Request;

// Only validate security headers on state-mutating HTTP methods.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Maximum clock-skew tolerance for future-dated timestamps.
// Prevents 401s caused by minor server/client clock differences.
const FUTURE_TOLERANCE_SEC = 30;

// ---------------------------------------------------------------------------
// HMAC SHA-256 signature validation
// ---------------------------------------------------------------------------

/**
 * Validates the `X-Signature` header against HMAC-SHA256(rawBody, SHARED_SECRET).
 *
 * Security notes:
 * - Signs the raw request bytes, not the parsed JSON object, to prevent
 *   canonicalization attacks (e.g. key reordering in JSON serialization).
 * - Uses `crypto.timingSafeEqual` to avoid timing-based signature oracle attacks.
 */
export function validateSignature(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const provided = req.headers['x-signature'];

  if (!provided || typeof provided !== 'string') {
    res.status(401).json({
      error: 'missing_signature',
      message: 'X-Signature header is required',
    });
    return;
  }

  const expected = createHmac('sha256', config.SHARED_SECRET)
    .update(req.rawBody)
    .digest('hex');

  // SHA-256 hex is always 64 chars — lengths always match for valid signatures.
  // timingSafeEqual would throw on length mismatch, so we catch defensively.
  let valid = false;
  try {
    valid = timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn('Signature validation failed', {
      correlationId: req.correlationId,
      method: req.method,
      path: req.path,
    });
    res.status(401).json({
      error: 'invalid_signature',
      message: 'X-Signature does not match payload',
    });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Timestamp (replay-attack) validation
// ---------------------------------------------------------------------------

/**
 * Validates the `X-Timestamp` header to guard against replay attacks.
 *
 * Acceptance window:
 *   [-FUTURE_TOLERANCE_SEC, TIMESTAMP_MAX_AGE_SEC]
 *
 * A negative age means the client's clock is ahead of the server — we allow up
 * to 30 s of forward skew to handle minor NTP drift.  Requests older than
 * TIMESTAMP_MAX_AGE_SEC (default 300 s) are rejected outright.
 *
 * Note: idempotency at the storage layer means a valid replay within the window
 * returns the same transactionId without calling the external API again.
 */
export function validateTimestamp(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const header = req.headers['x-timestamp'];

  if (!header || typeof header !== 'string') {
    res.status(401).json({
      error: 'missing_timestamp',
      message: 'X-Timestamp header is required',
    });
    return;
  }

  const clientMs = new Date(header).getTime();

  if (isNaN(clientMs)) {
    res.status(401).json({
      error: 'invalid_timestamp',
      message: 'X-Timestamp must be a valid ISO-8601 date (e.g. 2024-01-01T10:00:00Z)',
    });
    return;
  }

  const ageSec = (Date.now() - clientMs) / 1000;

  if (ageSec < -FUTURE_TOLERANCE_SEC || ageSec > config.TIMESTAMP_MAX_AGE_SEC) {
    logger.warn('Timestamp rejected', {
      correlationId: req.correlationId,
      ageSec: parseFloat(ageSec.toFixed(2)),
      maxAgeSec: config.TIMESTAMP_MAX_AGE_SEC,
      futureTolerance: FUTURE_TOLERANCE_SEC,
    });
    res.status(401).json({
      error: 'timestamp_out_of_range',
      message: `Request age is ${ageSec.toFixed(1)}s; allowed window is [-${FUTURE_TOLERANCE_SEC}s, +${config.TIMESTAMP_MAX_AGE_SEC}s]`,
    });
    return;
  }

  next();
}
