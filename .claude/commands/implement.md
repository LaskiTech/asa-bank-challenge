Look at the current state of `src/` (it may not exist yet). Based on the file structure in CLAUDE.md and the specs in `docs/`, determine the next unbuilt layer and implement it fully.

Build order (do not skip layers):
1. Foundation — `src/config.ts`, `src/types.ts`, `src/logger.ts`
2. Storage — `src/storage/ITransactionStore.ts`, `src/storage/SqliteTransactionStore.ts`
3. Middleware — `src/middleware/correlation.ts`, `src/middleware/security.ts`, `src/middleware/errorHandler.ts`
4. Resilience — `src/resilience/bulkhead.ts`, `src/resilience/circuitBreaker.ts`, `src/resilience/retryPolicy.ts`, `src/resilience/timeout.ts`
5. Services — `src/services/externalApiService.ts`, `src/services/transactionService.ts`, `src/services/resilienceService.ts`
6. Routes — `src/routes/transactions.ts`
7. App wiring — `src/app.ts`, `src/index.ts`

Before writing any file: read `docs/IMPLEMENTACAO.md` for code examples and `docs/ARQUITETURA.md` for design decisions. Follow all patterns in CLAUDE.md strictly (structured logging with correlationId, error statusCode pattern, Express v5 async routes, resilience chain order).

If $ARGUMENTS is specified, implement that specific module instead of the next in order.
