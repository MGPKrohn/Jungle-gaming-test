import { describe, expect, test } from 'bun:test';
import { Money } from './money.js';
import { LedgerDirection } from './ledger-entry.js';
import { computePayloadHash } from './payload-hash.js';
import {
  FailureCode,
  InvalidTransactionError,
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-07-29T15:00:00.000Z');

const props = (over: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-a:ext-1',
  payloadHash: 'hash-1',
  walletId: 'w1',
  playerId: 'p1',
  roundId: 'r1',
  gameId: 'g1',
  kind: K.Bet,
  money: brl('25.00'),
  createdAt: at,
  ...over,
});
const make = (over: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(over));

describe('WagerTransaction.create', () => {
  test('nasce PENDING', () => {
    expect(make().status).toBe(S.Pending);
  });

  test('OPENING não pode ser submetido', () => {
    expect(() => make({ kind: K.Opening })).toThrow(InvalidTransactionError);
  });

  test('REFUND/ROLLBACK exigem referência; BET não aceita', () => {
    expect(() => make({ kind: K.Refund })).toThrow(InvalidTransactionError);
    expect(() => make({ kind: K.Rollback })).toThrow(InvalidTransactionError);
    expect(() => make({ kind: K.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidTransactionError);
    expect(make({ kind: K.Refund, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => make({ money: brl('0.00') })).toThrow(InvalidTransactionError);
    expect(() => make({ kind: K.Win, money: brl('0.00') })).toThrow(InvalidTransactionError);
    expect(make({ kind: K.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
  });
});

describe('transições de estado', () => {
  test('PENDING -> PROCESSED', () => {
    const t = make();
    t.markProcessed(undefined, at);
    expect(t.status).toBe(S.Processed);
    expect(t.isTerminal()).toBe(true);
    expect(t.processedAt).toBe(at);
  });

  test('PENDING_REFERENCE aceita nova tentativa e depois vira REJECTED', () => {
    const t = make({ kind: K.Refund, referenceExternalTransactionId: 'bet-1' });
    t.markPendingReference();
    t.markPendingReference();
    expect(t.status).toBe(S.PendingReference);
    t.reject(FailureCode.ReferenceNotFound, at);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('transação sem referência não pode ficar PENDING_REFERENCE', () => {
    expect(() => make().markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('estados terminais não transicionam', () => {
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed(undefined, at),
      (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, at),
      (t: WagerTransaction) => t.fail(FailureCode.InfrastructureFailure, at),
    ]) {
      const t = make({ kind: K.Win, referenceExternalTransactionId: 'bet-1' });
      finish(t);
      expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.InfrastructureFailure, at)).toThrow(InvalidTransactionStateError);
    }
  });
});

describe('direção do ledger', () => {
  const bet = make();
  const win = make({ kind: K.Win });
  const refund = make({ kind: K.Refund, referenceExternalTransactionId: 'b' });
  const rollback = make({ kind: K.Rollback, referenceExternalTransactionId: 'x' });

  test('BET debita; WIN e REFUND creditam', () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK é o inverso da referência', () => {
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('LOSS não tem efeito no ledger', () => {
    const loss = make({ kind: K.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe('checkReference', () => {
  const bet = make({ id: 'bet-id', externalTransactionId: 'bet-1' });
  const refund = (over: Partial<CreateWagerTransactionProps> = {}) =>
    make({ kind: K.Refund, externalTransactionId: 'ref-1', referenceExternalTransactionId: 'bet-1', ...over });

  test('referência compatível', () => {
    expect(refund().checkReference(bet)).toBeUndefined();
  });

  test('rodada, player, wallet ou provider diferentes', () => {
    expect(refund({ roundId: 'r2' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    expect(refund({ playerId: 'p2' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    expect(refund({ walletId: 'w2' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
    expect(refund({ providerId: 'provider-b' }).checkReference(bet)).toBe(FailureCode.ReferenceMismatch);
  });

  test('moeda diferente', () => {
    const usd = Money.from({ amount: '25.00', currency: 'USD' });
    expect(refund({ money: usd }).checkReference(bet)).toBe(FailureCode.CurrencyMismatch);
  });

  test('REFUND só referencia BET; ROLLBACK aceita BET, WIN e REFUND', () => {
    const win = make({ kind: K.Win });
    expect(refund().checkReference(win)).toBe(FailureCode.ReferenceKindNotAllowed);
    const rollback = make({ kind: K.Rollback, referenceExternalTransactionId: 'x' });
    expect(rollback.checkReference(win)).toBeUndefined();
    expect(rollback.checkReference(refund())).toBeUndefined();
    expect(rollback.checkReference(make({ kind: K.Loss }))).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('valor da reversão deve ser igual ao da referência', () => {
    expect(refund({ money: brl('10.00') }).checkReference(bet)).toBe(FailureCode.ReferenceAmountMismatch);
  });

  test('referência REJECTED não pode ser revertida', () => {
    const rejected = make();
    rejected.reject(FailureCode.InsufficientFunds, at);
    expect(refund().checkReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('payloadHash', () => {
  const base = {
    providerId: 'provider-a', externalTransactionId: 'ext-1', playerId: 'p1', walletId: 'w1',
    roundId: 'r1', gameId: 'g1', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  };

  test('independe da ordem das chaves e ignora campos de transporte', () => {
    const reordered = { money: { currency: 'BRL', amount: '25.00' }, kind: 'BET', gameId: 'g1', roundId: 'r1',
      walletId: 'w1', playerId: 'p1', externalTransactionId: 'ext-1', providerId: 'provider-a',
      messageId: 'msg-9', traceparent: 'abc' };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(base));
  });

  test('mudança em qualquer campo de negócio altera o hash', () => {
    const original = computePayloadHash(base);
    expect(computePayloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(original);
    expect(computePayloadHash({ ...base, kind: 'WIN' })).not.toBe(original);
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: 'bet-1' })).not.toBe(original);
  });

  test('matchesPayload detecta conflito de idempotência', () => {
    const t = make({ payloadHash: computePayloadHash(base) });
    expect(t.matchesPayload(computePayloadHash(base))).toBe(true);
    expect(t.matchesPayload(computePayloadHash({ ...base, kind: 'WIN' }))).toBe(false);
  });
});
