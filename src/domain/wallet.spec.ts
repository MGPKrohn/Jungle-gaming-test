import { describe, expect, test } from 'bun:test';
import { LedgerDirection, UnbalancedLedgerEntryError, WalletLedgerEntry } from './ledger-entry.js';
import { CurrencyMismatchError, Money } from './money.js';
import { InsufficientFundsError, InvalidAmountError, Wallet, type WalletMovement } from './wallet.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00.000Z');
const mv = (n: number, amount: string): WalletMovement => ({
  entryId: `e${n}`,
  transactionId: `tx${n}`,
  money: brl(amount),
  at,
});
const openWallet = (amount = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), now: at });

describe('Wallet', () => {
  test('open: version 1 e moeda derivada do saldo inicial', () => {
    const w = openWallet();
    expect(w.version).toBe(1);
    expect(w.currency).toBe('BRL');
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  test('BET de 25 sobre 100 gera ledger 100 -> 75 e incrementa version', () => {
    const w = openWallet();
    const entry = w.debit(mv(1, '25.00'));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
    expect(w.balance.toJSON().amount).toBe('75.00');
    expect(w.version).toBe(2);
  });

  test('cenário obrigatório: saldo 100, duas apostas de 80 -> só uma debita', () => {
    const w = openWallet();
    const entries = [w.debit(mv(1, '80.00'))];
    expect(() => w.debit(mv(2, '80.00'))).toThrow(InsufficientFundsError);
    expect(entries).toHaveLength(1);
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(2); // a tentativa rejeitada não muda a version
  });

  test('saldo exato pode zerar, mas nunca ficar negativo', () => {
    const w = openWallet('10.00');
    w.debit(mv(1, '10.00'));
    expect(w.balance.isZero()).toBe(true);
    expect(() => w.debit(mv(2, '0.01'))).toThrow(InsufficientFundsError);
  });

  test('moeda diferente da wallet é erro de domínio e não altera estado', () => {
    const w = openWallet();
    const usd: WalletMovement = { ...mv(1, '1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('valor zero é rejeitado', () => {
    const w = openWallet();
    expect(() => w.debit({ ...mv(1, '0.00') })).toThrow(InvalidAmountError);
    expect(() => w.credit({ ...mv(1, '0.00') })).toThrow(InvalidAmountError);
  });

  test('invariante: saldo da wallet == saldo reconstruído pelo ledger', () => {
    const w = openWallet('100.00');
    const entries = [w.debit(mv(1, '25.00')), w.credit(mv(2, '50.00')), w.debit(mv(3, '10.10'))];
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Debit ? acc.subtract(e.money) : acc.add(e.money)),
      brl('100.00'),
    );
    expect(rebuilt.equals(w.balance)).toBe(true);
    expect(w.balance.toJSON().amount).toBe('114.90');
    entries.forEach((e, i) => {
      if (i > 0) expect(e.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
    });
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const w = Wallet.rehydrate({
      id: 'w1', playerId: 'p1', currency: 'BRL', balance: brl('5.00'), version: 7, createdAt: at, updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toJSON().amount).toBe('5.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1', walletId: 'w1', transactionId: 'tx1', direction: LedgerDirection.Debit,
    money: brl('25.00'), balanceBefore: brl('100.00'), balanceAfter: brl('75.00'), createdAt: at,
  };

  test('create valida a aritmética do lançamento', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('76.00') })).toThrow(UnbalancedLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(
      UnbalancedLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('100.00') })).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(() => {
      (entry as unknown as { id: string }).id = 'other';
    }).toThrow();
  });
});
