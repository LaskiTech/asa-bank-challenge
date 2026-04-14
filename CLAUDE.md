# CLAUDE.md — ASA Bank: Desafio API de Transações POS

## O que é este projeto

API intermediária para terminais POS (ponto de venda). Atua como "man-in-the-middle orquestradora": recebe requisições dos terminais, valida segurança, garante idempotência, aplica resiliência e repassa para a API externa de autorização.

Fluxo:
```
Terminal POS → [API Interna: HMAC + Idempotência + Bulkhead + CB + Retry + Timeout] → API Externa
```

Três operações: `POST /authorize` → `POST /confirm` → `POST /void`

---

## Stack & Versões

| Componente | Versão |
|------------|--------|
| Node.js | 22 LTS (v22.22.0) |
| npm | 10.9.4 |
| TypeScript | 5.x |
| Express | v5.x (v5.2.1) — não v4 |
| better-sqlite3 | última estável (driver síncrono) |
| uuid | v11 |

**Express v5 — diferenças que importam:**
- Erros em rotas `async` propagam automaticamente para o error handler (não precisam de `.catch(next)`)
- `res.json()` retorna uma Promise — não fazer `.then()` no retorno, o código atual não encadeia
- O pattern de error handler `(err, req, res, next)` continua idêntico ao v4

---

## Comandos

```bash
# Desenvolvimento
npm run dev        # ts-node direto
npm run watch      # nodemon com hot-reload

# Build & produção
npm run build      # tsc → dist/
npm start          # node dist/index.js

# Docker
docker compose up -d        # sobe a API
docker compose logs -f api  # logs em tempo real
docker compose down         # para tudo
```

---

## Estrutura de arquivos

```
src/
├── index.ts                     # Entry point (listen + graceful shutdown)
├── app.ts                       # Express setup + middlewares
├── types.ts                     # Interfaces TypeScript
├── config.ts                    # Env vars com defaults
├── logger.ts                    # Logger JSON estruturado
├── routes/
│   └── transactions.ts          # /v1/pos/transactions/authorize|confirm|void
├── services/
│   ├── transactionService.ts    # Business logic (idempotência, state machine)
│   ├── externalApiService.ts    # Chamadas à API externa (mock por enquanto)
│   └── resilienceService.ts     # Orquestra a cadeia de proteção
├── middleware/
│   ├── security.ts              # HMAC SHA-256 + X-Timestamp
│   ├── correlation.ts           # Correlation-ID gerado/propagado
│   └── errorHandler.ts          # Error handler global Express
├── storage/
│   ├── ITransactionStore.ts     # Interface (desacopla storage concreto)
│   └── SqliteTransactionStore.ts # Implementação SQLite
└── resilience/
    ├── circuitBreaker.ts        # CLOSED → OPEN → HALF_OPEN
    ├── retryPolicy.ts           # Backoff exponencial
    ├── timeout.ts               # AbortController / Promise.race
    └── bulkhead.ts              # Limite de concorrência
data/
└── transactions.db              # SQLite — criado automaticamente na inicialização
```

---

## Decisões arquiteturais — não reverter sem motivo

### Storage: SQLite via `better-sqlite3` (driver síncrono)
- **Por quê:** Sem serviços externos, sem Docker obrigatório, persiste entre restarts, transacional (ACID)
- **Limitação documentada:** Não adequado para múltiplos pods simultâneos (contenção de lock em NFS)
- **Caminho para produção:** Implementar `PostgresTransactionStore` seguindo `ITransactionStore` — troca de um arquivo, nada mais muda
- Usar WAL mode: `db.pragma('journal_mode = WAL')`
- Auto-migrate no construtor do `SqliteTransactionStore` — sem scripts externos de SQL

### Idempotência em duas camadas
1. **Por `(terminalId, nsu)`** — para `/authorize`: índice UNIQUE no SQLite garante no nível do banco, não só na aplicação
2. **Por `transactionId`** — para `/confirm` e `/void`: verificar estado antes de chamar API externa

### Cadeia de resiliência (ordem obrigatória)
```
Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → ExternalAPI
```
- Bulkhead primeiro: evita acúmulo de Promises mesmo com CB CLOSED
- CircuitBreaker segundo: falha rápida quando API está degradada
- Retry com backoff: `1s → 2s → 4s` (máx 3 tentativas)
- Timeout por tentativa: 5s (não timeout total)
- **Não fazer retry em 4xx** — são erros do cliente

### Circuit Breaker
- 5 falhas consecutivas → OPEN
- 30s em OPEN → HALF_OPEN (testa 1 requisição)
- 2 sucessos em HALF_OPEN → CLOSED
- Retorna `503` com `{ "error": "circuit_breaker_open" }` quando OPEN
- **Limitação documentada:** por processo (sem sincronização entre pods) — em produção usar Redis

### Segurança
- `X-Signature`: HMAC SHA-256 do body raw com `SHARED_SECRET`
- `X-Timestamp`: ISO-8601, aceitar ±5min (300s). Rejeitar com 401 se fora da janela
- `Correlation-ID`: header opcional. Se ausente, gerar UUID v4. Retornar sempre no response

---

## Padrões de código

### Logging
Todo log deve ser JSON estruturado com `correlationId`:
```typescript
logger.info('Transaction authorized', {
  correlationId,
  transactionId: transaction.id,
  nsu,
  amount
});
```

### Erros com statusCode
Erros de negócio devem ter `statusCode` na instância para o error handler pegar:
```typescript
const err = new Error('Transaction not found');
(err as any).statusCode = 404;
throw err;
```

### Express v5 async routes
Sem `.catch(next)` — Express v5 captura automaticamente:
```typescript
router.post('/authorize', async (req, res) => {
  // se lançar, vai direto pro error handler
});
```

---

## Variáveis de ambiente

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

## Endpoints

| Método | Path | Sucesso | Idempotente |
|--------|------|---------|-------------|
| POST | `/v1/pos/transactions/authorize` | 200 com body JSON | Sim — retorna mesmo `transactionId` |
| POST | `/v1/pos/transactions/confirm` | 204 sem body | Sim — 204 se já CONFIRMED |
| POST | `/v1/pos/transactions/void` | 204 sem body | Sim — 204 se já VOIDED |
| GET | `/health` | 200 `{"status":"ok"}` | — |

**Transições de estado:**
```
AUTHORIZED → CONFIRMED (via /confirm)
AUTHORIZED → VOIDED    (via /void)
CONFIRMED  → VOIDED    (via /void)
Qualquer → mesmo estado = 204 (sem efeitos colaterais)
VOIDED → qualquer = 409 Conflict (exceto VOIDED → VOIDED = 204)
```

---

## Docker

Arquivo: `Dockerfile` (multi-stage) + `docker-compose.yml` (single service)

Volume do SQLite: `./data:/app/data` — o arquivo `transactions.db` persiste no host

```bash
# Build e sobe
docker compose up --build -d

# Ver logs
docker compose logs -f api

# Entrar no container
docker compose exec api sh
```

---

## Testes manuais (cURL)

```bash
# Health
curl http://localhost:3000/health

# Authorize (gera signature automaticamente)
BODY='{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}'
SECRET="dev-secret-key"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d "$BODY"

# Esperado: 200 OK com transactionId
# Replay da mesma requisição: 200 OK com MESMO transactionId (idempotência)
# Signature errada: 401 Unauthorized
```

---

## Documentação de referência

| Arquivo | Conteúdo |
|---------|----------|
| `SOLUCAO_API_POS.md` | Visão geral e checklist |
| `ARQUITETURA.md` | Fluxos, modelo de dados, decisões de design |
| `API_SPEC.md` | Contratos de request/response |
| `SEGURANCA.md` | HMAC, timestamp, implementação de middleware |
| `RESILIENCIA.md` | Timeout, retry, circuit breaker, bulkhead |
| `IMPLEMENTACAO.md` | Guia fase-a-fase com código completo |
| `DOCKER.md` | Configuração Docker e persistência SQLite |

---

## Contexto do desafio

Este é um processo seletivo. O avaliador vai verificar especificamente:
1. Idempotência correta (mesmo ID para replay)
2. HMAC SHA-256 funcionando
3. Circuit Breaker com os 3 estados
4. Bulkhead (requisito obrigatório citado explicitamente no PDF)
5. Documentação das limitações conhecidas (SQLite multi-pod)
6. Resposta 503 com JSON estruturado quando CB está OPEN
