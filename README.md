# API de Transações POS

## Pré-requisitos

| Requisito | Versão mínima | Observação |
|---|---|---|
| **Node.js** | 20 LTS | Runtime da aplicação |
| **npm** | 10+ | Gerenciador de pacotes (vem com o Node) |
| **TypeScript** | 5+ | Instalado via `npm install` (devDependency) |
| **Docker** | 24+ | Necessário apenas para rodar via Docker Compose |
| **Docker Compose** | 2.x (`compose` plugin) | Orquestra a API + mock juntos |

> Para rodar localmente sem Docker, basta Node.js + npm. O banco SQLite é criado automaticamente em `./data/transactions.db`.

---

Middleware orquestrador para transações de terminais POS. Recebe requisições dos terminais, valida a segurança, garante idempotência, aplica uma cadeia de resiliência e repassa para uma API externa de autorização.

```
Terminal POS → [HMAC auth → Idempotência → Bulkhead → CircuitBreaker → Retry → Timeout] → API Externa
```

Três operações: `POST /authorize` → `POST /confirm` → `POST /void`

---

## Como rodar

### Docker (recomendado)

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f api
```

O banco SQLite é persistido em `./data/transactions.db` via volume. Nenhuma dependência externa é necessária — a API mock já sobe junto.

```bash
docker compose down       # parar
docker compose restart api  # reiniciar só a API
```

### Local (desenvolvimento)

```bash
npm install
cp .env.example .env
npm run dev        # ts-node direto em :3000
npm run watch      # nodemon com hot-reload
```

Build de produção:

```bash
npm run build   # compila para dist/
npm start       # node dist/index.js
```

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `NODE_ENV` | `development` | Ambiente |
| `SHARED_SECRET` | `dev-secret-key-change-in-production` | Chave HMAC compartilhada com o terminal |
| `TIMESTAMP_MAX_AGE_SEC` | `300` | Janela máxima de idade do request (anti-replay) |
| `DATABASE_PATH` | `./data/transactions.db` | Caminho do arquivo SQLite |
| `EXTERNAL_API_URL` | `http://mock-api:4000` | URL base da API externa de autorização |
| `EXTERNAL_API_TIMEOUT_MS` | `5000` | Timeout por tentativa (ms) |
| `RETRY_MAX_ATTEMPTS` | `3` | Número máximo de tentativas |
| `RETRY_BASE_DELAY_MS` | `1000` | Delay base do backoff exponencial (ms) |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Falhas consecutivas para abrir o circuit breaker |
| `CIRCUIT_BREAKER_TIMEOUT_MS` | `30000` | Tempo em OPEN antes de tentar HALF_OPEN (ms) |
| `BULKHEAD_MAX_CONCURRENT` | `10` | Máximo de chamadas simultâneas à API externa |

---

## Contratos da API

### `GET /health`

Não requer headers de segurança.

```bash
curl http://localhost:3000/health
# {"status":"ok","circuitBreaker":"CLOSED","bulkhead":{"active":0,"max":10}}
```

### Autenticação (todos os endpoints de transação)

Todo request de mutação exige dois headers:

```bash
BODY='{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}'
SECRET="dev-secret-key-change-in-production"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
```

### `POST /v1/pos/transactions/authorize`

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d "$BODY"
```

**Response 200 OK:**
```json
{
  "nsu": "123456",
  "amount": 199.90,
  "terminalId": "T-1000",
  "transactionId": "01HZX...ABC",
  "status": "AUTHORIZED"
}
```

Replay com o mesmo `(terminalId + nsu)` retorna **200 com o mesmo `transactionId`** — sem chamar a API externa novamente.

### `POST /v1/pos/transactions/confirm`

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/confirm \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d '{"transactionId":"01HZX...ABC"}'
# 204 No Content
```

Replay de um confirm já realizado retorna **204 sem efeitos colaterais**.

### `POST /v1/pos/transactions/void`

**Forma A — por transactionId:**

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/void \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d '{"transactionId":"01HZX...ABC"}'
# 204 No Content
```

**Forma B — por nsu + terminalId:**

```bash
curl -X POST http://localhost:3000/v1/pos/transactions/void \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d '{"nsu":"123456","terminalId":"T-1000"}'
# 204 No Content
```

### Códigos de erro

| Status | `error` | Situação |
|---|---|---|
| `400` | `invalid_request` | Campo obrigatório ausente ou inválido |
| `401` | `unauthorized` | Assinatura HMAC inválida ou timestamp fora da janela |
| `404` | `not_found` | `transactionId` não encontrado |
| `409` | `invalid_transaction_state` | Transição de estado inválida (ex.: confirmar uma transação já anulada) |
| `503` | `circuit_breaker_open` | Circuit breaker aberto — API externa degradada |
| `503` | `bulkhead_full` | Limite de concorrência atingido |

---

## Segurança

### Assinatura HMAC-SHA256

Cada request deve incluir:

- **`X-Signature`**: `HMAC-SHA256(rawBody, SHARED_SECRET)` em hex. Validado com `crypto.timingSafeEqual` para prevenir ataques de timing oracle.
- **`X-Timestamp`**: timestamp ISO-8601. Janela aceita: `[-30s, +300s]` em relação ao horário do servidor. Impede replay attacks.

Um request com assinatura inválida ou timestamp fora da janela recebe **401 Unauthorized** imediatamente, antes de qualquer lógica de negócio.

### Correlation-ID

O header `Correlation-ID` é opcional no request. Se ausente, a API gera um UUID v4. O valor é retornado no response header e aparece em todas as linhas de log — permitindo rastrear um request de ponta a ponta.

---

## Resiliência — Anti-cascade

A API depende de uma API externa. Para evitar que falhas dessa dependência derrubem este serviço, toda chamada externa passa pela seguinte cadeia de proteção:

```
Bulkhead → CircuitBreaker → retryWithBackoff → withTimeout → API Externa
```

### O que abre e fecha o Circuit Breaker

O circuit breaker opera em três estados:

```
CLOSED ──(5 falhas consecutivas)──▶ OPEN ──(30s)──▶ HALF_OPEN ──(2 sucessos)──▶ CLOSED
                                                                └──(qualquer falha)──▶ OPEN
```

**Sinais que contam como falha** (incrementam o contador):
- Timeout esgotado após 5 s por tentativa
- API externa retornou 5xx
- Erro de rede (ECONNREFUSED, DNS failure)

**Sinais que não contam como falha** (não incrementam):
- Erros 4xx — são erros do cliente, não da dependência
- Rejeição pelo bulkhead — o circuit breaker nem chega a ser consultado

**Quando o breaker está OPEN:**
- A chamada é rejeitada imediatamente, sem I/O
- Retorna `503 { "error": "circuit_breaker_open" }`
- Após 30 s passa para HALF_OPEN e testa 1 requisição real

### Como o retry storm é evitado

Um retry sem controle pode transformar uma falha pontual em uma tempestade de requests que sobrecarrega ainda mais a dependência. Dois mecanismos evitam isso:

**1. Backoff exponencial com limite de tentativas**

```
Tentativa 1 → falha → aguarda 1 s
Tentativa 2 → falha → aguarda 2 s
Tentativa 3 → falha → encerra (máximo 3 tentativas)
```

Erros 4xx não são retentados — são falhas do cliente e retentar não ajudaria.

**2. Circuit Breaker interrompe o ciclo**

Após 5 falhas consecutivas o circuit breaker abre e os requests seguintes são rejeitados antes de chegar ao retry — sem nenhuma chamada à API externa. O serviço degradado ganha tempo para se recuperar.

### Como recursos locais são protegidos (Bulkhead)

Mesmo com circuit breaker fechado, se a API externa estiver lenta (e não falhando), múltiplos requests concorrentes podem se acumular — cada um ocupando memória, sockets e timers enquanto aguarda o timeout de 5 s.

O **Bulkhead** limita a 10 o número de chamadas externas simultâneas. O 11º request é rejeitado imediatamente com `503 bulkhead_full` antes de alocar qualquer recurso. Sem esse limite, uma dependência lenta poderia acumular centenas de Promises pendentes e degradar o processo inteiro.

### Comportamento com Circuit Breaker aberto

```bash
# Circuit breaker OPEN → resposta imediata, sem retry, sem I/O externo
HTTP 503
{
  "error": "circuit_breaker_open",
  "message": "External authorization service is temporarily unavailable. Please retry after 30 seconds.",
  "correlationId": "..."
}
```

O terminal deve aguardar e retentar após o intervalo indicado. A idempotência garante que retentar o mesmo request não duplica a transação.

---

## Arquitetura

### Máquina de estados

```
AUTHORIZED ──▶ CONFIRMED   (/confirm)
AUTHORIZED ──▶ VOIDED      (/void)
CONFIRMED  ──▶ VOIDED      (/void)
Qualquer   ──▶ mesmo estado → 204 (sem efeitos colaterais)
VOIDED     ──▶ qualquer outro → 409 Conflict
```

### Camadas

```
┌──────────────────────────────────────────────────────────┐
│  HTTP            routes/transactions.ts                  │
│                  middleware/{security, correlation,       │
│                  errorHandler}.ts                        │
├──────────────────────────────────────────────────────────┤
│  Negócio         services/transactionService.ts          │
│  Orquestração    services/resilienceService.ts           │
│  Cliente HTTP    services/externalApiService.ts          │
├──────────────────────────────────────────────────────────┤
│  Resiliência     resilience/{circuitBreaker, retryPolicy,│
│                  timeout, bulkhead}.ts                   │
├──────────────────────────────────────────────────────────┤
│  Persistência    storage/ITransactionStore.ts  (interface)
│                  storage/SqliteTransactionStore.ts       │
└──────────────────────────────────────────────────────────┘
```

Cada camada conhece apenas a camada imediatamente abaixo, via interface. `ExternalApiService` não sabe que existe retry; `ResilienceService` não sabe que existe HTTP; `SqliteTransactionStore` é a única classe que conhece SQL.

### Idempotência em dois níveis

| Operação | Mecanismo | Onde é garantido |
|---|---|---|
| `/authorize` | `UNIQUE INDEX (terminal_id, nsu)` no SQLite | Banco de dados — sobrevive a múltiplos pods |
| `/confirm`, `/void` | Verificação de estado antes de chamar a API externa | Aplicação — dentro da transação de leitura |

### Persistência

SQLite via `better-sqlite3` (driver síncrono), com WAL mode habilitado. O schema é migrado automaticamente no startup — nenhum script externo necessário.

Para trocar por PostgreSQL em produção: implementar `ITransactionStore` (`src/storage/ITransactionStore.ts`). Nenhuma outra linha muda.

---

## Limitações conhecidas e caminho para produção

### Circuit Breaker por processo

O estado do circuit breaker fica em memória no processo. Em um ambiente com múltiplos pods, cada instância tem seu próprio contador — um pod pode estar com o breaker OPEN enquanto outro ainda aceita requests.

**Solução em produção:** substituir o estado em memória por um contador compartilhado no Redis. A interface `CircuitBreaker` pode ser reimplementada sem alterar a cadeia de resiliência.

### SQLite e múltiplos pods

O índice UNIQUE no SQLite garante idempotência dentro de um único processo. Em múltiplos pods apontando para o mesmo arquivo NFS pode haver lock contention.

**Solução em produção:** implementar `PostgresTransactionStore`. A constraint UNIQUE na tabela garante a mesma semântica com suporte nativo a múltiplas conexões.

### Observabilidade

O projeto emite logs estruturados em JSON com `correlationId`, `level`, `timestamp` e metadados de contexto — compatível com qualquer agregador de logs (Datadog, CloudWatch, ELK). A evolução natural é instrumentar com OpenTelemetry para gerar spans distribuídos, mantendo o `correlationId` como `trace_id`.

---

## Convenções de código

| Convenção | Aplicação | Exemplo |
|---|---|---|
| `camelCase` | Variáveis, parâmetros, propriedades | `transactionId`, `correlationId` |
| `PascalCase` | Classes e tipos | `CircuitBreaker`, `AuthorizeRequest` |
| Prefixo `I` | Interfaces | `ITransactionStore` |
| `camelCase` | Arquivos de módulos e serviços | `transactionService.ts`, `circuitBreaker.ts` |
| `PascalCase` | Arquivos de classes concretas | `SqliteTransactionStore.ts` |
| `snake_case` | Error codes nas respostas HTTP | `circuit_breaker_open`, `bulkhead_full` |

