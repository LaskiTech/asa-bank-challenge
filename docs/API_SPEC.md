# API_SPEC.md - Especificação de Endpoints

## Autenticação & Segurança

Todas as requisições **devem** incluir:

```http
X-Signature: HMAC-SHA256(body, secret)
X-Timestamp: ISO-8601 timestamp (ex: 2024-04-14T10:30:00Z)
Correlation-ID: uuid (gerado pelo cliente ou injetado pela API)
Content-Type: application/json
```

**Validação de Signature:**
```
signature = HMAC_SHA256(JSON.stringify(request_body), SHARED_SECRET)
header_signature = request.headers['X-Signature']
if (signature !== header_signature) return 401 Unauthorized
```

**Validação de Timestamp:**
```
timestamp_diff = now() - ISO8601_parse(X-Timestamp)
if (Math.abs(timestamp_diff) > 5 minutes) return 401 Unauthorized
```

---

## 1️⃣ POST `/v1/pos/transactions/authorize`

**Descrição**: Autoriza uma transação com a API externa. Gera um `transactionId` único.

### Request Body

```json
{
  "nsu": "123456",
  "amount": 199.90,
  "terminalId": "T-1000"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `nsu` | string | ✅ | Identificador da transação no terminal (até 12 chars) |
| `amount` | number | ✅ | Valor em decimal (ex: 199.90) |
| `terminalId` | string | ✅ | Identificador do terminal (ex: "T-1000") |

### Comportamento Esperado

1. **Validar** signature (X-Signature) e timestamp (X-Timestamp)
2. **Idempotência**: Se existe transação com `(terminalId, nsu)` já persistida:
   - Retornar 200 com o `transactionId` existente (sem chamar API externa novamente)
3. **Se não existe**:
   - Gerar `transactionId` único (UUID v7 ou similar, nunca se repetir mesmo com múltiplos pods)
   - Chamar API externa `/authorize` com `(nsu, amount, terminalId)`
   - Persistir transação no estado `AUTHORIZED`
   - Armazenar mapeamento: `(terminalId, nsu) → transactionId`
4. **Em caso de sucesso**: retornar 200 com payload
5. **Em caso de falha da API externa**: aplicar retry + circuit breaker, retornar erro apropriado (5xx se esgotados retries)

### Response (200 OK)

```json
{
  "nsu": "123456",
  "amount": 199.90,
  "terminalId": "T-1000",
  "transactionId": "01HZX1A2B3C4D5E6F7G8H9I0J",
  "status": "AUTHORIZED"
}
```

### Response (400 Bad Request)

```json
{
  "error": "invalid_signature",
  "message": "X-Signature header mismatch"
}
```

### Response (401 Unauthorized)

```json
{
  "error": "signature_expired",
  "message": "X-Timestamp is older than 5 minutes"
}
```

### Response (5xx - API Externa falhou após retries)

```json
{
  "error": "external_api_failure",
  "message": "Failed to authorize after 3 retries. Circuit breaker may be open.",
  "correlationId": "..."
}
```

---

## 2️⃣ POST `/v1/pos/transactions/confirm`

**Descrição**: Confirma uma transação já autorizada.

### Request Body

```json
{
  "transactionId": "01HZX1A2B3C4D5E6F7G8H9I0J"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `transactionId` | string | ✅ | ID retornado pelo endpoint `/authorize` |

### Comportamento Esperado

1. **Validar** signature e timestamp
2. **Localizar** a transação internamente pelo `transactionId`
   - Se não encontrada: retornar 404
3. **Idempotência**: Se já confirmada (status = `CONFIRMED`):
   - Retornar 204 No Content (sem chamar API externa novamente)
4. **Se status = `AUTHORIZED`**:
   - Chamar API externa `/confirm` com `transactionId`
   - Atualizar estado para `CONFIRMED`
   - Persistir mudança
   - Retornar 204 No Content
5. **Em falha da API externa**: retry + circuit breaker, retornar 5xx se esgotado

### Response (204 No Content)

Sem corpo.

### Response (404 Not Found)

```json
{
  "error": "transaction_not_found",
  "message": "Transaction with ID 01HZX1A2B3C4D5E6F7G8H9I0J not found"
}
```

### Response (409 Conflict)

```json
{
  "error": "invalid_transaction_state",
  "message": "Transaction is in VOIDED state, cannot confirm"
}
```

---

## 3️⃣ POST `/v1/pos/transactions/void`

**Descrição**: Desfaz (void) uma transação. Suporta duas formas de identificação.

### Request Body - Forma A (por transactionId)

```json
{
  "transactionId": "01HZX1A2B3C4D5E6F7G8H9I0J"
}
```

### Request Body - Forma B (por nsu + terminalId)

```json
{
  "nsu": "123456",
  "terminalId": "T-1000"
}
```

| Campo | Tipo | Obrigatório* | Descrição |
|-------|------|--------------|-----------|
| `transactionId` | string | ✅ ou nsu+terminalId | Usar Forma A |
| `nsu` | string | ✅ ou transactionId | Identificador terminal (Forma B) |
| `terminalId` | string | ✅ ou transactionId | ID do terminal (Forma B) |

*Deve enviar OU `transactionId` OU `(nsu + terminalId)`

### Comportamento Esperado

1. **Validar** signature e timestamp
2. **Localizar** transação:
   - Se `transactionId` fornecido: lookup direto
   - Se `nsu + terminalId` fornecido: usar mapeamento `(terminalId, nsu) → transactionId`
3. **Idempotência**: Se já void (status = `VOIDED`):
   - Retornar 204 No Content
4. **Se status = `AUTHORIZED` ou `CONFIRMED`**:
   - Chamar API externa `/void` com `transactionId`
   - Atualizar estado para `VOIDED`
   - Persistir mudança
   - Retornar 204 No Content
5. **Em falha da API externa**: retry + circuit breaker

### Response (204 No Content)

Sem corpo.

### Response (404 Not Found)

```json
{
  "error": "transaction_not_found",
  "message": "No transaction found for nsu=123456, terminalId=T-1000"
}
```

---

## API Externa (Mock/Simulação)

Sua API interna deve chamar uma API externa hipotética. **Você pode implementar como um Mock** (sem realmente funcionar).

### Mock Endpoints Esperados

**POST /authorize** (chamada interna)
```json
Request:
{
  "nsu": "123456",
  "amount": 199.90,
  "terminalId": "T-1000"
}

Response (200):
{
  "success": true,
  "message": "Transaction authorized"
}
```

**POST /confirm**
```json
Request:
{
  "transactionId": "01HZX..."
}

Response (200):
{
  "success": true,
  "message": "Transaction confirmed"
}
```

**POST /void**
```json
Request:
{
  "transactionId": "01HZX..."
}

Response (200):
{
  "success": true,
  "message": "Transaction voided"
}
```

**Possíveis respostas de erro (para simular falhas)**:
```json
Response (503):
{
  "error": "service_unavailable",
  "message": "External API is down"
}
```

---

## Status Codes Resumo

| Código | Cenário |
|--------|---------|
| 200 | Autorização bem-sucedida, retorna `transactionId` |
| 204 | Confirmação ou void bem-sucedido |
| 400 | Validação de payload falhou |
| 401 | Signature inválida ou timestamp expirado |
| 404 | Transação não encontrada |
| 409 | Conflito de estado (ex: confirmar transação void) |
| 429 | Rate limit excedido (throttling) |
| 503 | API externa indisponível (após retries) |
| 500 | Erro interno do servidor |

---

## Exemplo: Fluxo Completo

### Request 1: Autorizar
```bash
curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: <hmac-sha256>" \
  -H "X-Timestamp: 2024-04-14T10:30:00Z" \
  -H "Correlation-ID: uuid-123" \
  -d '{
    "nsu": "123456",
    "amount": 199.90,
    "terminalId": "T-1000"
  }'
```

Response:
```json
{
  "nsu": "123456",
  "amount": 199.90,
  "terminalId": "T-1000",
  "transactionId": "01HZX1A2B3C4D5E6F7G8H9I0J",
  "status": "AUTHORIZED"
}
```

### Request 2: Confirmar
```bash
curl -X POST http://localhost:3000/v1/pos/transactions/confirm \
  -H "Content-Type: application/json" \
  -H "X-Signature: <hmac-sha256>" \
  -H "X-Timestamp: 2024-04-14T10:30:05Z" \
  -H "Correlation-ID: uuid-123" \
  -d '{
    "transactionId": "01HZX1A2B3C4D5E6F7G8H9I0J"
  }'
```

Response: 204 No Content

### Request 3: Fazer void
```bash
curl -X POST http://localhost:3000/v1/pos/transactions/void \
  -H "Content-Type: application/json" \
  -H "X-Signature: <hmac-sha256>" \
  -H "X-Timestamp: 2024-04-14T10:30:10Z" \
  -H "Correlation-ID: uuid-123" \
  -d '{
    "nsu": "123456",
    "terminalId": "T-1000"
  }'
```

Response: 204 No Content
