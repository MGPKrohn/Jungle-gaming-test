import type { MoneyProps } from '../domain/money.js';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  failureCode?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Lado de leitura (sem lock, sem transação de escrita). `undefined` = não encontrado. */
export interface WalletQueries {
  getWallet(walletId: string): Promise<WalletView | undefined>;
  getLedger(walletId: string, page: { cursor?: string; limit: number }): Promise<LedgerPageView | undefined>;
  getTransactionById(transactionId: string): Promise<TransactionView | undefined>;
  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined>;
  reconcile(walletId: string): Promise<ReconciliationView | undefined>;
}

/** Sonda de saúde para /health/ready. */
export interface HealthProbe {
  readonly name: string;
  check(): Promise<void>;
}
