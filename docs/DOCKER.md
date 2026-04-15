# DOCKER.md — Infraestrutura e Persistência de Dados

## Decisão Arquitetural: Por que SQLite e não PostgreSQL + Redis

O spec do desafio lista PostgreSQL e Redis como **sugestões**, não requisitos. O checklist oficial diz explicitamente "PostgreSQL **ou** SQLite". O docker-compose.yml é marcado como "(Opcional)".

Para um processo seletivo, a escolha certa é **SQLite**:

| Critério | SQLite | PostgreSQL + Redis |
|---|---|---|
| Infra necessária | Zero (arquivo em disco) | 2 serviços adicionais |
| Persistência | ✅ Arquivo sobrevive a restarts | ✅ Volumes Docker |
| Idempotência garantida | ✅ Transações ACID nativas | ✅ |
| Complexidade de setup | `npm install better-sqlite3` | docker-compose com 3 serviços |
| Demonstra o conceito | ✅ Igual | ✅ Igual |
| Adequado ao escopo | ✅ | ❌ Over-engineering |

SQLite é síncrono, transacional, e resolve exatamente o que o desafio pede. O código fica com uma abstração (`TransactionStore`) que pode ser trocada por PostgreSQL em produção — e documentar isso de forma explícita é mais valioso do que já entregar o PostgreSQL configurado.

O circuit breaker in-memory (por processo) é igualmente correto para este escopo. O próprio spec reconhece: *"Solução Prática: Implementar em cada pod com estados sincronizados via logs."*

---

## Arquitetura

```
┌─────────────────────────────────┐
│  Host (sua máquina)              │
│                                  │
│  ./data/transactions.db  ◄───┐  │
│                               │  │
│  ┌────────────────────────┐  │  │
│  │  pos_api (container)   │  │  │
│  │  Node.js 22 Alpine     │  │  │
│  │  :3000                 │  │  │
│  │                        │  │  │
│  │  better-sqlite3 ───────┘  │  │
│  │  (arquivo local no vol)   │  │
│  └────────────────────────┘  │  │
│         ↑                        │
│   volume mount: ./data:/app/data │
└─────────────────────────────────┘
```

Um container. Um arquivo de banco. Sem dependências externas.

---

## Pré-requisitos

```bash
docker --version          # Docker 24+
docker compose version    # Docker Compose v2
```

---

## Setup

```bash
# 1. Copiar variáveis de ambiente
cp .env.example .env

# 2. Subir a API
docker compose up -d

# 3. Testar
curl http://localhost:3000/health
# {"status":"ok"}
```

O diretório `./data/` é criado automaticamente na primeira execução. O arquivo `transactions.db` persiste entre restarts do container.

---

## Comandos do Dia-a-Dia

```bash
# Ver logs em tempo real
docker compose logs -f

# Reiniciar (código muda com hot-reload, mas restart explícito às vezes necessário)
docker compose restart api

# Parar (dados permanecem em ./data/transactions.db)
docker compose down

# Resetar dados completamente
docker compose down
rm -rf ./data
docker compose up -d

# Inspecionar o banco SQLite
docker compose exec api npx ts-node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH);
  console.log(db.prepare('SELECT * FROM transactions').all());
"

# Ou fora do container (se tiver sqlite3 instalado localmente)
sqlite3 ./data/transactions.db "SELECT * FROM transactions;"
```

---

## Persistência: Como Funciona

O volume `./data:/app/data` mapeia um diretório local para dentro do container. O SQLite grava nesse diretório:

```
pos-transaction-api/
└── data/                      ← criado automaticamente
    └── transactions.db        ← arquivo SQLite (NÃO commitar)
```

Adicionar ao `.gitignore`:
```
data/
```

---

## Dockerfile: Multi-Stage

O Dockerfile mantém a estrutura multi-stage, mas o stage `development` é o único usado pelo Compose em dev local. O stage `production` produz uma imagem mínima (~150MB) para deploy:

```bash
# Build de produção
docker build --target production -t pos-api:prod .
docker run -p 3000:3000 -v $(pwd)/data:/app/data pos-api:prod
```

---

## Quando Trocar SQLite por PostgreSQL

Quando o projeto deixar de ser um desafio e virar produção com múltiplas instâncias:

1. Implementar `PostgresTransactionStore` seguindo a mesma interface `ITransactionStore`
2. Trocar a injeção em `transactionService.ts`
3. Adicionar PostgreSQL ao docker-compose
4. Rodar migrations com o `init.sql` já preparado

A abstração `ITransactionStore` no código garante que essa troca seja cirúrgica — sem impacto nas rotas, middleware ou lógica de negócio.
