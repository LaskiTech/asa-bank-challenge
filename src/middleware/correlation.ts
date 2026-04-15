import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

// Global augmentation — correlationId is set on every request by this middleware
// before any route handler or error handler runs.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

/**
 * Injects a Correlation-ID into every request.
 *
 * - Accepts `Correlation-ID` from the incoming header if present (lets callers
 *   trace a request end-to-end across service boundaries).
 * - Generates a fresh UUID v4 when the header is absent.
 * - Always echoes the value back in the `Correlation-ID` response header.
 *
 * Must be registered FIRST in the middleware stack so that all downstream
 * middleware and route handlers can rely on `req.correlationId` being set.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['correlation-id'];
  const correlationId = (typeof incoming === 'string' && incoming.length > 0)
    ? incoming
    : uuidv4();

  req.correlationId = correlationId;
  res.setHeader('Correlation-ID', correlationId);

  next();
}
