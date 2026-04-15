import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Global Express error handler
// ---------------------------------------------------------------------------
// Must have exactly 4 parameters so Express recognises it as an error handler.
// Registered last in app.ts after all routes.
//
// Error shape convention (from CLAUDE.md):
//   const err = new Error('Transaction not found');
//   (err as any).statusCode = 404;
//   (err as any).errorCode = 'transaction_not_found';   // optional
//   throw err;
//
// Express v5: async errors in route handlers propagate here automatically.
// ---------------------------------------------------------------------------

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // If the response has already started streaming, delegate to Express's
  // default error handler — we cannot send a new response at this point.
  if (res.headersSent) {
    _next(err);
    return;
  }

  // JSON parse errors from express.raw() / manual JSON.parse in app.ts
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    return;
  }

  // Extract statusCode and errorCode from the thrown object
  const error = err as Record<string, unknown>;
  const statusCode = typeof error['statusCode'] === 'number' ? error['statusCode'] : 500;
  const errorCode = typeof error['errorCode'] === 'string' ? error['errorCode'] : 'internal_error';
  const message = err instanceof Error ? err.message : 'An unexpected error occurred';

  const logPayload: Record<string, unknown> = {
    correlationId: req.correlationId,
    statusCode,
    errorCode,
    message,
    method: req.method,
    path: req.path,
  };

  if (statusCode >= 500) {
    if (err instanceof Error && err.stack !== undefined) {
      logPayload['stack'] = err.stack;
    }
    logger.error('Unhandled server error', logPayload);
  } else {
    logger.warn('Request rejected', logPayload);
  }

  res.status(statusCode).json({
    error: errorCode,
    message,
    correlationId: req.correlationId,
  });
}
