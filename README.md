# Wallet / Wagering — Jungle Gaming

Sistema financeiro de apostas: recebe transações de provedores (BET, WIN, LOSS, REFUND, ROLLBACK),
movimenta o saldo das wallets e mantém um **ledger imutável e auditável**. O foco é a correção sob
concorrência, mensagens duplicadas e falhas — não um CRUD. As decisões estão em [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 17 · MikroORM 7 · SQS (MiniStack) · Docker Compose.

## Status

| Parte | Estado |
|---|---|
| Domínio (`Money`, `Wallet`, ledger, `WagerTransaction`, eventos) | feito, testado |
| Processamento (concorrência, idempotência, regras de reversão) | feito, testado contra PostgreSQL real com 2 instâncias |
| API HTTP (wallets, transações, ledger paginado, reconciliação, health, métricas) | feito |
| Outbox publisher (worker), Inbox + consumer SQS, worker de `PENDING_REFERENCE` | **não implementado** (eventos já são gravados na outbox, na mesma transação) |
| App em contêiner / réplicas no Compose, teste de carga | **não implementado** |

## Setup

```bash
cp .env.example .env                 # ajuste se a porta 5432 do host estiver ocupada (padrão aqui: 5433)
docker compose up -d                 # PostgreSQL + MiniStack + job que cria as filas FIFO/DLQ
bun install
bun add @aws-sdk/client-sqs          # health check do SQS
bun run db:migrate                   # aplica as migrations
bun run start                        # API em http://localhost:3000
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun test` | testes unitários (domínio, use cases com dublê em memória, parsers, mapeamento HTTP) |
| `bun run test:integration` | integração **real**: PostgreSQL do Compose, banco novo por execução, 2 instâncias disputando as mesmas wallets |
| `bun run db:migrate` / `db:rollback` / `db:status` | migrations |
| `docker compose exec -T postgres psql -U wallet -d wallet < infra/postgres/verify-constraints.sql` | prova que o BANCO rejeita saldo negativo, ledger mutável, duplicidades etc. (roda em transação com ROLLBACK) |
| `bash scripts/smoke.sh` | fumaça manual da API |
| `bunx tsc --noEmit` | checagem de tipos |

## API

| Método e rota | Resposta |
|---|---|
| `POST /wallets` | 201 · 409 `WALLET_ALREADY_EXISTS` · 400 |
| `GET /wallets/:id` · `GET /wallets/:id/ledger?cursor=&limit=` | 200 · 404 · 400 |
| `POST /wallets/:id/reconciliation` | 200 (`consistent: false` sinaliza divergência) |
| `POST /wagering/transactions` (header `Idempotency-Key` obrigatório) | ver tabela abaixo |
| `GET /wagering/transactions/:id` · `GET /providers/:providerId/wagering/transactions/:externalId` | 200 · 404 |
| `GET /health/live` · `GET /health/ready` · `GET /metrics` | abertos, sem autenticação |

Status de `POST /wagering/transactions` (mesmo mapa em todos os endpoints; erros usam `{ "error": { "code", "message" } }`):

| Situação | HTTP | O provedor deve |
|---|---|---|
| processada / replay idempotente | 201 / 200 | nada |
| aceita, aguardando a referência | 202 | consultar depois; não reenviar |
| rejeitada por regra de negócio (`failureCode` no corpo) | 422 | tratar como definitivo |
| payload inválido | 400 | corrigir |
| mesma key com payload diferente | 409 | não reenviar igual |
| falha transitória (deadlock, conexão) | 503 + `Retry-After` | reenviar a **mesma** key |

Exemplo:

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"player-1","walletId":"<id>","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```
