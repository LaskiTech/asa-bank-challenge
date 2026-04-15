# Solução: API de Transações POS (Authorize / Confirm / Void)

## 📋 Objetivo

Construir uma HTTP API para processar transações de POS (Point of Sale) com 3 endpoints principais:

1. **POST `/v1/pos/transactions/authorize`** - Autoriza uma transação
2. **POST `/v1/pos/transactions/confirm`** - Confirma uma transação autorizada
3. **POST `/v1/pos/transactions/void`** - Desfaz (void) uma transação

## 🎯 Requisitos-Chave

### Não-Funcionais

- **Síncrona**: responde no mesmo request
- **Idempotente**: repetições não geram efeitos colaterais duplicados
- **Distribuída/Cloud-native**: suporta múltiplos pods/instâncias (Kubernetes)
- **Man-in-the-middle**: orquestra requisições do POS, aplica regras (idempotência, controle, lookup), chama API externa
- **Resiliente**: evita falhas em cascata quando a API externa falha
- **Observável**: Correlation ID obrigatório + tracing básico (OpenTelemetry)
- **Segura**: HMAC SHA-256 (X-Signature) + X-Timestamp para evitar replay

### Conceitos e Campos

| Campo | Descrição |
|-------|-----------|
| `nsu` | Identificador da transação no terminal (ex: "123456") |
| `terminalId` | Identificador do terminal POS (ex: "T-1000") |
| `amount` | Valor da transação (ex: 199.90) |
| `transactionId` | ID único gerado pela API após autorização (ex: "01HZX...ABC") |

**Associação obrigatória**: `(terminalId + nsu)` → `transactionId`

### Estados Recomendados

- `AUTHORIZED` - transação autorizada na API externa
- `CONFIRMED` - transação confirmada (pronta para liquidação)
- `VOIDED` - transação desfeita

---

## 🏗️ Arquitetura de Componentes

```
┌─────────────────────────────────────────────────────────────┐
│                     POS Terminal                              │
│                  (Cliente, envia NSU)                         │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /authorize (nsu, amount, terminalId)
                           ↓
┌──────────────────────────────────────────────────────────────┐
│                    API Interna (Você)                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 1. Validações (signature, timestamp, throttling)        │ │
│  │ 2. Lookup: nsu+terminalId → transactionId (idempotência)│ │
│  │ 3. Chamar API Externa (authorize/confirm/void)          │ │
│  │ 4. Persistir transação + estado (PostgreSQL/Redis)      │ │
│  │ 5. Retry + Circuit Breaker + Logging                    │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────┬──────────────────────────────────┘
                           │ 200 + transactionId
                           ↓
┌──────────────────────────────────────────────────────────────┐
│               API Externa (Simulada)                         │
│         (autorizacao/confirmacao/void real)                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 📁 Estrutura de Arquivos Esperada

```
pos-transaction-api/
├── README.md                         # Este arquivo
├── ARQUITETURA.md                    # Detalhe técnico da arquitetura
├── API_SPEC.md                       # Contrato de endpoints e payloads
├── RESILIENCIA.md                    # Mecanismos de circuit breaker, retry, etc
├── SEGURANCA.md                      # HMAC, timestamp, correlation ID
├── IMPLEMENTACAO.md                  # Guia passo-a-passo da implementação
│
├── src/
│   ├── index.ts                      # Entry point
│   ├── app.ts                        # Setup Express/server
│   ├── types.ts                      # TypeScript types (Transaction, etc)
│   ├── config.ts                     # Env vars, constantes
│   ├── logger.ts                     # OpenTelemetry logging + tracing
│   │
│   ├── routes/
│   │   └── transactions.ts           # Rotas: /authorize, /confirm, /void
│   │
│   ├── services/
│   │   ├── transactionService.ts     # Lógica de transação (create, find, update)
│   │   ├── externalApiService.ts     # Integração com API externa
│   │   └── resilienceService.ts      # Retry, circuit breaker, timeout
│   │
│   ├── middleware/
│   │   ├── security.ts               # Validação HMAC, timestamp
│   │   ├── correlation.ts            # Correlation ID injection
│   │   └── errorHandler.ts           # Tratamento de erros global
│   │
│   ├── storage/
│   │   └── transactionStore.ts       # Abstração para persistência (PostgreSQL/Redis)
│   │
│   └── resilience/
│       ├── circuitBreaker.ts         # Implementação do circuit breaker
│       ├── retryPolicy.ts            # Retry com backoff exponencial
│       └── timeout.ts                # Timeout manager
│
├── .env.example                      # Variáveis de ambiente exemplo
├── package.json
├── tsconfig.json
├── docker-compose.yml                # Serviço único: API + volume SQLite
├── Dockerfile                        # Multi-stage build (dev / build / production)
├── .dockerignore                     # Exclusões do contexto de build
└── data/                             # Criado automaticamente — arquivo SQLite persiste aqui
    └── transactions.db               # (não commitar — adicionar ao .gitignore)
```

---

## 🚀 Tecnologias Sugeridas

- **Runtime**: Node.js 22 LTS (v22.22.0)
- **Framework**: Express.js v5 (v5.2.1)
- **Banco de Dados**: SQLite via `better-sqlite3` — persistente, sem infra adicional
  - O spec lista "PostgreSQL **ou** SQLite". SQLite é a escolha correta para o escopo do desafio.
  - Para produção com múltiplos pods: trocar `SqliteTransactionStore` por implementação PostgreSQL via interface `ITransactionStore`
- **Circuit Breaker**: In-memory por processo — suficiente para processo seletivo (ver ARQUITETURA.md seção 6.3)
- **Async**: Promises/async-await nativo (better-sqlite3 é síncrono, ideal aqui)
- **Segurança**: `crypto` (Node.js built-in) para HMAC
- **Observabilidade**: Correlation ID via middleware (OpenTelemetry pode ser adicionado depois)
- **Testing**: Jest + SuperTest
- **TypeScript**: v5.x

---

## ✅ Checklist de Implementação

- [ ] Configurar projeto Node.js + TypeScript
- [ ] Implementar tipos TypeScript (Transaction, TransactionState)
- [ ] Configurar banco de dados (PostgreSQL ou SQLite)
- [ ] Implementar middleware de segurança (HMAC + timestamp)
- [ ] Implementar middleware de correlation ID
- [ ] Implementar serviço de transação (CRUD)
- [ ] Implementar endpoint POST /v1/pos/transactions/authorize
  - [ ] Idempotência (lookup nsu+terminalId)
  - [ ] Gerar transactionId único
  - [ ] Chamar API externa
  - [ ] Persistir e retornar 200 com transactionId
- [ ] Implementar endpoint POST /v1/pos/transactions/confirm
  - [ ] Localizar transação por ID
  - [ ] Chamar API externa para confirmar
  - [ ] Retornar 204 No Content se sucesso
- [ ] Implementar endpoint POST /v1/pos/transactions/void
  - [ ] Suportar Forma A (por transactionId) e Forma B (por nsu+terminalId)
  - [ ] Chamar API externa para void
  - [ ] Retornar 204 No Content se sucesso
- [ ] Implementar Circuit Breaker
- [ ] Implementar Retry Policy com exponential backoff
- [ ] Implementar Timeout Manager
- [ ] Implementar logging + tracing (Correlation ID)
- [ ] Documentar no README (limitações, como rodá, exemplos de request)
- [ ] Testes unitários + integração
- [ ] Empacotar em .zip para envio

---

## 📚 Próximas Leituras

1. **ARQUITETURA.md** - Detalhes do design (estado, fluxos, limitações)
2. **API_SPEC.md** - Contratos de endpoint, payloads, respostas
3. **RESILIENCIA.md** - Circuit breaker, retry, timeout, handling de falhas
4. **SEGURANCA.md** - HMAC SHA-256, timestamp validation, correlation ID
5. **IMPLEMENTACAO.md** - Guia prático passo-a-passo do código
