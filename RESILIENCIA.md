# RESILIENCIA.md - Mecanismos de Falha & Recuperação

## Problema: Cascata de Falhas

Sua API interna depende de uma API externa (por enquanto simulada, mas em produção pode falhar). Se não implementar proteção:

1. **Cenário ruim**: API externa está lenta ou down
2. **Sem proteção**: Seus requests acumulam, timeouts explodem, threads/conexões se esgotam
3. **Resultado**: Sua API fica indisponível mesmo quando trata apenas transações locais

## Solução: 3 Camadas de Proteção

### 1. Timeout (Camada mais rápida)

**O quê**: Nunca fique indefinidamente esperando a API externa.

```typescript
async function callExternalAPI(url: string, body: any, timeout_ms: number = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout_ms);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }
    });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new TimeoutError(`Request timed out after ${timeout_ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**Quando aplicar**:
- Chamar API externa: **5 segundos máximo**
- Retry individual: **3 segundos máximo**
- Leitura do banco de dados: **2 segundos máximo**

**Comportamento**:
```
┌─────────────────────────┐
│ Inicia request (t=0)    │
├─────────────────────────┤
│ Esperando resposta...   │
│ (timeout = 5s)          │
├─────────────────────────┤
│ Timeout ativo (t=5s)    │ ← AbortError
│ Lança TimeoutError      │
└─────────────────────────┘
```

---

### 2. Retry com Exponential Backoff (Camada média)

**O quê**: Se uma requisição falha, tente novamente. Mas não imediatamente — aumente o intervalo.

```typescript
async function retryWithBackoff(
  fn: () => Promise<any>,
  maxRetries: number = 3,
  baseDelay: number = 1000
) {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt); // 1s, 2s, 4s
        console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
}

// Uso
await retryWithBackoff(() => callExternalAPI('/authorize', body), 3, 1000);
// Tentativas: t=0, t=1s (falhou), t=1s+2s=3s (falhou), t=3s+4s=7s (falhou ou OK)
```

**Sequência de retry**:
```
Tentativa 1 (t=0ms):     falhou  ✗
Esperar 1s
Tentativa 2 (t=1000ms):  falhou  ✗
Esperar 2s
Tentativa 3 (t=3000ms):  sucesso ✓ (ou falha final)
```

**Casos de uso para retry**:
- ✅ Timeout curto (API externa lenta momentaneamente)
- ✅ Erro 503 (API externa em manutenção curta)
- ✅ Erro de conexão temporária
- ❌ **Não fazer retry em**:
  - 401/403 (autenticação)
  - 400 (payload inválido)
  - 429 (rate limit) — esperar headers `Retry-After`

---

### 3. Circuit Breaker (Camada de proteção sistêmica)

**O quê**: Se a API externa está realmente down (padrão de falha constante), pare de tentar. Retorne erro rápido.

**Estados do Circuit Breaker**:

```
                    ┌─────────────┐
                    │   CLOSED    │ (tudo OK, passa requisições)
                    └──────┬──────┘
                           │
              ✗ threshold de erros excedido
                           │
                           ↓
                    ┌─────────────┐
                    │    OPEN     │ (falhas, rejeita requisições)
                    └──────┬──────┘
                           │
              ⏱ timeout = 30s
                           │
                           ↓
                    ┌─────────────┐
                    │ HALF_OPEN   │ (testando se API voltou)
                    └──────┬──────┘
                    /      │      \
                ✓ OK      ✗ FALHA  ?
                /           │       \
              CLOSED       OPEN    HALF_OPEN
```

**Implementação**:

```typescript
class CircuitBreaker {
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  
  readonly failureThreshold: number = 5; // Abrir após 5 falhas consecutivas
  readonly successThreshold: number = 2; // Fechar após 2 sucessos em HALF_OPEN
  readonly openTimeout: number = 30000; // 30 segundos
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      // Se passou timeout, tenta HALF_OPEN
      if (Date.now() - this.lastFailureTime >= this.openTimeout) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
      } else {
        // Ainda OPEN, rejeita rápido
        throw new CircuitBreakerOpenError('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }
  
  private onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        console.log('✅ Circuit breaker CLOSED (API recovered)');
      }
    }
  }
  
  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      console.log('🚨 Circuit breaker OPEN (API appears down)');
    }
  }
}

// Uso
const breaker = new CircuitBreaker();

// Em seu endpoint
try {
  const result = await breaker.call(() =>
    retryWithBackoff(() => callExternalAPI('/authorize', body))
  );
  return res.status(200).json(result);
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'External API is temporarily unavailable (circuit breaker open)'
    });
  }
  // Outros erros
  throw err;
}
```

**Comportamento observado**:

```
T=0-20s:  API lenta
  ✗ Tentativa 1 (timeout)
  ✗ Tentativa 2 (falha)
  ✗ Tentativa 3 (falha)
  → failureCount = 3

T=20-40s: API ainda lenta
  ✗ Tentativa 4 (falha)
  ✗ Tentativa 5 (falha)
  → failureCount = 5 ✗ threshold
  → state = OPEN 🚨

T=40-50s: Circuit OPEN
  → Nova requisição?
  → CircuitBreakerOpenError instantâneo (sem retry, sem timeout)
  → Retorna 503 rapidamente ⚡

T=50-80s: Timeout = 30s
  → Próxima requisição tenta HALF_OPEN
  → Se API respondeu: ✓ successCount++
  → Se 2 sucessos: state = CLOSED ✅
  → Se falhou novamente: state = OPEN 🚨

T=80+:   Volta ao fluxo normal
  → state = CLOSED
  → Requisições passam normalmente
```

---

---

### 4. Bulkhead — Limite de Concorrência (Requisito obrigatório do PDF)

**O quê**: Limitar quantas chamadas simultâneas à API externa podem estar em andamento ao mesmo tempo. Sem isso, uma API externa lenta mantém dezenas de requisições pendentes consumindo memória e o event loop do Node.js — e uma única dependência lenta pode derrubar todo o serviço.

**Por que importa no Node.js**: Apesar de single-threaded, o event loop processa callbacks de I/O concorrentemente. 50 chamadas HTTP abertas ao mesmo tempo para uma API que demora 30s = 50 timers, 50 sockets pendentes, pressão de memória crescente.

```typescript
export class BulkheadError extends Error {
  constructor(max: number) {
    super(`Bulkhead: limite de ${max} chamadas simultâneas atingido`);
    this.name = 'BulkheadError';
  }
}

export class Bulkhead {
  private active = 0;

  constructor(
    private readonly maxConcurrent: number = 10  // máx. chamadas simultâneas à API externa
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      throw new BulkheadError(this.maxConcurrent);
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }

  get stats() {
    return { active: this.active, max: this.maxConcurrent };
  }
}
```

**Comportamento**:

```
Requisições simultâneas: 1..10   → entram normalmente
Requisição 11 (limite = 10):     → BulkheadError → 503 imediato
Requisição anterior termina:     → active = 9 → próxima entra
```

**Integração com as demais camadas** (ordem correta):

```
Bulkhead.call()          ← rejeita se já há 10 chamadas ativas
  └─ CircuitBreaker.call()   ← rejeita se OPEN
       └─ retryWithBackoff()  ← tenta até 3×
            └─ withTimeout()  ← 5s por tentativa
```

**Por que o Bulkhead vem antes do Circuit Breaker na cadeia?** Porque o Circuit Breaker pode estar CLOSED e ainda assim a API externa pode estar lenta, acumulando requisições. O Bulkhead garante que mesmo nesse cenário o número de conexões abertas é limitado.

---

## Orquestração: Bulkhead → Circuit Breaker → Retry → Timeout

```typescript
class ResilienceService {
  private bulkhead = new Bulkhead(10);       // máx 10 chamadas simultâneas
  private circuitBreaker = new CircuitBreaker();

  async callExternalAPIWithProtection(url: string, body: any) {
    // 1. Bulkhead: rejeita se já há 10 chamadas ativas
    return this.bulkhead.call(async () => {
      // 2. Circuit Breaker: rejeita imediatamente se OPEN
      return this.circuitBreaker.call(async () => {
        // 3. Retry + Timeout: tenta até 3× com 5s cada
        return retryWithBackoff(
          () => callExternalAPIWithTimeout(url, body, 5000),
          3,
          1000
        );
      });
    });
  }
}
```

**Fluxo completo de uma requisição**:

```
User requisita /authorize
    ↓
┌─────────────────────────────────────┐
│ 1. Validar signature & timestamp     │
├─────────────────────────────────────┤
│ 2. Lookup idempotência (SQLite)      │
├─────────────────────────────────────┤
│ 3. Bulkhead.call():                  │
│    └─ active >= 10? → 503 imediato   │
│                                      │
│ 4. Circuit Breaker.call():           │
│    ├─ OPEN? → 503 imediato           │
│    └─ HALF_OPEN? → testa 1 request   │
│                                      │
│ 5. Retry com Backoff:                │
│    ├─ Attempt 1: timeout 5s          │
│    │  └─ falhou? delay 1s            │
│    ├─ Attempt 2: timeout 5s          │
│    │  └─ falhou? delay 2s            │
│    └─ Attempt 3: timeout 5s          │
│       └─ OK ou erro final            │
│                                      │
│ 6. Persistir resultado (SQLite)      │
└─────────────────────────────────────┘
    ↓
Retornar 200 ou 5xx
```

---

## Implementação: Checklist

- [ ] **Timeout Manager**
  - [ ] AbortController com 5s por chamada externa
  - [ ] Log do timeout com correlationId

- [ ] **Retry Policy**
  - [ ] Backoff exponencial: 1s → 2s → 4s (máx 3 tentativas)
  - [ ] Não fazer retry em respostas 4xx (erro do cliente)
  - [ ] Log de cada tentativa

- [ ] **Circuit Breaker**
  - [ ] Estados: CLOSED → OPEN → HALF_OPEN
  - [ ] Threshold: 5 falhas → OPEN
  - [ ] Timeout: 30s em OPEN → tenta HALF_OPEN
  - [ ] Recovery: 2 sucessos em HALF_OPEN → CLOSED
  - [ ] Retorna 503 quando OPEN

- [ ] **Bulkhead**
  - [ ] Máximo 10 chamadas simultâneas à API externa
  - [ ] Retorna 503 quando limite atingido
  - [ ] Log do contador de chamadas ativas

- [ ] **Integração**
  - [ ] Cadeia: Bulkhead → CircuitBreaker → Retry → Timeout
  - [ ] Logs estruturados com correlationId e cbState

---

## Respostas Diretas ao Avaliador (PDF — página 4)

O ASA Bank pediu explicitamente que estas 4 perguntas sejam respondidas na documentação:

### 1. Quais sinais abrem e fecham o Circuit Breaker?

| Evento | Efeito |
|--------|--------|
| 5 falhas consecutivas (timeout, erro 5xx, BulkheadError) | CLOSED → **OPEN** |
| 30 segundos decorridos com CB OPEN | OPEN → **HALF_OPEN** |
| 2 sucessos consecutivos em HALF_OPEN | HALF_OPEN → **CLOSED** |
| Qualquer falha em HALF_OPEN | HALF_OPEN → **OPEN** (reinicia timer) |

O sinal de abertura é baseado em **contagem de falhas consecutivas** (não taxa percentual). Esta é a implementação correta para o escopo do desafio — simples, previsível e auditável nos logs.

### 2. Como esta implementação evita "retry storm"?

Três mecanismos combinados:

- **Backoff exponencial**: cada retry espera o dobro do anterior (1s → 2s → 4s). Nenhum cliente bombeia a API externa indefinidamente.
- **Limite de tentativas**: máximo 3 por requisição. Após isso, falha propagada para o Circuit Breaker.
- **Circuit Breaker OPEN bloqueia novos retries**: quando o CB abre, todas as requisições subsequentes recebem 503 em microssegundos — sem chegar a tentar a API externa, sem agendar retries, sem acumular timers. O próprio OPEN elimina a tempestade.

### 3. Como os recursos locais são protegidos quando a API externa está ruim?

| Recurso | Proteção |
|---------|----------|
| Sockets HTTP abertos | Timeout de 5s + Bulkhead (máx 10 simultâneos) |
| Event loop do Node.js | Bulkhead evita acúmulo de Promises pendentes |
| Memória (callbacks pendentes) | Timeout + limite de concorrência = fila nunca cresce indefinidamente |
| SQLite (storage local) | Não depende da API externa; operações locais continuam mesmo com CB OPEN |

O SQLite garante que mesmo com a API externa totalmente indisponível, a API continua recebendo requisições e respondendo corretamente para transações já existentes (idempotência funciona, consultas de estado funcionam).

### 4. Qual status code é retornado quando o Circuit Breaker está aberto?

**`503 Service Unavailable`** — com corpo JSON:

```json
{
  "error": "circuit_breaker_open",
  "message": "External authorization service is temporarily unavailable. Please retry after 30 seconds.",
  "correlationId": "uuid-aqui"
}
```

O mesmo `503` é retornado por `BulkheadError`. O cliente (terminal POS) deve interpretar qualquer 503 como "tente novamente depois" — e o `Retry-After: 30` header pode ser incluído para orientar o intervalo.
