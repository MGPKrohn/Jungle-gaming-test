import { EntitySchema } from '@mikro-orm/core';

/**
 * Modelos de PERSISTÊNCIA. O domínio (Wallet, WagerTransaction, ...) não conhece
 * o MikroORM: repositórios convertem registro <-> domínio via `rehydrate`.
 *
 * Usamos EntitySchema (sem decorators) para manter o domínio livre de metadados
 * e evitar dependência de reflect-metadata/decorators no Bun.
 *
 * Money é gravado em duas colunas: `numeric(20,2)` lido como string (o driver pg
 * devolve numeric como string, então nunca passa por float) + `char(3)`.
 *
 * Não usamos `version: true` do MikroORM: a concorrência é resolvida com lock
 * pessimista, e a regra de `version` é garantida por trigger no banco.
 * Requer UnderscoreNamingStrategy (padrão): playerId -> player_id.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', columnType: 'text' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  createdAt!: Date;
  processedAt?: Date | null;
  observedBalance?: string | null;
  referenceAttempts!: number;
  nextAttemptAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', columnType: 'text' },
    externalTransactionId: { type: 'string', columnType: 'text' },
    idempotencyKey: { type: 'string', columnType: 'text' },
    payloadHash: { type: 'string', columnType: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string', columnType: 'text' },
    roundId: { type: 'string', columnType: 'text' },
    gameId: { type: 'string', columnType: 'text' },
    kind: { type: 'string', columnType: 'text' },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', columnType: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string', columnType: 'text' },
    failureCode: { type: 'string', columnType: 'text', nullable: true },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    observedBalance: { type: 'string', columnType: 'numeric(20,2)', nullable: true },
    referenceAttempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string', columnType: 'text' },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'string', columnType: 'numeric(20,2)' },
    balanceAfter: { type: 'string', columnType: 'numeric(20,2)' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', columnType: 'text', primary: true },
    messageId: { type: 'string', columnType: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'text' },
    receivedAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', columnType: 'text' },
    eventType: { type: 'string', columnType: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});

export const persistenceSchemas = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
