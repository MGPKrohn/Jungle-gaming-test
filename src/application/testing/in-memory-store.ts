import type { IntegrationEvent } from '../../domain/events.js';
import type { WalletLedgerEntry } from '../../domain/ledger-entry.js';
import type { Money } from '../../domain/money.js';
import { Wallet, type WalletState } from '../../domain/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransactionState,
} from '../../domain/wager-transaction.js';
import type { StoredTransaction, TransactionScope, UnitOfWork } from '../ports.js';

interface Row {
  state: WagerTransactionState;
  observedBalance?: Money | undefined;
  nextAttemptAt?: Date | undefined;
}

/**
 * Dublê em memória SÓ para testar a lógica de decisão do use case (reversões,
 * replay, pendências). NÃO prova concorrência nem constraints: isso é papel dos
 * testes de integração contra PostgreSQL real. `run` é sequencial e desfaz o
 * estado se `work` lançar, imitando o rollback.
 */
export class InMemoryStore implements UnitOfWork {
  private wallets = new Map<string, WalletState>();
  private transactions = new Map<string, Row>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
  failLedgerAppendWith: Error | undefined;

  seedWallet(id: string, playerId: string, balance: Money): void {
    const at = new Date(0);
    this.wallets.set(id, { id, playerId, currency: balance.currency, balance, version: 1, createdAt: at, updatedAt: at });
  }

  eventTypes(): string[] {
    return this.events.map((event) => event.eventType);
  }
  walletBalance(id: string): string | undefined {
    return this.wallets.get(id)?.balance.toJSON().amount;
  }
  walletVersion(id: string): number | undefined {
    return this.wallets.get(id)?.version;
  }
  transactionCount(): number {
    return this.transactions.size;
  }
  nextAttemptAt(transactionId: string): Date | undefined {
    return this.transactions.get(transactionId)?.nextAttemptAt;
  }

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    const snapshot = {
      wallets: new Map(this.wallets),
      transactions: new Map(this.transactions),
      ledger: [...this.ledger],
      events: [...this.events],
    };
    try {
      return await work(this.scope);
    } catch (error) {
      this.wallets = snapshot.wallets;
      this.transactions = snapshot.transactions;
      this.ledger = snapshot.ledger;
      this.events = snapshot.events;
      throw error;
    }
  }

  private readonly scope: TransactionScope = {
    wallets: {
      lockById: async (id) => {
        const state = this.wallets.get(id);
        return state ? Wallet.rehydrate({ ...state }) : undefined;
      },
      save: async (wallet) => {
        this.wallets.set(wallet.id, walletState(wallet));
      },
      insert: async (wallet) => {
        const duplicate = [...this.wallets.values()].some(
          (w) => w.playerId === wallet.playerId && w.currency === wallet.currency,
        );
        if (duplicate) return false;
        this.wallets.set(wallet.id, walletState(wallet));
        return true;
      },
    },
    transactions: {
      claim: async (tx) => {
        const duplicate = [...this.transactions.values()].some(
          ({ state }) =>
            state.idempotencyKey === tx.idempotencyKey ||
            (state.providerId === tx.providerId && state.externalTransactionId === tx.externalTransactionId),
        );
        if (duplicate) return false;
        this.transactions.set(tx.id, { state: toState(tx) });
        return true;
      },
      findByIdempotencyKey: async (key) =>
        this.find(({ state }) => state.idempotencyKey === key),
      findByProviderExternalId: async (providerId, externalId) =>
        this.find(({ state }) => state.providerId === providerId && state.externalTransactionId === externalId),
      findProcessedReversalOf: async (referenceId) =>
        this.find(
          ({ state }) =>
            state.status === WagerTransactionStatus.Processed &&
            (state.kind === WagerTransactionKind.Refund || state.kind === WagerTransactionKind.Rollback) &&
            state.referenceTransactionId === referenceId,
        )?.transaction,
      save: async (tx, outcome) => {
        this.transactions.set(tx.id, {
          state: toState(tx),
          observedBalance: outcome.observedBalance,
          nextAttemptAt: outcome.nextAttemptAt,
        });
      },
    },
    ledger: {
      append: async (entry) => {
        if (this.failLedgerAppendWith) throw this.failLedgerAppendWith;
        this.ledger.push(entry);
      },
    },
    outbox: {
      enqueue: async (event) => {
        this.events.push(event);
      },
    },
  };

  private find(predicate: (row: Row) => boolean): StoredTransaction | undefined {
    for (const row of this.transactions.values()) {
      if (predicate(row)) {
        return {
          transaction: WagerTransaction.rehydrate(row.state),
          ...(row.observedBalance ? { observedBalance: row.observedBalance } : {}),
        };
      }
    }
    return undefined;
  }
}

function toState(tx: WagerTransaction): WagerTransactionState {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
  };
}

function walletState(wallet: Wallet): WalletState {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
