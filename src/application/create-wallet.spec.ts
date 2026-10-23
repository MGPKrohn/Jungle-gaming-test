import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../domain/ledger-entry.js';
import { InvalidMoneyError } from '../domain/money.js';
import { WagerTransactionStatus as S } from '../domain/wager-transaction.js';
import { CreateWallet } from './create-wallet.js';
import { InvalidRequestError, WalletAlreadyExistsError } from './errors.js';
import { ProcessWagerTransaction } from './process-wager-transaction.js';
import { InMemoryStore } from './testing/in-memory-store.js';

const NOW = new Date('2026-10-23T12:00:00.000Z');
const brl = (amount: string) => ({ amount, currency: 'BRL' });

function setup() {
  const store = new InMemoryStore();
  let n = 0;
  const clock = { now: () => NOW };
  const ids = { next: () => `id-${++n}` };
  return {
    store,
    createWallet: new CreateWallet(store, clock, ids),
    processWager: new ProcessWagerTransaction(store, clock, ids),
  };
}

describe('CreateWallet', () => {
  test('saldo inicial > 0: wallet + OPENING + ledger CREDIT (0,00 -> saldo) + 2 eventos', async () => {
    const { store, createWallet } = setup();
    const result = await createWallet.execute({ playerId: 'p1', initialBalance: brl('1000.00'), correlationId: 'c' });

    expect(result).toEqual({ id: result.id, playerId: 'p1', balance: brl('1000.00'), version: 1 });
    expect(store.ledger).toHaveLength(1);
    const entry = store.ledger[0]!;
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON()).toEqual(brl('0.00'));
    expect(entry.balanceAfter.toJSON()).toEqual(brl('1000.00'));
    expect(store.transactionCount()).toBe(1);
    expect(store.eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(store.walletBalance(result.id)).toBe('1000.00');
  });

  test('saldo inicial zero: só a wallet, sem OPENING, ledger nem eventos', async () => {
    const { store, createWallet } = setup();
    const result = await createWallet.execute({ playerId: 'p1', initialBalance: brl('0.00'), correlationId: 'c' });
    expect(result.balance).toEqual(brl('0.00'));
    expect(store.transactionCount()).toBe(0);
    expect(store.ledger).toHaveLength(0);
    expect(store.events).toHaveLength(0);
  });

  test('(playerId, moeda) duplicado é conflito e não grava nada a mais', async () => {
    const { store, createWallet } = setup();
    await createWallet.execute({ playerId: 'p1', initialBalance: brl('10.00'), correlationId: 'c' });
    await expect(
      createWallet.execute({ playerId: 'p1', initialBalance: brl('99.00'), correlationId: 'c' }),
    ).rejects.toThrow(WalletAlreadyExistsError);
    expect(store.ledger).toHaveLength(1);
    expect(store.transactionCount()).toBe(1);

    // outra moeda para o mesmo jogador é permitida
    const usd = await createWallet.execute({
      playerId: 'p1',
      initialBalance: { amount: '5.00', currency: 'USD' },
      correlationId: 'c',
    });
    expect(usd.balance.currency).toBe('USD');
  });

  test('entrada inválida é recusada', async () => {
    const { createWallet } = setup();
    await expect(createWallet.execute({ playerId: 'p1', initialBalance: brl('10'), correlationId: 'c' })).rejects.toThrow(
      InvalidMoneyError,
    );
    await expect(createWallet.execute({ playerId: ' ', initialBalance: brl('1.00'), correlationId: 'c' })).rejects.toThrow(
      InvalidRequestError,
    );
  });

  test('fluxo completo: criar wallet 1000,00 e apostar 25,00 -> saldo 975,00', async () => {
    const { createWallet, processWager } = setup();
    const wallet = await createWallet.execute({ playerId: 'p1', initialBalance: brl('1000.00'), correlationId: 'c' });
    const result = await processWager.execute({
      idempotencyKey: 'provider-a:transaction-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'p1',
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      correlationId: 'c',
    });
    expect(result.status).toBe(S.Processed);
    expect(result.balance).toEqual(brl('975.00'));
  });
});
