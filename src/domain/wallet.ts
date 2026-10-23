import { DomainError } from './errors.js';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry.js';
import { CurrencyMismatchError, Money } from './money.js';

export class InsufficientFundsError extends DomainError {}
export class InvalidAmountError extends DomainError {}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. Saldo e ledger mudam juntos: toda movimentação devolve o
 * WalletLedgerEntry correspondente. A proteção contra concorrência entre
 * instâncias NÃO está aqui — é responsabilidade do banco (lock/constraints).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * O saldo inicial entra já materializado, com version 1. O lançamento de
   * OPENING (CREDIT de 0 -> saldo inicial) é criado pelo use case na mesma
   * transação SQL.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; now?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidAmountError('Initial balance cannot be negative');
    }
    const now = props.now ?? new Date();
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, now, now);
  }

  /** Reconstrução a partir da persistência — não revalida nada. */
  static rehydrate(s: WalletState): Wallet {
    return new Wallet(s.id, s.playerId, s.currency, s.balance, s.version, s.createdAt, s.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement);
  }

  private move(direction: LedgerDirection, m: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(m.money);
    if (!m.money.isPositive()) {
      throw new InvalidAmountError('Movement amount must be greater than zero');
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(m.money) : before.add(m.money);
    if (after.isNegative()) {
      throw new InsufficientFundsError('Insufficient funds');
    }
    // Cria o lançamento antes de mutar: se a criação falhar, o estado não muda.
    const entry = WalletLedgerEntry.create({
      id: m.entryId,
      walletId: this.id,
      transactionId: m.transactionId,
      direction,
      money: m.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: m.at,
    });
    this._balance = after;
    this._version += 1; // incrementa somente quando o saldo muda
    this._updatedAt = m.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet currency ${this.currency} vs ${money.currency}`);
    }
  }
}
