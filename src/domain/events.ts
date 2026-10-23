import type { LedgerDirection, WalletLedgerEntry } from './ledger-entry.js';
import type { Money, MoneyProps } from './money.js';
import type { Wallet } from './wallet.js';
import type { FailureCode, WagerTransaction } from './wager-transaction.js';

export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface SerializedIntegrationEvent<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Envelope de evento de integração. `eventType` e `version` ficam no TIPO da
 * subclasse, não em string solta no ponto de uso. `data` carrega MoneyProps
 * (string decimal), nunca a instância de Money: o payload é JSON estável.
 *
 * aggregateId é SEMPRE o walletId: dá ordenação por wallet (futuro
 * MessageGroupId da fila FIFO) e `data.transactionId` identifica a transação.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): SerializedIntegrationEvent<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, balance: Money, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balance: balance.toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, failureCode: FailureCode, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode,
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitido SOMENTE quando o saldo muda (LOSS e rejeições não emitem). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
