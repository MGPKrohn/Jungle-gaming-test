# ARCHITECTURE

## 1. Camadas

```
api/ (Nest: controllers, filtro de erros, guard, métricas)      <- borda HTTP, validação, mapeamento de status
application/ (use cases + PORTAS: UnitOfWork, repositórios...)  <- orquestra, sem conhecer ORM nem HTTP
domain/ (Money, Wallet, WalletLedgerEntry, WagerTransaction, eventos) <- invariantes, sem framework
infrastructure/ (MikroORM + SQL, migrations, probes)            <- adaptadores das portas
```

O domínio não importa Nest nem MikroORM. `app.module.ts` é o único lugar que conhece as implementações.
Os modelos de persistência (`schemas.ts`, `EntitySchema`) são separados das classes de domínio, que têm
construtor privado e reidratam via `rehydrate`.

## 2. Decisões e trade-offs

**Dinheiro.** `Money` guarda `bigint` em centavos (escala fixa 2). Entrada só como string com exatamente 2 casas
(`"25.00"`; recusa `25`, `25.001`, negativos, `1e3`). Escala exata também estabiliza o `payloadHash`. No banco:
`numeric(20,2)`, lido como string — o adaptador **lança erro** se o driver devolver `number`. Trade-off: não usei
`Decimal` porque, com escala fixa, `bigint` é exato e dispensa dependência.

**Concorrência.** Lock pessimista por wallet: `SELECT ... FROM wallets WHERE id = ? FOR UPDATE` dentro da transação SQL.
Só operações da MESMA wallet se serializam; wallets diferentes seguem em paralelo. Escolhi `FOR UPDATE` em vez de
`UPDATE ... WHERE balance >= x` porque o ledger exige `balanceBefore/After` e `version`, e ler o estado travado deixa o
invariante trivial de provar. Custo: contenção numa wallet muito quente (medida no teste "hot wallet": 50 apostas
simultâneas). Isolamento exigido: READ COMMITTED (padrão). `now` é capturado **depois** do lock, para que os timestamps
do ledger sigam a ordem de serialização. Última linha de defesa no banco: `CHECK (balance >= 0)`.

**Idempotência (persistente, no Postgres).** `INSERT ... ON CONFLICT DO NOTHING` reivindica a transação
(`UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`). Perdeu o claim → lê a linha existente:
payload igual → replay com o resultado **guardado** (incluindo o saldo observado na época, coluna `observed_balance`);
payload diferente → 409, nunca replay. Duas requisições idênticas simultâneas: a segunda espera o commit da primeira.
`payloadHash` = SHA-256 (hex) do JSON canônico (chaves ordenadas recursivamente, sem espaços, `undefined` omitido) dos
campos de negócio `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency},
referenceExternalTransactionId`. O header `Idempotency-Key` e metadados de transporte **não** entram no hash.

**Rejeição é commit, não rollback.** Uma rejeição por regra de negócio grava a linha como `REJECTED` (auditável) e seu
evento. Só falha de infraestrutura desfaz tudo (e então nada foi gravado, e reenviar é seguro). `wager_transactions.wallet_id`
**não** tem FK de propósito: uma transação para wallet inexistente precisa ser gravada como `REJECTED`/`WALLET_NOT_FOUND`
para ser idempotente. O ledger, que move dinheiro, tem FK.

**Reversões (regra 4 ESTRITA).** Uma referência só pode ser revertida **uma vez, por qualquer tipo** (índice único parcial
em `reference_transaction_id` para `REFUND`/`ROLLBACK` processados). A leitura literal ("pelo mesmo tipo") permitiria
`BET` → `REFUND` → `ROLLBACK(BET)`: um débito, dois créditos. Interpretação deliberada; `ROLLBACK` do `REFUND` continua válido
(referencia o refund). `ROLLBACK` que deixaria saldo negativo → `REVERSAL_WOULD_OVERDRAW`.

**Referência ausente.** `PENDING_REFERENCE` com política de espera `min(2s·2ⁿ, 60s)`, 10 tentativas (~6 min), depois
`REJECTED/REFERENCE_NOT_FOUND`. A referência é lida **depois** do lock da wallet.

**Outbox transacional.** Transação, wallet, ledger e eventos são gravados na mesma transação SQL; nada é publicado dentro
dela (nunca há evento antes do commit). `aggregateId` = `walletId` (ordenação por wallet; futuro `MessageGroupId`).
`WalletBalanceChanged` só é emitido quando o saldo muda (não para `LOSS` nem rejeições).

**Persistência.** SQL explícito nas operações críticas (claim, `FOR UPDATE`, `ON CONFLICT`) em vez do Unit of Work do ORM:
a ordem das escritas fica visível. MikroORM cuida de conexão, transação e migrations.

**Reconciliação.** Uma única instrução SQL compara `wallets.balance` com a soma do ledger (um snapshot só, sem falsa
divergência por escrita concorrente). Divergência não é corrigida: é logada, contada em `reconciliation_divergences_total`
e sinalizada na resposta (`consistent: false`).

**Paginação do ledger.** Cursor opaco = base64url de `(created_at, id)`; consulta `(created_at, id) > cursor`. Estável
mesmo com inserções concorrentes (OFFSET não seria).

**Autenticação.** Não implementada (não vale pontos; seção 2 do enunciado). Ponto de extensão explícito: `NoopAuthGuard`
nos controllers de negócio. Desenho previsto: JWT/OIDC de um IdP externo (Keycloak/Zitadel), validado por guard, exigindo
que o `providerId` do token seja o do corpo. Health e `/metrics` ficam abertos.

**Observabilidade.** Log JSON por requisição (sem payload financeiro), `correlationId` (`traceparent` > `X-Correlation-Id`
> gerado, ecoado na resposta), métricas Prometheus em `/metrics` (contadores por instância), `/health/live` e
`/health/ready` (PostgreSQL e SQS).

## 3. Garantias no banco (migrations + `infra/postgres/verify-constraints.sql`)

Saldo nunca negativo · `version` só sobe quando o saldo muda · `UNIQUE(player_id, currency)` · `UNIQUE(idempotency_key)` ·
`UNIQUE(provider_id, external_transaction_id)` · uma reversão por referência · ledger append-only (trigger bloqueia
UPDATE/DELETE/TRUNCATE) e aritmético (`before ± amount = after`) · estados terminais imutáveis · inbox deduplicada por
`(consumer_name, message_id)`. O script de verificação confirma cada uma (38 checagens, em transação com ROLLBACK).

## 4. Estratégia de testes

- **Unitários** (`bun test`): domínio, use cases com dublê em memória (decisão, replay, reversões, atomicidade), parsers,
  cursor, mapeamento HTTP. O dublê **não** prova concorrência.
- **Integração real** (`bun run test:integration`): PostgreSQL do Compose, banco novo por execução, **duas instâncias**
  (dois ORMs/pools). Cobre: 2 apostas de 80,00 simultâneas; hot wallet (50 apostas); idempotência concorrente; payloads
  conflitantes em paralelo; `REFUND` × `ROLLBACK` em corrida; criação de wallet duplicada em paralelo; paginação; reconciliação.

## 5. Limitações conhecidas (estado atual)

- **Não implementados:** worker da outbox (publicação no SQS), inbox + consumer SQS (DLQ, retry, shutdown da fila), worker de
  `PENDING_REFERENCE`, app em contêiner com réplicas no Compose, teste de carga. Os eventos já são gravados na outbox.
- Métricas são por instância (sem agregação) e só contadores (sem histogramas de latência).
- Retentativa automática de deadlock/serialização não existe na aplicação: o erro vira 503 e o provedor reenvia a mesma key.
- Sem testes HTTP ponta a ponta automatizados (há `scripts/smoke.sh`).
