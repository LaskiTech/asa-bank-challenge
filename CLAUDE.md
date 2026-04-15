# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

POS transaction API — an orchestrating middleware ("man-in-the-middle") that receives requests from POS terminals, validates security, enforces idempotency, applies resilience, and forwards to an external authorization API.

```
POS Terminal → [HMAC auth → Idempotency → Bulkhead → CircuitBreaker → Retry → Timeout] → External API
```

Three operations: `POST /authorize` → `POST /confirm` → `POST /void`

**Status:** Spec and architecture docs are complete. The `src/` directory has not been created yet — implementation is the remaining work.

---

## Setup before first run

The `package.json` currently has no build scripts. Add these to `scripts`:

```json
"dev": "ts-node src/index.ts",
"watch": "nodemon --exec ts-node src/index.ts --ext ts",
"build": "tsc",
"start": "node dist/index.js"
```

The `tsconfig.json` needs these changes before `tsc` will work:

```json
"rootDir": "./src",
"outDir": "./dist",
"types": ["node"],   // replace the empty []
// remove "jsx": "react-jsx"  — this is a Node.js API, not React
```

---

## Commands

```bash
npm run dev        # ts-node direct
npm run watch      # nodemon hot-reload
npm run build      # tsc → dist/
npm start          # node dist/index.js

docker compose up -d
docker compose logs -f api
docker compose down
```

---

## File structure to create

```
src/
├── index.ts                      # Entry point + graceful shutdown
├── app.ts                        # Express setup + middleware registration
├── types.ts                      # TypeScript interfaces
├── config.ts                     # Env vars with defaults
├── logger.ts                     # Structured JSON logger
├── routes/transactions.ts        # /v1/pos/transactions/authorize|confirm|void
├── services/
│   ├── transactionService.ts     # Business logic, idempotency, state machine
│   ├── externalApiService.ts     # Calls to external API (mock for now)
│   └── resilienceService.ts      # Orchestrates the protection chain
├── middleware/
│   ├── security.ts               # HMAC SHA-256 + X-Timestamp validation
│   ├── correlation.ts            # Correlation-ID generation/propagation
│   └── errorHandler.ts           # Global Express error handler
├── storage/
│   ├── ITransactionStore.ts      # Interface (decouples concrete storage)
│   └── SqliteTransactionStore.ts # SQLite implementation
└── resilience/
    ├── circuitBreaker.ts         # CLOSED → OPEN → HALF_OPEN
    ├── retryPolicy.ts            # Exponential backoff
    ├── timeout.ts                # AbortController / Promise.race
    └── bulkhead.ts               # Concurrency limiter
```

---

## Architectural decisions — do not revert without reason

### Storage: SQLite via `better-sqlite3` (synchronous driver)
- No external services, persists between restarts, ACID transactional
- WAL mode: `db.pragma('journal_mode = WAL')`
- Auto-migrate in `SqliteTransactionStore` constructor — no external SQL scripts
- **Known limitation:** Not suitable for multiple simultaneous pods (NFS lock contention)
- **Path to production:** Implement `PostgresTransactionStore` implementing `ITransactionStore` — one file swap, nothing else changes

### Two-layer idempotency
1. **By `(terminalId, nsu)`** — for `/authorize`: UNIQUE index in SQLite enforces at the DB level
2. **By `transactionId`** — for `/confirm` and `/void`: check state before calling external API

### Resilience chain order (mandatory)
```
Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → ExternalAPI
```
- Bulkhead first: prevents Promise accumulation even when CB is CLOSED
- CircuitBreaker second: fast-fail when API is degraded
- Retry with backoff: `1s → 2s → 4s` (max 3 attempts)
- Timeout per attempt: 5s (not total timeout)
- **No retry on 4xx** — client errors are not transient

### Circuit Breaker
- 5 consecutive failures → OPEN
- 30s in OPEN → HALF_OPEN (tests 1 request)
- 2 successes in HALF_OPEN → CLOSED
- Returns `503` with `{ "error": "circuit_breaker_open" }` when OPEN
- **Known limitation:** per-process (no sync between pods) — use Redis in production

### Security
- `X-Signature`: HMAC SHA-256 of raw body with `SHARED_SECRET`
- `X-Timestamp`: ISO-8601, accept ±5min (300s). Reject with 401 if outside window
- `Correlation-ID`: optional header. Generate UUID v4 if absent. Always return in response

---

## Code patterns

### Express v5 async routes
No `.catch(next)` needed — Express v5 propagates automatically:
```typescript
router.post('/authorize', async (req, res) => {
  // thrown errors go directly to error handler
});
```

### Business errors
```typescript
const err = new Error('Transaction not found');
(err as any).statusCode = 404;
throw err;
```

### Structured logging with correlationId
```typescript
logger.info('Transaction authorized', { correlationId, transactionId, nsu, amount });
```

---

## Environment variables

```env
PORT=3000
NODE_ENV=development
SHARED_SECRET=dev-secret-key-change-in-production
TIMESTAMP_MAX_AGE_SEC=300
DATABASE_PATH=./data/transactions.db
EXTERNAL_API_TIMEOUT_MS=5000
RETRY_MAX_ATTEMPTS=3
RETRY_BASE_DELAY_MS=1000
CIRCUIT_BREAKER_THRESHOLD=5
CIRCUIT_BREAKER_TIMEOUT_MS=30000
EXTERNAL_API_URL=http://localhost:4000
```

---

## Endpoints and state machine

| Method | Path | Success | Idempotent |
|--------|------|---------|------------|
| POST | `/v1/pos/transactions/authorize` | 200 with JSON body | Yes — returns same `transactionId` |
| POST | `/v1/pos/transactions/confirm` | 204 no body | Yes — 204 if already CONFIRMED |
| POST | `/v1/pos/transactions/void` | 204 no body | Yes — 204 if already VOIDED |
| GET | `/health` | 200 `{"status":"ok"}` | — |

```
AUTHORIZED → CONFIRMED (via /confirm)
AUTHORIZED → VOIDED    (via /void)
CONFIRMED  → VOIDED    (via /void)
Any → same state      = 204 (no side effects)
VOIDED → any other    = 409 Conflict
```

---

## Manual test (cURL)

```bash
BODY='{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}'
SECRET="dev-secret-key"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d "$BODY"
# Replay with same body → same transactionId (idempotency)
# Wrong signature → 401
```

---

## Reference docs

All spec/design docs live in `docs/`.

| File | Content |
|------|---------|
| `docs/ARQUITETURA.md` | Flows, data model, design decisions |
| `docs/API_SPEC.md` | Request/response contracts |
| `docs/SEGURANCA.md` | HMAC, timestamp, middleware implementation |
| `docs/RESILIENCIA.md` | Timeout, retry, circuit breaker, bulkhead |
| `docs/IMPLEMENTACAO.md` | Phase-by-phase guide with full code examples |
| `docs/DOCKER.md` | Docker configuration and SQLite persistence |

## Custom commands

| Command | What it does |
|---------|-------------|
| `/project:implement` | Implements the next unbuilt layer in order (reads `docs/IMPLEMENTACAO.md` first) |
| `/project:test` | Sets up Jest if needed and writes/runs tests for a given module |
| `/project:docker` | Builds and runs with Docker Compose (creates Dockerfile if missing) |
| `/project:new-file` | Creates a new source file wired into the right place |
