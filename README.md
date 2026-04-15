# POS Transaction API

Orchestrating middleware for POS terminal transactions. Receives requests from
terminals, validates security, enforces idempotency, applies a resilience chain,
and forwards to an external authorization API.

```
POS Terminal → [HMAC auth → Idempotency → Bulkhead → CircuitBreaker → Retry → Timeout] → External API
```

Three operations: `POST /authorize` → `POST /confirm` → `POST /void`

---

## Setup

```bash
npm install
cp .env.example .env   # edit SHARED_SECRET for non-dev environments
npm run dev            # ts-node hot-start on :3000
```

For hot-reload during development:

```bash
npm run watch
```

Build and run compiled output:

```bash
npm run build
npm start
```

---

## Docker

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f api
docker compose down
```

The SQLite database is persisted in `./data/transactions.db` via a volume mount.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | Environment name |
| `SHARED_SECRET` | `dev-secret-key-change-in-production` | HMAC signing key |
| `TIMESTAMP_MAX_AGE_SEC` | `300` | Max request age in seconds (replay protection) |
| `DATABASE_PATH` | `./data/transactions.db` | SQLite file path |
| `EXTERNAL_API_URL` | `http://localhost:4000` | Authorization API base URL |
| `EXTERNAL_API_TIMEOUT_MS` | `5000` | Per-attempt timeout (ms) |
| `RETRY_MAX_ATTEMPTS` | `3` | Max retry attempts |
| `RETRY_BASE_DELAY_MS` | `1000` | Base backoff delay (doubles each retry) |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before OPEN |
| `CIRCUIT_BREAKER_TIMEOUT_MS` | `30000` | Time in OPEN before HALF_OPEN attempt |
| `BULKHEAD_MAX_CONCURRENT` | `10` | Max simultaneous external API calls |

---

## API

### `GET /health`

No security headers required.

```bash
curl http://localhost:3000/health
# {"status":"ok","circuitBreaker":"CLOSED","bulkhead":{"active":0,"max":10}}
```

### `POST /v1/pos/transactions/authorize`

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
# {"nsu":"123456","amount":199.9,"terminalId":"T-1000","transactionId":"...","status":"AUTHORIZED"}

# Replay with the same body → same transactionId (idempotent)
```

### `POST /v1/pos/transactions/confirm`

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/confirm \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d '{"transactionId":"<id from authorize>"}'
# 204 No Content
```

### `POST /v1/pos/transactions/void`

Form A — by transactionId:

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/void \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d '{"transactionId":"<id>"}'
# 204 No Content
```

Form B — by nsu + terminalId:

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/void \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d '{"nsu":"123456","terminalId":"T-1000"}'
# 204 No Content
```

---

## Security

Every state-mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) requires:

- **`X-Signature`**: `HMAC-SHA256(rawBody, SHARED_SECRET)` hex-encoded.
  Validated with `crypto.timingSafeEqual` to prevent timing oracle attacks.
- **`X-Timestamp`**: ISO-8601 timestamp. Accepted window: `[-30s, +300s]` from server
  time. Prevents replay attacks.
- **`Correlation-ID`** (optional): UUID echoed in the response header and all log lines.
  Generated automatically if absent.

---

## Architecture

### Resilience chain

```
Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → ExternalAPI
```

- **Bulkhead** (max 10 concurrent): prevents Promise accumulation even when CB is CLOSED
- **Circuit Breaker** (5 failures → OPEN, 30 s → HALF_OPEN, 2 successes → CLOSED): fast-fails when API is degraded
- **Retry** (3 attempts, 1 s / 2 s / 4 s backoff): handles transient failures; skips 4xx
- **Timeout** (5 s per attempt): keeps each individual call bounded

### State machine

```
AUTHORIZED → CONFIRMED   (via /confirm)
AUTHORIZED → VOIDED      (via /void)
CONFIRMED  → VOIDED      (via /void)
Any        → same state  → 204 (no side effects, idempotent)
VOIDED     → any other   → 409 Conflict
```

### Storage

SQLite via `better-sqlite3` (synchronous). A UNIQUE index on `(terminal_id, nsu)`
enforces idempotency at the database level for `/authorize`. To swap to PostgreSQL,
implement `ITransactionStore` (`src/storage/ITransactionStore.ts`) — nothing else changes.

---

## Reference docs

| File | Content |
|---|---|
| `docs/ARQUITETURA.md` | Flows, data model, design decisions |
| `docs/API_SPEC.md` | Request/response contracts |
| `docs/SEGURANCA.md` | HMAC, timestamp, middleware |
| `docs/RESILIENCIA.md` | Timeout, retry, circuit breaker, bulkhead |
| `docs/IMPLEMENTACAO.md` | Phase-by-phase guide with code examples |
| `docs/DOCKER.md` | Docker configuration and SQLite persistence |
