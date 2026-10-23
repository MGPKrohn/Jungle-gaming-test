import type { EntityManager } from '@mikro-orm/postgresql';
import type { TransactionScope, StoredTransaction } from '../../application/ports.js';
import { Money } from '../../domain/money.js';
import { Wallet } from '../../domain/wallet.js';
import {
  type FailureCode,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionState,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction.js';

type Row = Record<string, unknown>;

/**
 * Repositórios em SQL explícito, todos sobre o EntityManager da transação em curso.
 * Escolha deliberada: a ordem das escritas, o FOR UPDATE e o ON CONFLICT ficam
 * visíveis (e defensáveis), sem depender do flush/identity map do ORM.
 * Convenção do driver: placeholders `?`; SELECT devolve colunas em snake_case.
 */
export function createScope(em: EntityManager): TransactionScope {
  return {
    wallets: {
      lockById: async (id) => {
        const [row] = await query(
          em,
          `select id, player_id, currency, balance, version, created_at, updated_at
             from wallets where id = ? for update`,
          [id],
        );
        if (!row) return undefined;
        const currency = text(row.currency);
        return Wallet.rehydrate({
          id: text(row.id),
          playerId: text(row.player_id),
          currency,
          balance: Money.from({ amount: numeric(row.balance), currency }),
          version: Number(row.version),
          createdAt: date(row.created_at),
          updatedAt: date(row.updated_at),
        });
      },
      insert: async (wallet) => {
        const rows = await query(
          em,
          `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)
           on conflict (player_id, currency) do nothing
           returning id`,
          [
            wallet.id,
            wallet.playerId,
            wallet.currency,
            wallet.balance.toJSON().amount,
            wallet.version,
            wallet.createdAt,
            wallet.updatedAt,
          ],
        );
        return rows.length === 1;
      },
      save: async (wallet) => {
        await run(em, `update wallets set balance = ?, version = ?, updated_at = ? where id = ?`, [
          wallet.balance.toJSON().amount,
          wallet.version,
          wallet.updatedAt,
          wallet.id,
        ]);
      },
    },

    transactions: {
      claim: async (tx) => {
        // Sem alvo de conflito: cobre idempotency_key E (provider, external_id).
        // Com inserção concorrente não confirmada, o INSERT espera o commit do outro.
        const rows = await query(
          em,
          `insert into wager_transactions (
             id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency,
             reference_external_transaction_id, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
           on conflict do nothing
           returning id`,
          [
            tx.id,
            tx.providerId,
            tx.externalTransactionId,
            tx.idempotencyKey,
            tx.payloadHash,
            tx.walletId,
            tx.playerId,
            tx.roundId,
            tx.gameId,
            tx.kind,
            tx.money.toJSON().amount,
            tx.money.currency,
            tx.referenceExternalTransactionId ?? null,
            tx.createdAt,
          ],
        );
        return rows.length === 1;
      },
      findByIdempotencyKey: async (key) => {
        const [row] = await query(em, `select ${TX_COLUMNS} from wager_transactions where idempotency_key = ?`, [key]);
        return row ? toStored(row) : undefined;
      },
      findByProviderExternalId: async (providerId, externalId) => {
        const [row] = await query(
          em,
          `select ${TX_COLUMNS} from wager_transactions where provider_id = ? and external_transaction_id = ?`,
          [providerId, externalId],
        );
        return row ? toStored(row) : undefined;
      },
      findProcessedReversalOf: async (referenceId) => {
        const [row] = await query(
          em,
          `select ${TX_COLUMNS} from wager_transactions
            where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
            limit 1`,
          [referenceId],
        );
        return row ? toStored(row).transaction : undefined;
      },
      save: async (tx, outcome) => {
        await run(
          em,
          `update wager_transactions
              set status = ?, failure_code = ?, reference_transaction_id = ?,
                  processed_at = ?, observed_balance = ?, next_attempt_at = ?
            where id = ?`,
          [
            tx.status,
            tx.failureCode ?? null,
            tx.referenceTransactionId ?? null,
            tx.processedAt ?? null,
            outcome.observedBalance?.toJSON().amount ?? null,
            outcome.nextAttemptAt ?? null,
            tx.id,
          ],
        );
      },
    },

    ledger: {
      append: async (entry) => {
        await run(
          em,
          `insert into wallet_ledger_entries (
             id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.walletId,
            entry.transactionId,
            entry.direction,
            entry.money.toJSON().amount,
            entry.money.currency,
            entry.balanceBefore.toJSON().amount,
            entry.balanceAfter.toJSON().amount,
            entry.createdAt,
          ],
        );
      },
    },

    outbox: {
      enqueue: async (event) => {
        await run(
          em,
          `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
           values (?, ?, ?, cast(? as jsonb), ?, 0)`,
          [event.eventId, event.aggregateId, event.eventType, JSON.stringify(event.toJSON()), event.occurredAt],
        );
      },
    },
  };
}

const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
  player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, created_at, processed_at, observed_balance`;

function toStored(row: Row): StoredTransaction {
  const currency = text(row.currency);
  const state: WagerTransactionState = {
    id: text(row.id),
    providerId: text(row.provider_id),
    externalTransactionId: text(row.external_transaction_id),
    idempotencyKey: text(row.idempotency_key),
    payloadHash: text(row.payload_hash),
    walletId: text(row.wallet_id),
    playerId: text(row.player_id),
    roundId: text(row.round_id),
    gameId: text(row.game_id),
    kind: text(row.kind) as WagerTransactionKind,
    money: Money.from({ amount: numeric(row.amount), currency }),
    referenceExternalTransactionId: optionalText(row.reference_external_transaction_id),
    createdAt: date(row.created_at),
    status: text(row.status) as WagerTransactionStatus,
    referenceTransactionId: optionalText(row.reference_transaction_id),
    failureCode: optionalText(row.failure_code) as FailureCode | undefined,
    processedAt: row.processed_at == null ? undefined : date(row.processed_at),
  };
  return {
    transaction: WagerTransaction.rehydrate(state),
    ...(row.observed_balance == null
      ? {}
      : { observedBalance: Money.from({ amount: numeric(row.observed_balance), currency }) }),
  };
}

async function query(em: EntityManager, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await em.execute(sql, params, 'all')) as unknown as Row[];
}

async function run(em: EntityManager, sql: string, params: unknown[] = []): Promise<void> {
  await em.execute(sql, params, 'run');
}

export function text(value: unknown): string {
  return String(value);
}

export function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

/** numeric(20,2) TEM que chegar como string: um number significaria float no caminho do dinheiro. */
export function numeric(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`numeric column must be returned as string, got ${typeof value}`);
  }
  return value;
}

export function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
