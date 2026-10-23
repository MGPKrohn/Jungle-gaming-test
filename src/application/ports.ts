import type { IntegrationEvent } from '../domain/events.js';
import type { WalletLedgerEntry } from '../domain/ledger-entry.js';
import type { Money } from '../domain/money.js';
import type { Wallet } from '../domain/wallet.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';

/** Transação + o saldo observado quando foi resolvida (necessário ao replay, regra 7). */
export interface StoredTransaction {
  transaction: WagerTransaction;
  observedBalance?: Money;
}

export interface SaveOutcome {
  observedBalance?: Money;
  /** Só para PENDING_REFERENCE: quando o worker deve tentar de novo. */
  nextAttemptAt?: Date;
}

export interface WagerTransactionRepository {
  /**
   * INSERT ... ON CONFLICT DO NOTHING. true = esta chamada inseriu a linha e é
   * dona do processamento. false = já existia (idempotency_key OU
   * (provider, externalId) já usados). Sob READ COMMITTED, se houver inserção
   * concorrente não confirmada, o INSERT espera o commit do outro.
   */
  claim(transaction: WagerTransaction): Promise<boolean>;
  findByIdempotencyKey(key: string): Promise<StoredTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<StoredTransaction | undefined>;
  /** Regra 4 estrita: existe REFUND/ROLLBACK PROCESSED desta referência (de qualquer tipo)? */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  save(transaction: WagerTransaction, outcome: SaveOutcome): Promise<void>;
}

export interface WalletRepository {
  /** SELECT ... FOR UPDATE: trava só a linha desta wallet até o fim da transação SQL. */
  lockById(walletId: string): Promise<Wallet | undefined>;
  save(wallet: Wallet): Promise<void>;
  /** INSERT ... ON CONFLICT (player_id, currency) DO NOTHING. false = já existe wallet para o par. */
  insert(wallet: Wallet): Promise<boolean>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  /** Grava na outbox DENTRO da mesma transação SQL. Nunca publica. */
  enqueue(event: IntegrationEvent<unknown>): Promise<void>;
}

export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Uma transação SQL: commit se `work` resolve, rollback se lança. */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string; // UUID v7 em produção
}
