// Load .env variables into process.env BEFORE any other module is imported.
// config.ts reads process.env at import time, so dotenv must run first.
// With TypeScript's CommonJS output, static imports are converted to require()
// calls in source order — placing this import first guarantees it runs before
// config.ts is evaluated.
import 'dotenv/config';

// OpenTelemetry must be initialised before Express and http are required so
// that the auto-instrumentations can patch them at load time.
import './telemetry';

import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info('Server started', {
    port: config.PORT,
    nodeEnv: config.NODE_ENV,
    externalApiUrl: config.EXTERNAL_API_URL,
    databasePath: config.DATABASE_PATH,
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// On SIGTERM (Docker stop, Kubernetes pod eviction) or SIGINT (Ctrl-C):
//   1. Stop accepting new connections.
//   2. Wait for in-flight requests to finish.
//   3. Exit 0.
//
// A hard timeout forces exit if shutdown takes too long (e.g., a hung
// long-polling request).  .unref() prevents the timeout itself from keeping
// the process alive if everything else finishes first.
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  logger.info('Shutdown signal received', { signal });

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit', { signal });
    process.exit(1);
  }, 10_000).unref();

  server.close(() => {
    clearTimeout(forceExit);
    logger.info('HTTP server closed — exiting cleanly', { signal });
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Safety nets
//
// unhandledRejection: log but keep running — a single unhandled async error
//   should not bring down the whole server.
// uncaughtException: log and exit — the process is in an unknown state.
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting', {
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
