# SEGURANCA.md - Autenticação, Integridade & Tracing

## Requisitos de Segurança

1. **Autenticação**: Verificar que o cliente é quem diz ser (via HMAC)
2. **Integridade**: Garantir que o payload não foi alterado em trânsito
3. **Replay Protection**: Evitar que um atacante reutilize uma requisição antiga
4. **Observabilidade**: Rastrear requisições through múltiplos componentes

---

## 1. HMAC SHA-256 (X-Signature)

**O quê**: Um "selo" criptográfico que prova que o cliente construiu o payload com a chave secreta compartilhada.

### Algoritmo

```typescript
import { createHmac } from 'crypto';

function generateSignature(body: any, secret: string): string {
  const bodyString = JSON.stringify(body);
  return createHmac('sha256', secret)
    .update(bodyString)
    .digest('hex');
}

// Cliente: gera signature antes de enviar
const body = { nsu: "123456", amount: 199.90, terminalId: "T-1000" };
const signature = generateSignature(body, SHARED_SECRET); // env var

// Headers
headers: {
  'X-Signature': signature,  // ex: a3f7e2d1c0b9a8f7e6d5c4b3a2f1e0d9
  'Content-Type': 'application/json'
}

// Servidor: valida signature
function validateSignature(body: any, headerSignature: string, secret: string): boolean {
  const expectedSignature = generateSignature(body, secret);
  return expectedSignature === headerSignature;
}

// Em middleware
app.use(express.json());
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const headerSig = req.headers['x-signature'];
    if (!headerSig) {
      return res.status(401).json({ error: 'x_signature_missing' });
    }
    
    if (!validateSignature(req.body, headerSig, process.env.SHARED_SECRET!)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
  }
  next();
});
```

### Impacto de Segurança

**Sem HMAC**:
```
Atacante intercepta:
  POST /authorize
  Body: { nsu: "123456", amount: 199.90, ... }
  
Atacante modifica:
  Body: { nsu: "123456", amount: 999999.99, ... }
  
Servidor aceita (sem validação) → Transação com valor errado! ✗
```

**Com HMAC**:
```
Cliente envia:
  X-Signature: a3f7e2d1c0b9a8f7e6d5c4b3a2f1e0d9  (gerado com payload original + secret)
  Body: { nsu: "123456", amount: 199.90, ... }

Atacante modifica:
  Body: { nsu: "123456", amount: 999999.99, ... }

Servidor valida:
  expectedSig = HMAC(novo body) = f1e2d3c4b5a6... (diferente!)
  if (expectedSig !== headerSig) → 401 Unauthorized ✓
```

---

## 2. X-Timestamp (Replay Protection)

**O quê**: Timestamp de quando o cliente construiu a requisição. Rejeitar requisições muito antigas.

```typescript
function validateTimestamp(headerTimestamp: string, maxAgeSec: number = 300): boolean {
  const clientTime = new Date(headerTimestamp).getTime();
  const serverTime = Date.now();
  const ageSec = (serverTime - clientTime) / 1000;
  
  if (isNaN(ageSec) || ageSec < 0) {
    // Timestamp do futuro ou inválido
    return false;
  }
  
  if (ageSec > maxAgeSec) {
    // Requisição muito antiga (default: 5 min)
    return false;
  }
  
  return true;
}

// Middleware
app.use((req, res, next) => {
  const timestamp = req.headers['x-timestamp'];
  if (!timestamp) {
    return res.status(401).json({ error: 'x_timestamp_missing' });
  }
  
  if (!validateTimestamp(timestamp as string, 300)) {
    return res.status(401).json({ error: 'timestamp_invalid_or_expired' });
  }
  
  next();
});
```

### Formato de Timestamp

```javascript
// ISO-8601 com segundos de precisão (ou milissegundos)
new Date().toISOString()  // "2024-04-14T10:30:00.123Z"
```

### Cenário: Replay Attack

```
T=10:30:00: Cliente envia
  X-Timestamp: 2024-04-14T10:30:00Z
  X-Signature: <valid>
  Body: { nsu: "123456", amount: 199.90, ... }
  → Servidor: 200 OK, transactionId gerado

T=10:32:00 (2min depois): Atacante captura & replays msg anterior
  X-Timestamp: 2024-04-14T10:30:00Z  (mesmo timestamp antigo!)
  X-Signature: <válida para aquele payload>
  Body: { nsu: "123456", amount: 199.90, ... }
  
Servidor valida:
  Age = 10:32:00 - 10:30:00 = 120 segundos > 300s?
  Não, ainda está dentro da janela.
  
  ✗ Problema: Ainda aceita! (mas a API interna tem idempotência!)
  → Lookup (terminalId, nsu) → encontra transactionId anterior
  → Retorna 200 com o mesmo transactionId (sem chamar API externa novamente)
  → Idempotência salva! ✓
```

**Nota**: A janela de 5 minutos é uma convenção. Você pode ajustar conforme necessário (default: 5min é razoável).

---

## 3. Correlation ID (OpenTelemetry/Tracing)

**O quê**: Um UUID único que identifica uma requisição através de múltiplos componentes (logs, spans).

```typescript
import { v4 as uuidv4 } from 'uuid';

// Middleware
app.use((req, res, next) => {
  const correlationId = req.headers['correlation-id'] as string || uuidv4();
  req.correlationId = correlationId;
  
  res.setHeader('Correlation-ID', correlationId);
  next();
});

// Em logs
logger.info('Transaction authorized', {
  correlationId: req.correlationId,
  transactionId: '01HZX...',
  nsu: '123456'
});

// Output
// {
//   "timestamp": "2024-04-14T10:30:00Z",
//   "level": "info",
//   "message": "Transaction authorized",
//   "correlationId": "a1b2c3d4-e5f6-...",
//   "transactionId": "01HZX..."
// }
```

### Fluxo com Correlation ID

```
Cliente:
  Gera correlationId = "uuid-abc123"
  ├─ POST /authorize (Correlation-ID: uuid-abc123)
  └─ Espera resposta

Servidor:
  Recebe, injeta em context
  ├─ Log: "Validating signature" (correlationId=uuid-abc123)
  ├─ Lookup BD: "Transaction not found" (correlationId=uuid-abc123)
  ├─ Chamar API externa (Correlation-ID: uuid-abc123)
  │  └─ External: "Received authorize" (correlationId=uuid-abc123)
  │  └─ External: "Success" (correlationId=uuid-abc123)
  ├─ Persistir BD: "Saved transaction" (correlationId=uuid-abc123)
  └─ Resposta 200 (Correlation-ID: uuid-abc123)

Cliente:
  Recebe resposta com Correlation-ID: uuid-abc123
  Se falha, pode procurar todos os logs com esse correlationId
```

---

## 4. Implementação Completa

### Estrutura de Middleware

```typescript
// src/middleware/security.ts

import { Request, Response, NextFunction } from 'express';
import { createHmac } from 'crypto';

export interface SecureRequest extends Request {
  correlationId: string;
  rawBody: string; // Para HMAC validation
}

export function signatureMiddleware(req: SecureRequest, res: Response, next: NextFunction) {
  // Apenas validar em POST/PUT/DELETE
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return next();
  }
  
  const signature = req.headers['x-signature'] as string;
  if (!signature) {
    return res.status(401).json({
      error: 'missing_signature',
      message: 'X-Signature header is required'
    });
  }
  
  const expectedSignature = createHmac('sha256', process.env.SHARED_SECRET!)
    .update(req.rawBody)
    .digest('hex');
  
  if (signature !== expectedSignature) {
    return res.status(401).json({
      error: 'invalid_signature',
      message: 'X-Signature does not match payload'
    });
  }
  
  next();
}

export function timestampMiddleware(req: Request, res: Response, next: NextFunction) {
  // Apenas validar em POST/PUT/DELETE
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    return next();
  }
  
  const timestamp = req.headers['x-timestamp'] as string;
  if (!timestamp) {
    return res.status(401).json({
      error: 'missing_timestamp',
      message: 'X-Timestamp header is required'
    });
  }
  
  const clientTime = new Date(timestamp).getTime();
  if (isNaN(clientTime)) {
    return res.status(401).json({
      error: 'invalid_timestamp',
      message: 'X-Timestamp must be ISO-8601 format'
    });
  }
  
  const ageMs = Date.now() - clientTime;
  const ageSec = ageMs / 1000;
  
  if (ageSec < -30 || ageSec > 300) {
    // Não aceitar timestamps do futuro (> 30s) ou muito antigos (> 5min)
    return res.status(401).json({
      error: 'timestamp_out_of_range',
      message: `Request age is ${ageSec.toFixed(1)}s, must be within [-30s, 300s]`
    });
  }
  
  next();
}

export function correlationIdMiddleware(req: SecureRequest, res: Response, next: NextFunction) {
  const correlationId = (req.headers['correlation-id'] as string) || uuidv4();
  req.correlationId = correlationId;
  res.setHeader('Correlation-ID', correlationId);
  next();
}
```

### App Setup

```typescript
// src/app.ts

import express from 'express';
import { SecureRequest, signatureMiddleware, timestampMiddleware, correlationIdMiddleware } from './middleware/security';

const app = express();

// Capturar body como string (para HMAC validation)
app.use(express.raw({ type: 'application/json' }));
app.use((req: SecureRequest, res, next) => {
  req.rawBody = req.body ? req.body.toString() : '';
  req.body = req.body ? JSON.parse(req.rawBody) : {};
  next();
});

// Middleware de segurança
app.use(correlationIdMiddleware);
app.use(signatureMiddleware);
app.use(timestampMiddleware);

// Rotas
app.post('/v1/pos/transactions/authorize', authorizeHandler);
app.post('/v1/pos/transactions/confirm', confirmHandler);
app.post('/v1/pos/transactions/void', voidHandler);

export default app;
```

---

## 5. Checklist de Implementação

- [ ] Implementar `generateSignature(body, secret)` usando `crypto.createHmac`
- [ ] Implementar validação de signature em middleware
- [ ] Implementar validação de timestamp (janela 5min)
- [ ] Injeccionar Correlation ID em toda requisição
- [ ] Passar Correlation ID em chamadas para API externa
- [ ] Log estruturado com correlationId
- [ ] Documentar no README:
  - [ ] Como gerar X-Signature no cliente (exemplo cURL)
  - [ ] Como gerar X-Timestamp
  - [ ] Formato esperado de Correlation-ID
  - [ ] Tratamento de erros 401

---

## 6. Exemplo: Teste de Segurança

```bash
#!/bin/bash

# Valores
SECRET="your-shared-secret"
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
BODY='{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}'

# Gerar HMAC
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

# Request válido
curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "Correlation-ID: test-uuid-123" \
  -d "$BODY"
# Resultado esperado: 200 OK

# Request com signature inválida
curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: invalid_signature" \
  -H "X-Timestamp: $TIMESTAMP" \
  -H "Correlation-ID: test-uuid-123" \
  -d "$BODY"
# Resultado esperado: 401 Unauthorized

# Request com timestamp muito antigo (10 minutos atrás)
OLD_TIMESTAMP=$(date -u -d '-10 minutes' +'%Y-%m-%dT%H:%M:%SZ')
curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $OLD_TIMESTAMP" \
  -H "Correlation-ID: test-uuid-123" \
  -d "$BODY"
# Resultado esperado: 401 Unauthorized (timestamp_out_of_range)
```
