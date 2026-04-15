# GUIA_RAPIDO.md - Como Usar Esta Solução

## 📚 Documentos Criados

Você recebeu **6 documentos de especificação** (totalizando ~2.600 linhas):

### 1. **SOLUCAO_API_POS.md** (este é seu ponto de partida!)
- 📍 Visão geral do projeto
- 📍 Requisitos não-funcionais
- 📍 Conceitos-chave (nsu, terminalId, transactionId, estados)
- 📍 Arquitetura de componentes
- 📍 Checklist de implementação

**⏱️ Leitura: 5 min**

### 2. **API_SPEC.md**
- 🔌 Especificação de endpoints (authorize, confirm, void)
- 🔌 Contratos de request/response
- 🔌 Status codes esperados
- 🔌 Exemplo de fluxo completo

**⏱️ Leitura: 10 min**

### 3. **ARQUITETURA.md**
- 🏗️ Fluxos detalhados por operação
- 🏗️ Modelo de dados (Transaction, índices)
- 🏗️ Estados e transições
- 🏗️ Decisões de design (por quê armazenar? por quê BD compartilhada?)
- 🏗️ Limitações conhecidas
- 🏗️ Arquitetura escalada (Kubernetes + Redis)

**⏱️ Leitura: 15 min**

### 4. **RESILIENCIA.md**
- ⚡ Timeout (5s máximo por requisição)
- ⚡ Retry com backoff exponencial (1s, 2s, 4s)
- ⚡ Circuit Breaker (CLOSED → OPEN → HALF_OPEN)
- ⚡ Proteção contra cascata de falhas
- ⚡ Implementação passo-a-passo

**⏱️ Leitura: 15 min**

### 5. **SEGURANCA.md**
- 🔐 HMAC SHA-256 (X-Signature)
- 🔐 Validação de Timestamp (replay protection)
- 🔐 Correlation ID (observabilidade)
- 🔐 Implementação de middleware
- 🔐 Testes de segurança

**⏱️ Leitura: 15 min**

### 6. **IMPLEMENTACAO.md**
- 💻 Setup Node.js + TypeScript (Fase 1)
- 💻 Tipos & Config (Fase 2)
- 💻 Middleware (Fase 3)
- 💻 Storage (Fase 4)
- 💻 Resiliência (Fase 5)
- 💻 Serviços (Fase 6)
- 💻 Rotas (Fase 7)
- 💻 Express App (Fase 8)
- 💻 Teste & Empacotar (Fase 9)

**⏱️ Leitura/Implementação: 3-4 horas**

---

## 🚀 Como Começar

### Opção A: Leitura Rápida (20 min)

1. Leia **SOLUCAO_API_POS.md** (overview)
2. Leia **API_SPEC.md** (entenda os endpoints)
3. Pule direto para **IMPLEMENTACAO.md** e comece a codar

### Opção B: Entendimento Profundo (1 hora)

1. **SOLUCAO_API_POS.md** → overview
2. **ARQUITETURA.md** → entenda decisões de design
3. **RESILIENCIA.md** → entenda proteção contra falhas
4. **SEGURANCA.md** → entenda autenticação
5. **API_SPEC.md** → endpoints específicos
6. **IMPLEMENTACAO.md** → código

### Opção C: Só Código (direto ao ponto)

1. Abra **IMPLEMENTACAO.md** Fase 1-9
2. Execute cada passo no Claude Code
3. Consulte outros documentos conforme necessário

---

## 🎯 Workflow Recomendado com Claude Code

### Passo 1: Setup (10 min)

```bash
# Node.js 22 LTS (v22.22.0) + npm 10.9.4 + Docker disponíveis no ambiente
mkdir pos-transaction-api
cd pos-transaction-api

# Subir infraestrutura (PostgreSQL + Redis) com Docker
cp .env.example .env
docker compose up -d db redis

# Criar projeto Node.js
npm init -y
npm install express cors dotenv uuid better-sqlite3
npm install -D typescript@5 @types/node@22 @types/express @types/better-sqlite3 ts-node nodemon @tsconfig/node22
npx tsc --init --target ES2022 --module commonjs --lib ES2022
```

### Passo 2: Abra Claude Code

```bash
# Dentro do diretório pos-transaction-api
claude-code --dir .
```

### Passo 3: Siga IMPLEMENTACAO.md Fase por Fase

**Fase 1**: Criar estrutura de pastas (usando Claude Code file creation)
**Fase 2**: Criar src/types.ts e src/config.ts
**Fase 3**: Criar middleware de segurança
**Fase 4**: Criar storage (in-memory para prototipagem)
...e assim por diante

### Passo 4: Teste Localmente

```bash
npm run dev    # Inicia servidor em http://localhost:3000
```

### Passo 5: Valide com cURL

```bash
# Gerar signature
BODY='{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}'
SECRET="dev-secret-key"
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

# Testar
curl -X POST http://localhost:3000/v1/pos/transactions/authorize \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIGNATURE" \
  -H "X-Timestamp: $TIMESTAMP" \
  -d "$BODY"
```

### Passo 6: Empacotar e Enviar

```bash
npm run build
zip -r pos-transaction-api.zip src/ dist/ package*.json tsconfig.json .env.example *.md
# Enviar pos-transaction-api.zip por email
```

---

## 📊 Arquitetura Visual

```
┌─────────────────────────────────────────────────────────────┐
│  Cliente POS                                                 │
│  POST /authorize (nsu, amount, terminalId)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
┌──────────────────────────────────────────────────────────────┐
│  Sua API (Node.js + Express)                                 │
│                                                              │
│  Middleware:                                                 │
│  • HMAC SHA-256 (X-Signature)                               │
│  • Timestamp validation (X-Timestamp)                       │
│  • Correlation ID injection                                 │
│                                                              │
│  Routes: /v1/pos/transactions/                              │
│  • POST /authorize → transactionId                          │
│  • POST /confirm   → 204 No Content                         │
│  • POST /void      → 204 No Content                         │
│                                                              │
│  Services:                                                   │
│  • Transaction Service (CRUD)                               │
│  • Resilience Service (circuit breaker, retry, timeout)    │
│  • External API Service (mock)                              │
│                                                              │
│  Storage:                                                    │
│  • In-memory transactionStore (ou PostgreSQL)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
┌──────────────────────────────────────────────────────────────┐
│  API Externa (Simulada por enquanto)                        │
│  POST /authorize, /confirm, /void                           │
└──────────────────────────────────────────────────────────────┘
```

---

## ✅ Checklist de Entrega

- [ ] Todos os 6 documentos Markdown lidos e entendidos
- [ ] Projeto Node.js criado e configurado
- [ ] Fases 1-9 de IMPLEMENTACAO.md completadas
- [ ] `npm run build` compila sem erros
- [ ] `npm start` inicia servidor
- [ ] GET /health retorna 200
- [ ] POST /authorize com signature válida retorna 200
- [ ] POST /authorize com signature inválida retorna 401
- [ ] Idempotência testada (replay retorna mesmo ID)
- [ ] Circuit breaker testado (falha simulada)
- [ ] README gerado com exemplos
- [ ] .zip criado e pronto para enviar

---

## 🆘 Troubleshooting

### "X-Signature header mismatch"

**Causa**: Signature gerada incorretamente no cliente
**Solução**: 
```bash
# Verifique que está usando o corpo exato do JSON
# Sem espaços extras, sem linhas novas
echo -n '{"nsu":"123456","amount":199.90,"terminalId":"T-1000"}' | openssl dgst -sha256 -hmac "dev-secret-key" -hex
```

### "X-Timestamp is older than 5 minutes"

**Causa**: Clock skew entre cliente e servidor
**Solução**: 
- Use `date -u` (UTC)
- Verifique se o servidor está sincronizado (NTP)
- Ajuste `TIMESTAMP_MAX_AGE_SEC` em .env (default: 300s)

### "Circuit breaker is OPEN"

**Causa**: API externa está down ou falhando
**Solução**:
- Verifique se `EXTERNAL_API_URL` é acessível
- Aguarde 30 segundos para circuit breaker sair de OPEN
- Verifique logs para ver qual erro causou abertura

### "Transaction not found"

**Causa**: Está usando um transactionId que não existe
**Solução**:
- Primeiro faça POST /authorize para gerar um ID
- Use exatamente aquele ID em /confirm ou /void
- Verificar BD se está persistindo dados

---

## 📞 Próximos Passos

Após implementar a solução básica:

1. **Trocar in-memory por PostgreSQL**:
   - Driver `pg` já na lista de dependências
   - Ver DOCKER.md → seção "Migração do Storage In-Memory para PostgreSQL"
   - Schema já criado pelo `infra/db/init.sql`

2. **Adicionar Testes**:
   - Jest + SuperTest
   - Testes de idempotência
   - Testes de circuit breaker

3. **Adicionar Observabilidade**:
   - OpenTelemetry tracing
   - Prometheus metrics
   - ELK Stack (Elasticsearch + Kibana)

4. **Melhorar Resiliência**:
   - Circuit Breaker em Redis (distribuído)
   - Rate limiting (Redis token bucket)
   - Bulkhead pattern (pool de conexões isolado)

5. **Segurança Adicional**:
   - API Keys por cliente
   - mTLS com API externa
   - Request signing com JWS

---

## 📖 Referências Externas

- [UUID Specification](https://www.uuidtools.com/)
- [HMAC-SHA256 Explained](https://en.wikipedia.org/wiki/HMAC)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Exponential Backoff](https://en.wikipedia.org/wiki/Exponential_backoff)
- [Express.js Documentation](https://expressjs.com/)
- [Node.js crypto module](https://nodejs.org/api/crypto.html)
- [OpenTelemetry](https://opentelemetry.io/)

---

## 💬 Dúvidas Frequentes

**P: Por que UUID e não um número sequencial?**
R: UUID funciona em múltiplos pods sem coordenação central. Números sequenciais exigem ID distribuído.

**P: Preciso usar PostgreSQL ou posso usar SQLite?**
R: SQLite funciona para prototipagem/teste local. PostgreSQL é necessário em produção (múltiplas instâncias).

**P: O Circuit Breaker precisa estar em Redis?**
R: Não para MVP. Para múltiplos pods em produção, sim.

**P: Posso usar express.json() em vez de capturar rawBody?**
R: Não, porque `JSON.stringify()` pode produzir ordem de chaves diferente. Precisa do corpo original para validar HMAC.

**P: E se a API externa for mais lenta que 5s?**
R: Ajuste `EXTERNAL_API_TIMEOUT_MS` em .env, mas 5s é razoável para autorização.

---

## 🎓 Estrutura de Aprendizado

```
Fase 1: Entender Requisitos
└─ Ler SOLUCAO_API_POS.md

Fase 2: Entender Fluxos
└─ Ler ARQUITETURA.md (fluxos de transação)

Fase 3: Entender Contratos
└─ Ler API_SPEC.md (endpoints)

Fase 4: Entender Segurança
└─ Ler SEGURANCA.md (HMAC + timestamp)

Fase 5: Entender Resiliência
└─ Ler RESILIENCIA.md (circuit breaker)

Fase 6: Começar a Codar
└─ Abrir IMPLEMENTACAO.md e começar Fase 1

Fase 7: Testar e Empacotar
└─ Seguir Fase 9 de IMPLEMENTACAO.md
```

---

**Sucesso na implementação! 🚀**

Qualquer dúvida, consulte o documento específico ou revise a estrutura em ARQUITETURA.md.
