import type { MikroORM } from '@mikro-orm/postgresql';
import { decodeCursor, encodeCursor } from '../../application/cursor.js';
import type {
  LedgerEntryView,
  LedgerPageView,
  ReconciliationView,
  TransactionView,
  WalletQueries,
  WalletView,
} from '../../application/queries.js';
import { Money } from '../../domain/money.js';
import { date, numeric, optionalText, text } from './postgres-scope.js';

type Row = Record<string, unknown>;

const TX_COLUMNS = `id, provider_id, external_transaction_id, wallet_id, player_id, round_id, game_id, kind,
  amount, currency, reference_external_transaction_id, status, failure_code, observed_balance, created_at, processed_at`;

/** Lado de leitura: SQL direto, sem lock. Cada consulta usa um EntityManager limpo (fork). */
export class PostgresWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  private async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.orm.em.fork().execute(sql, params, 'all')) as unknown as Row[];
  }

  async getWallet(walletId: string): Promise<WalletView | undefined> {
    const [row] = await this.all(
      `select id, player_id, currency, balance, version, created_at, updated_at from wallets where id = ?`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      id: text(row.id),
      playerId: text(row.player_id),
      balance: money(row.balance, row.currency),
      version: Number(row.version),
      createdAt: date(row.created_at).toISOString(),
      updatedAt: date(row.updated_at).toISOString(),
    };
  }

  async getLedger(walletId: string, page: { cursor?: string; limit: number }): Promise<LedgerPageView | undefined> {
    const [exists] = await this.all(`select 1 as ok from wallets where id = ?`, [walletId]);
    if (!exists) return undefined;

    const after = page.cursor ? decodeCursor(page.cursor) : undefined;
    const rows = await this.all(
      `select id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
         from wallet_ledger_entries
        where wallet_id = ? ${after ? 'and (created_at, id) > (?, ?)' : ''}
        order by created_at, id
        limit ?`,
      after ? [walletId, after.createdAt, after.id, page.limit + 1] : [walletId, page.limit + 1],
    );

    const items: LedgerEntryView[] = rows.slice(0, page.limit).map((row) => ({
      id: text(row.id),
      transactionId: text(row.transaction_id),
      direction: text(row.direction) as 'CREDIT' | 'DEBIT',
      money: money(row.amount, row.currency),
      balanceBefore: money(row.balance_before, row.currency),
      balanceAfter: money(row.balance_after, row.currency),
      createdAt: date(row.created_at).toISOString(),
    }));
    const last = rows[page.limit - 1];
    const hasMore = rows.length > page.limit && last !== undefined;
    return {
      items,
      nextCursor: hasMore ? encodeCursor({ createdAt: date(last.created_at), id: text(last.id) }) : null,
    };
  }

  async getTransactionById(transactionId: string): Promise<TransactionView | undefined> {
    const [row] = await this.all(`select ${TX_COLUMNS} from wager_transactions where id = ?`, [transactionId]);
    return row ? toTransactionView(row) : undefined;
  }

  async getTransactionByExternalId(providerId: string, externalId: string): Promise<TransactionView | undefined> {
    const [row] = await this.all(
      `select ${TX_COLUMNS} from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalId],
    );
    return row ? toTransactionView(row) : undefined;
  }

  /**
   * Compara o saldo armazenado com o recalculado a partir do ledger. Uma ÚNICA
   * instrução = um único snapshot: wallet e ledger são confirmados atomicamente,
   * então uma escrita concorrente nunca produz falsa divergência.
   * Nada é corrigido aqui: quem chama loga, conta em métrica e sinaliza na resposta.
   */
  async reconcile(walletId: string): Promise<ReconciliationView | undefined> {
    const [row] = await this.all(
      `select w.currency as currency,
              w.balance as stored,
              cast(coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as numeric(20,2)) as calculated,
              count(l.id) as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id, w.currency, w.balance`,
      [walletId],
    );
    if (!row) return undefined;
    const stored = Money.from({ amount: numeric(row.stored), currency: text(row.currency) });
    const calculated = Money.from({ amount: numeric(row.calculated), currency: text(row.currency) });
    const difference = stored.subtract(calculated);
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: Number(row.entries),
    };
  }
}

function money(amount: unknown, currency: unknown) {
  return Money.from({ amount: numeric(amount), currency: text(currency) }).toJSON();
}

function toTransactionView(row: Row): TransactionView {
  const reference = optionalText(row.reference_external_transaction_id);
  const failureCode = optionalText(row.failure_code);
  return {
    transactionId: text(row.id),
    providerId: text(row.provider_id),
    externalTransactionId: text(row.external_transaction_id),
    walletId: text(row.wallet_id),
    playerId: text(row.player_id),
    roundId: text(row.round_id),
    gameId: text(row.game_id),
    kind: text(row.kind),
    status: text(row.status),
    money: money(row.amount, row.currency),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(row.observed_balance == null ? {} : { balance: money(row.observed_balance, row.currency) }),
    createdAt: date(row.created_at).toISOString(),
    ...(row.processed_at == null ? {} : { processedAt: date(row.processed_at).toISOString() }),
  };
}
