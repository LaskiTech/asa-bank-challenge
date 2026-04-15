# ARQUITETURA.md - Design & Decisões

## 1. Visão Geral

Esta API implementa um padrão **"Man-in-the-Middle Orquestradora"** que:

```
POS Terminal (Cliente)
    ↓ (POST /authorize com nsu, amount, terminalId)
    ↓
API Interna (Seu servidor)
    ├─ Valida segurança (HMAC, timestamp)
    ├─ Implementa idempotência (nsu + terminalId → transactionId)
    ├─ Aplica regras (lookup, stateful)
    └─ Chama API Externa (com retry, circuit breaker, timeout)
    ↓
API Externa (Autorização real)
    ├─ /authorize
    ├─ /confirm
    └─ /void
```

**Responsabilidades da sua API**:
- ✅ Segurança (HMAC + timestamp)
- ✅ Idempotência (deduplica chamadas)
- ✅ Resiliência (circuit breaker, retry, timeout)
- ✅ Persistência (estado em BD)
- ✅ Observabilidade (Correlation ID + logs)

**Responsabilidades da API Externa**:
- ✅ Autorizar transação
- ✅ Confirmar transação
- ✅ Fazer void de transação

---

## 2. Fluxos de Transação

### 2.1 Fluxo de Autorização (POST /authorize)

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Cliente envia requisição                                   │
│    POST /v1/pos/transactions/authorize                        │
│    {                                                          │
│      "nsu": "123456",                                        │
│      "amount": 199.90,                                       │
│      "terminalId": "T-1000"                                 │
│    }                                                          │
│    Headers: X-Signature, X-Timestamp, Correlation-ID        │
└────────────────┬─────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────┐
│ 2. Middleware: Validar Segurança                             │
│    ├─ X-Signature: HMAC(body) === header?                    │
│    ├─ X-Timestamp: within 5 min?                             │
│    └─ Se falha → 401 Unauthorized                            │
└────────────────┬─────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────┐
│ 3. Lookup Idempotência                                       │
│    ├─ Buscar BD: (terminalId=T-1000, nsu=123456)             │
│    │  └─ Se encontrado → pular para passo 7 (retornar ID)    │
│    └─ Se não encontrado → continuar                          │
└────────────────┬─────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────┐
│ 4. Gerar TransactionId Único                                 │
│    ├─ UUID v4 ou v7                                          │
│    ├─ Garantir globalidade mesmo com múltiplos pods          │
│    └─ Nunca se repete                                        │
└────────────────┬─────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────┐
│ 5. Chamar API Externa (com proteção)                         │
│    ├─ Circuit Breaker: verificar estado                      │
│    ├─ Se OPEN → retornar 503 instantâneo                     │
│    ├─ Retry com backoff: 1s, 2s, 4s                          │
│    ├─ Timeout: 5s max por tentativa                          │
│    └─ Se falha após tudo → 503 Unavailable                   │
└────────────────┬─────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────┐
│ 6. Persistir Transação                                       │
│    ├─ Status = AUTHORIZED                                    │
│    ├─ Salvar: (id, nsu, terminalId, amount, state)           │
│    ├─ Criar índice: (terminalId+nsu) → id                    │
│    └─ Commit BD                                              │
└────────────────┬─────────────────────────────────────────────┘
                 ↓
┌──────────────────────────────────────────────────────────────┐
│ 7. Retornar Sucesso (200 OK)                                 │
│    {                                                          │
│      "nsu": "123456",                                        │
│      "amount": 199.90,                                       │
│      "terminalId": "T-1000",                                │
│      "transactionId": "01HZX...ABC",                        │
│      "status": "AUTHORIZED"                                 │
│    }                                                          │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Fluxo de Confirmação (POST /confirm)

```
POS Terminal                        Requisição idêntica
    ↓                                    ↓
┌──────────────────────────────────────┐
│ Validar Segurança                    │
└────────────┬─────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Lookup: existe transação com ID?      │
│ ├─ Não → 404                          │
│ └─ Sim → continuar                    │
└────────────┬─────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Verificar estado                      │
│ ├─ Se CONFIRMED → 204 (idempotente)   │
│ ├─ Se AUTHORIZED → chamar API externa │
│ └─ Se VOIDED → erro 409               │
└────────────┬─────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Chamar API externa /confirm           │
│ (circuit breaker + retry + timeout)   │
└────────────┬─────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Atualizar BD: status = CONFIRMED      │
└────────────┬─────────────────────────┘
             ↓
┌──────────────────────────────────────┐
│ Retornar 204 No Content               │
└──────────────────────────────────────┘
```

### 2.3 Fluxo de Void (POST /void)

```
Dois formatos de entrada:
  ├─ Forma A: { "transactionId": "01HZX..." }
  └─ Forma B: { "nsu": "123456", "terminalId": "T-1000" }

Validar Segurança
    ↓
Localizar TransactionId
  ├─ Forma A: lookup direto por ID
  └─ Forma B: lookup via (terminalId+nsu)
    ↓
Verificar Estado
  ├─ Se VOIDED → 204 (idempotente)
  └─ Se AUTHORIZED/CONFIRMED → chamar API externa
    ↓
Chamar /void (com proteção)
    ↓
Atualizar: status = VOIDED
    ↓
Retornar 204 No Content
```

---

## 3. Modelo de Dados

### 3.1 Transação

```typescript
interface Transaction {
  id: string;                // UUID v4/v7 (ex: "01HZX1A2B3C4D5E6F7G8H9I0J")
  nsu: string;               // Identificador terminal (ex: "123456")
  terminalId: string;        // ID terminal (ex: "T-1000")
  amount: number;            // Valor em decimal (ex: 199.90)
  state: 'AUTHORIZED' | 'CONFIRMED' | 'VOIDED';
  createdAt: Date;
  updatedAt: Date;
  externalApiId?: string;    // ID retornado pela API externa (se houver)
}
```

### 3.2 Índices

```
Primário:
  transactionId → Transaction

Secundário (para lookup idempotência):
  (terminalId + nsu) → transactionId

Terciário (para histórico):
  createdAt (para queries temporais)
```

---

## 4. Estados e Transições

```
┌─────────────┐
│ AUTHORIZED  │ (transação autorizada na API externa)
└──────┬──────┘
       │ POST /confirm
       ↓
┌──────────────┐
│ CONFIRMED    │ (pronta para liquidação)
└──────┬───────┘
       │ POST /void
       ↓
┌──────────────┐
│ VOIDED       │ (desfeita, nunca volta)
└──────────────┘

Notas:
  • AUTHORIZED → VOIDED é permitido (void de autorização)
  • CONFIRMED → VOIDED é permitido (void de confirmação)
  • Nenhuma transição para trás
  • Qualquer estado → mesmo estado é idempotente (204)
```

---

## 5. Idempotência

### 5.1 Por transactionId

Se um cliente enviar a mesma requisição de `/confirm` ou `/void` com o mesmo `transactionId`:

```
Requisição 1:
  POST /confirm { "transactionId": "01HZX..." }
  → 204 No Content, status = CONFIRMED

Requisição 1 (replay, mesma signature e timestamp):
  POST /confirm { "transactionId": "01HZX..." }
  → 204 No Content (idempotente, sem chamar API externa)
```

**Implementação**: Verificar estado antes de chamar API externa.

### 5.2 Por nsu+terminalId

Se um cliente enviar a mesma requisição de `/authorize`:

```
Requisição 1:
  POST /authorize { "nsu": "123456", "terminalId": "T-1000", "amount": 199.90 }
  → 200 OK, transactionId = "01HZX..."

Requisição 1 (replay):
  POST /authorize { "nsu": "123456", "terminalId": "T-1000", "amount": 199.90 }
  → 200 OK, transactionId = "01HZX..." (MESMO ID, sem chamar API externa)
```

**Implementação**: Lookup no índice secundário antes de criar nova transação.

---

## 6. Decisões de Design

### 6.1 Por que armazenar localmente?

**Problema**: A API externa pode falhar temporariamente. Se você não armazena o estado, perde rastreabilidade.

**Solução**: Persistir em BD local (PostgreSQL, SQLite, etc):
- Lookup rápido para idempotência
- Histórico de transações
- Recovery em caso de falha

### 6.2 Por que não usar estado global em memória?

**Problema**: Em Kubernetes, cada pod tem seu próprio "estado". Se um cliente conecta ao pod A na requisição 1 e ao pod B na requisição 2:
- Pod A tem a transação
- Pod B não vê nada → cria nova transação duplicada ❌

**Solução**: BD compartilhada (PostgreSQL) ou cache distribuído (Redis).

### 6.3 Por que Circuit Breaker precisa ser global?

Se o Circuit Breaker fosse em-memory por pod:
- Pod A: 5 falhas → OPEN
- Pod B: 2 falhas → CLOSED (continua martilhando API externa)

**Solução Ideal**: Circuit Breaker em cache distribuído (Redis).
**Solução Prática**: Implementar em cada pod com estados sincronizados via logs.

### 6.4 Por que HMAC e Timestamp?

1. **HMAC**: Prova que quem enviou a requisição conhece o secret
2. **Timestamp**: Evita replay (reutilizar requisições antigas)
3. **Juntos**: Defesa contra atacantes que não conhecem a chave

---

## 7. Fluxo de Erro: Cascata de Falhas

### 7.1 Cenário: API Externa Down

```
T=0-5s:
  Autorização requisitada
  Timeout 5s ativa
  Conexão timeoutando...
  → TimeoutError
  → Retry 1: delay 1s

T=1-6s:
  Retry 1 iniciou
  Timeout 5s ativa
  Tenta conectar...
  → Falha (API ainda down)
  → Retry 2: delay 2s

T=3-8s:
  Retry 2 iniciou
  Timeout 5s ativa
  → Falha
  → Retry 3: delay 4s

T=7s:
  Retry 3 não iniciou porque já gastou retries
  → Lança erro final
  → Circuit Breaker registra falha (failureCount = 3)

T=7-12s:
  Próximas requisições: mesma sequência (mais 3 falhas)
  failureCount = 3 + 3 = 6 > threshold (5)
  → Circuit breaker OPEN 🚨

T=12s+:
  Nova requisição → Circuit Breaker
  Verifica estado: OPEN
  → Lança CircuitBreakerOpenError instantâneo
  → Retorna 503 rapidamente (em milissegundos, não segundos)
  ✅ Protege recursos locais!

T=42s (30s depois de abrir):
  Próxima requisição → Circuit Breaker
  Verifica estado: OPEN, mas timeout passou
  → Transiciona para HALF_OPEN
  → Tenta UMA requisição (teste)
  → Se OK: volta CLOSED
  → Se falha: volta OPEN
```

---

## 8. Limitações Conhecidas

### 8.1 Limitação Declarada: Storage SQLite (cláusula multi-pod do desafio)

O PDF do desafio diz explicitamente:

> *"não pode depender de estado local em memória para garantir unicidade/idempotência, **a não ser que você documente limitações e como resolveria em produção**."*

Esta implementação usa **SQLite**, não memória. SQLite é um banco de dados em arquivo — persiste entre reinicializações e garante ACID para um único processo. A limitação conhecida e documentada é:

**SQLite não é adequado para múltiplos pods simultâneos** — dois pods escrevendo no mesmo arquivo SQLite concorrentemente causam contenção de lock e podem resultar em corrupção se o volume não suportar escritas concorrentes (ex: NFS).

**Como resolveria em produção (multi-pod / Kubernetes):**

Troca cirúrgica: implementar `PostgresTransactionStore` seguindo a interface `ITransactionStore` já existente no código. O único arquivo que muda é `storage/SqliteTransactionStore.ts` → `storage/PostgresTransactionStore.ts`. Rotas, middleware, e lógica de negócio não são afetados.

```
Produção multi-pod:
  SqliteTransactionStore  →  PostgresTransactionStore (driver: pg)
  Circuit Breaker in-memory  →  Circuit Breaker com Redis (coordenação entre pods)
```

O design orientado a interface (`ITransactionStore`) foi escolhido precisamente para que essa troca seja possível sem refatoração.

### 8.2 Circuit Breaker por pod (sem sincronização entre instâncias)

O Circuit Breaker desta implementação é in-memory por processo. Em múltiplos pods:
- Pod A pode ter CB OPEN (registrou 5 falhas)
- Pod B pode ter CB CLOSED (ainda não chegou no threshold)

**Como resolveria em produção:** Circuit Breaker com estado no Redis (chave compartilhada entre pods). Já está mapeado na arquitetura escalada da seção 9.

**Por que é aceitável no escopo do desafio:** O PDF reconhece esta solução como "Solução Prática" e aceita a documentação da limitação como equivalente à implementação.

### 8.3 Outras limitações

- **Sem autenticação de cliente**: Qualquer detentor do secret pode enviar requisições → Solução: API keys por terminal
- **Sem rate limiting**: Terminal POS pode enviar rajadas → Solução: token bucket ou sliding window
- **Sem suporte a múltiplas moedas**: assume BRL → Solução: adicionar campo `currency`

---

## 9. Melhoria Futura: Arquitetura Escalada

```
┌─────────────────────────────────────────────────────────────┐
│ Kubernetes Cluster                                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│ │  Pod API #1  │  │  Pod API #2  │  │  Pod API #N  │       │
│ │  (Insta 1)   │  │  (Insta 2)   │  │  (Insta N)   │       │
│ └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│        │                  │                  │               │
│        └──────────────────┼──────────────────┘               │
│                           ↓                                  │
│                  ┌────────────────┐                          │
│                  │  PostgreSQL    │ (persistência)           │
│                  │  Primary-Repli │                          │
│                  └────────────────┘                          │
│                           │                                  │
│                           ↓                                  │
│                  ┌────────────────┐                          │
│                  │  Redis Cluster │ (circuit breaker sync)   │
│                  └────────────────┘                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
              ↓
        ┌─────────────────────┐
        │  Load Balancer      │
        │  (nginx / AWS ALB)   │
        └─────────────────────┘
              ↓
        API Externa (Visa/Mastercard)
```

**Benefícios**:
- ✅ Circuit Breaker sincronizado via Redis
- ✅ Transações em BD central
- ✅ Zero downtime deployments
- ✅ Auto-scaling horizontal

---

## 10. Checklist de Validação de Arquitetura

- [ ] **Idempotência**: Mesma requisição retorna mesmo ID
- [ ] **Segurança**: HMAC valida payload, timestamp rejeita antigos
- [ ] **Resiliência**: Circuit breaker protege contra cascata
- [ ] **Persistência**: BD compartilhada entre pods
- [ ] **Observabilidade**: Logs com Correlation ID em todo fluxo
- [ ] **Escalabilidade**: Suporta N pods simultâneos
- [ ] **Recuperação**: Graceful shutdown, health checks
