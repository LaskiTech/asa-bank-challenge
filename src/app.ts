import * as express from 'express';
import cors = require('cors');
import { correlationMiddleware } from './middleware/correlation';
import { validateSignature, validateTimestamp } from './middleware/security';
import { errorHandler } from './middleware/errorHandler';
import transactionRoutes from './routes/transactions';
import { resilienceService } from './services/resilienceService';
import { logger } from './core/logger';

// ---------------------------------------------------------------------------
// Factory — returns a configured Express application.
//
// Using a factory (rather than a module-level singleton) lets tests and the
// smoke scripts create isolated instances with injected dependencies.
// ---------------------------------------------------------------------------

export function createApp(): express.Express {
  const app = express();

  // ── Body capture ────────────────────────────────────────────────────────
  // express.raw() buffers the raw request bytes before any parsing happens.
  // This is essential: HMAC is computed over the exact bytes the client sent,
  // not over the re-serialised parsed object (JSON key order / whitespace could
  // differ after a parse → serialise round-trip).
  app.use(express.raw({ type: 'application/json' }));

  // Convert Buffer → req.rawBody (string for HMAC) + req.body (parsed JSON).
  // Must run immediately after express.raw() and before any route code.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction): void => {
    const raw = req.body;

    if (raw instanceof Buffer) {
      req.rawBody = raw.length > 0 ? raw.toString('utf8') : '';

      if (req.rawBody) {
        try {
          req.body = JSON.parse(req.rawBody) as unknown;
        } catch (err) {
          // Malformed JSON → let the error handler return 400.
          next(err);
          return;
        }
      } else {
        req.body = {};
      }
    } else {
      // GET / HEAD / OPTIONS / etc. — no body, set defaults.
      req.rawBody = '';
      if (req.body === undefined) req.body = {};
    }

    next();
  });

  // ── Cross-origin (dev / integration testing) ────────────────────────────
  app.use(cors());

  // ── Correlation ID ───────────────────────────────────────────────────────
  // Registered FIRST in the security chain so that rejection log lines from
  // validateSignature and validateTimestamp carry a correlationId.
  app.use(correlationMiddleware);

  // ── Security ─────────────────────────────────────────────────────────────
  app.use(validateSignature);
  app.use(validateTimestamp);

  // ── Business routes ───────────────────────────────────────────────────────
  app.use('/v1/pos/transactions', transactionRoutes);

  // ── Health check ──────────────────────────────────────────────────────────
  // Does NOT require security headers — allows load-balancer / orchestrator
  // probes to run without a shared secret.
  app.get('/health', (_req: express.Request, res: express.Response): void => {
    res.status(200).json({
      status: 'ok',
      circuitBreaker: resilienceService.getCircuitBreakerState(),
      bulkhead: resilienceService.getBulkheadStats(),
    });
  });

  // ── Global error handler ─────────────────────────────────────────────────
  // Must be the LAST middleware registered.  Express identifies error handlers
  // by their 4-parameter signature (err, req, res, next).
  app.use(errorHandler);

  logger.info('Express app configured');

  return app;
}
