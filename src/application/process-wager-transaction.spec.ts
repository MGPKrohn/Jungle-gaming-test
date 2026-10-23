import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../domain/ledger-entry.js';
import { InvalidMoneyError, Money } from '../domain/money.js';
import { FailureCode, InvalidTransactionError, WagerTransactionStatus as S } from '../domain/wager-transaction.js';
import { IdempotencyConflictError } from './errors.js';
import { nextReferenceAttemptAt, referenceRetryDelayMs } from './pending-reference-policy.js';
import { ProcessWagerTransaction, type ProcessWagerTransactionCommand } from './process-wager-transaction.js';
import { InMemoryStore } from './testing/in-memory-store.js';

const W = 'wallet-1';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const brl = (amount: string) => ({ amount, currency: 'BRL' });

function setup(initial = '100.00') {
  const store = new InMemoryStore();
  store.seedWallet(W, 'p1', Money.from(brl(initial)));
  let n = 0;
  const useCase = new ProcessWagerTransaction(store, { now: () => NOW }, { next: () => `id-${++n}` });
  return { store, useCase };
}

const cmd = (ext: string, over: Partial<ProcessWagerTransactionCommand> = {}): ProcessWagerTransactionCommand => ({
  idempotencyKey: `prov:${ext}`,
  providerId: 'prov',
  externalTransactionId: ext,
  playerId: 'p1',
  walletId: W,
  roundId: 'r1',
  gameId: 'g1',
  kind: 'BET',
  money: brl('25.00'),
  correlationId: 'corr-1',
  ...over,
});

describe('BET', () => {
  test('debita, gera 1 lançamento, 2 eventos e incrementa a version', async () => {
    const { store, useCase } = setup();
    const result = await useCase.execute(cmd('bet-1'));

    expect(result.status).toBe(S.Processed);
    expect(result.balance).toEqual(brl('75.00'));
    expect(result.idempotentReplay).toBe(false);
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]!.direction).toBe(LedgerDirection.Debit);
    expect(store.eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(store.walletBalance(W)).toBe('75.00');
    expect(store.walletVersion(W)).toBe(2);
  });

  test('envelope do WalletBalanceChanged segue o contrato do enunciado', async () => {
    const { store, useCase } = setup();
    const result = await useCase.execute(cmd('bet-1'));
    const json = store.events[1]!.toJSON() as unknown as Record<string, unknown>;

    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(W);
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe(result.transactionId);
    expect(json.occurredAt).toBe('2026-10-23T12:00:00.000Z');
    expect(json.data).toEqual({
      walletId: W,
      transactionId: result.transactionId,
      direction: 'DEBIT',
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
      walletVersion: 2,
    });
  });

  test('cenário obrigatório: duas apostas de 80 -> uma PROCESSED, outra REJECTED, saldo 20', async () => {
    const { store, useCase } = setup();
    const a = await useCase.execute(cmd('bet-a', { money: brl('80.00') }));
    const b = await useCase.execute(cmd('bet-b', { money: brl('80.00') }));

    expect(a.status).toBe(S.Processed);
    expect(b.status).toBe(S.Rejected);
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(b.balance).toEqual(brl('20.00'));
    expect(store.ledger).toHaveLength(1);
    expect(store.walletVersion(W)).toBe(2);
    expect(store.eventTypes()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionRejected',
    ]);
  });
});

describe('idempotência', () => {
  test('replay devolve o mesmo resultado sem novo débito, ledger ou evento', async () => {
    const { store, useCase } = setup();
    const command = cmd('bet-1');
    const first = await useCase.execute(command);
    const replay = await useCase.execute(command);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(store.ledger).toHaveLength(1);
    expect(store.events).toHaveLength(2);
    expect(store.walletBalance(W)).toBe('75.00');
  });

  test('replay de rejeitada devolve o saldo observado na época (regra 7)', async () => {
    const { useCase } = setup();
    await useCase.execute(cmd('bet-a', { money: brl('80.00') }));
    const rejectedCommand = cmd('bet-b', { money: brl('80.00') });
    await useCase.execute(rejectedCommand);
    await useCase.execute(cmd('win-1', { kind: 'WIN', money: brl('50.00') })); // saldo vira 70.00

    const replay = await useCase.execute(rejectedCommand);
    expect(replay.status).toBe(S.Rejected);
    expect(replay.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(replay.balance).toEqual(brl('20.00'));
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mesma key com payload diferente é conflito, não replay', async () => {
    const { store, useCase } = setup();
    const command = cmd('bet-1');
    await useCase.execute(command);
    await expect(useCase.execute({ ...command, money: brl('30.00') })).rejects.toThrow(IdempotencyConflictError);
    expect(store.ledger).toHaveLength(1);
  });

  test('mesmo (provider, externalId) sob outra key é conflito', async () => {
    const { useCase } = setup();
    const command = cmd('bet-1');
    await useCase.execute(command);
    await expect(useCase.execute({ ...command, idempotencyKey: 'outra-key' })).rejects.toThrow(
      IdempotencyConflictError,
    );
  });
});

describe('rejeições de negócio', () => {
  test('wallet inexistente', async () => {
    const { store, useCase } = setup();
    const result = await useCase.execute(cmd('bet-1', { walletId: 'missing' }));
    expect(result.status).toBe(S.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);
    expect(result.balance).toBeUndefined();
    expect(store.eventTypes()).toEqual(['WagerTransactionRejected']);
  });

  test('moeda diferente da wallet', async () => {
    const { store, useCase } = setup();
    const result = await useCase.execute(cmd('bet-1', { money: { amount: '25.00', currency: 'USD' } }));
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(store.walletBalance(W)).toBe('100.00');
    expect(store.ledger).toHaveLength(0);
  });
});

describe('WIN e LOSS', () => {
  test('WIN credita', async () => {
    const { store, useCase } = setup();
    const result = await useCase.execute(cmd('win-1', { kind: 'WIN', money: brl('50.00') }));
    expect(result.balance).toEqual(brl('150.00'));
    expect(store.ledger[0]!.direction).toBe(LedgerDirection.Credit);
  });

  test('LOSS não move saldo, não gera ledger e não emite WalletBalanceChanged', async () => {
    const { store, useCase } = setup();
    await useCase.execute(cmd('bet-1'));
    const ledgerBefore = store.ledger.length;
    const result = await useCase.execute(
      cmd('loss-1', { kind: 'LOSS', referenceExternalTransactionId: 'bet-1' }),
    );

    expect(result.status).toBe(S.Processed);
    expect(result.balance).toEqual(brl('75.00'));
    expect(store.ledger).toHaveLength(ledgerBefore);
    expect(store.eventTypes().filter((t) => t === 'WalletBalanceChanged')).toHaveLength(1);
    expect(store.walletVersion(W)).toBe(2);
  });
});

describe('reversões (regra 4 estrita)', () => {
  test('uma referência só pode ser revertida uma vez, por qualquer tipo', async () => {
    const { store, useCase } = setup();
    await useCase.execute(cmd('bet-1')); // 75.00

    const refund = await useCase.execute(
      cmd('ref-1', { kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(refund.status).toBe(S.Processed);
    expect(refund.balance).toEqual(brl('100.00'));

    const refundAgain = await useCase.execute(
      cmd('ref-2', { kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(refundAgain.failureCode).toBe(FailureCode.AlreadyReversed);

    // o caso que a regra literal deixava passar: crédito duplicado de um único débito
    const rollbackSameBet = await useCase.execute(
      cmd('rb-1', { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(rollbackSameBet.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(store.walletBalance(W)).toBe('100.00');
    expect(store.ledger).toHaveLength(2);
  });

  test('ROLLBACK do REFUND é permitido (referencia o refund, não a aposta) e debita', async () => {
    const { store, useCase } = setup();
    await useCase.execute(cmd('bet-1'));
    await useCase.execute(cmd('ref-1', { kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }));
    const rollback = await useCase.execute(
      cmd('rb-2', { kind: 'ROLLBACK', referenceExternalTransactionId: 'ref-1' }),
    );

    expect(rollback.status).toBe(S.Processed);
    expect(rollback.balance).toEqual(brl('75.00'));
    expect(store.ledger[2]!.direction).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK de uma BET credita de volta', async () => {
    const { useCase } = setup();
    await useCase.execute(cmd('bet-1'));
    const rollback = await useCase.execute(
      cmd('rb-1', { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(rollback.balance).toEqual(brl('100.00'));
  });

  test('reversão que deixaria saldo negativo: REVERSAL_WOULD_OVERDRAW', async () => {
    const { store, useCase } = setup();
    await useCase.execute(cmd('win-1', { kind: 'WIN', money: brl('50.00') })); // 150.00
    await useCase.execute(cmd('bet-1', { money: brl('140.00') })); // 10.00
    const rollback = await useCase.execute(
      cmd('rb-1', { kind: 'ROLLBACK', money: brl('50.00'), referenceExternalTransactionId: 'win-1' }),
    );

    expect(rollback.status).toBe(S.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(store.walletBalance(W)).toBe('10.00');
    expect(store.ledger).toHaveLength(2);
  });

  test('referência com valor, tipo, rodada ou estado incompatível', async () => {
    const { useCase } = setup();
    await useCase.execute(cmd('bet-1'));
    await useCase.execute(cmd('win-1', { kind: 'WIN', money: brl('5.00') }));
    await useCase.execute(cmd('big-bet', { money: brl('500.00') })); // rejeitada

    const refund = (ext: string, over: Partial<ProcessWagerTransactionCommand>) =>
      useCase.execute(cmd(ext, { kind: 'REFUND', ...over }));

    expect((await refund('r1', { referenceExternalTransactionId: 'bet-1', money: brl('10.00') })).failureCode).toBe(
      FailureCode.ReferenceAmountMismatch,
    );
    expect((await refund('r2', { referenceExternalTransactionId: 'win-1', money: brl('5.00') })).failureCode).toBe(
      FailureCode.ReferenceKindNotAllowed,
    );
    expect((await refund('r3', { referenceExternalTransactionId: 'bet-1', roundId: 'r2' })).failureCode).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect(
      (await refund('r4', { referenceExternalTransactionId: 'big-bet', money: brl('500.00') })).failureCode,
    ).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('referência ausente (regra 8)', () => {
  test('fica PENDING_REFERENCE, agenda a próxima tentativa e não toca saldo nem ledger', async () => {
    const { store, useCase } = setup();
    const command = cmd('ref-1', { kind: 'REFUND', referenceExternalTransactionId: 'nao-chegou' });
    const result = await useCase.execute(command);

    expect(result.status).toBe(S.PendingReference);
    expect(result.balance).toBeUndefined();
    expect(store.eventTypes()).toEqual(['WagerTransactionPendingReference']);
    expect(store.ledger).toHaveLength(0);
    expect(store.walletBalance(W)).toBe('100.00');
    expect(store.nextAttemptAt(result.transactionId)).toEqual(new Date('2026-10-23T12:00:02.000Z'));

    const replay = await useCase.execute(command);
    expect(replay).toEqual({ ...result, idempotentReplay: true });
  });

  test('política de backoff: 2s dobrando até 60s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(referenceRetryDelayMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(nextReferenceAttemptAt(1, NOW)).toEqual(new Date('2026-10-23T12:00:04.000Z'));
  });
});

describe('validação e atomicidade', () => {
  test('payload inválido é recusado antes de gravar qualquer coisa', async () => {
    const { store, useCase } = setup();
    await expect(useCase.execute(cmd('a', { money: brl('25') }))).rejects.toThrow(InvalidMoneyError);
    await expect(useCase.execute(cmd('b', { kind: 'FOO' }))).rejects.toThrow(InvalidTransactionError);
    await expect(useCase.execute(cmd('c', { kind: 'OPENING' }))).rejects.toThrow(InvalidTransactionError);
    await expect(useCase.execute(cmd('d', { walletId: ' ' }))).rejects.toThrow(InvalidTransactionError);
    expect(store.transactionCount()).toBe(0);
  });

  test('falha no meio desfaz tudo: sem transação, saldo, ledger nem evento', async () => {
    const { store, useCase } = setup();
    store.failLedgerAppendWith = new Error('boom');
    await expect(useCase.execute(cmd('bet-1'))).rejects.toThrow('boom');

    expect(store.transactionCount()).toBe(0);
    expect(store.walletBalance(W)).toBe('100.00');
    expect(store.walletVersion(W)).toBe(1);
    expect(store.events).toHaveLength(0);
  });
});
