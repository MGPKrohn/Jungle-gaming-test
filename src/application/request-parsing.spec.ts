import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor } from './cursor.js';
import { InvalidRequestError } from './errors.js';
import {
  parseCreateWalletBody,
  parseLedgerQuery,
  parseSubmitTransactionRequest,
  parseUuid,
} from './request-parsing.js';

const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const body = () => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: WALLET,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
});

describe('parseSubmitTransactionRequest', () => {
  test('payload válido do enunciado', () => {
    const command = parseSubmitTransactionRequest(body(), 'provider-a:transaction-123', 'corr');
    expect(command.walletId).toBe(WALLET);
    expect(command.idempotencyKey).toBe('provider-a:transaction-123');
    expect(command.referenceExternalTransactionId).toBeUndefined();
    expect(command.correlationId).toBe('corr');
  });

  test('Idempotency-Key é obrigatório', () => {
    expect(() => parseSubmitTransactionRequest(body(), undefined, 'c')).toThrow(InvalidRequestError);
    expect(() => parseSubmitTransactionRequest(body(), '  ', 'c')).toThrow(InvalidRequestError);
  });

  test('walletId que não é UUID vira 400 (e não erro do banco)', () => {
    expect(() => parseSubmitTransactionRequest({ ...body(), walletId: 'abc' }, 'k', 'c')).toThrow(InvalidRequestError);
  });

  test('campos ausentes, corpo não-objeto e money malformado', () => {
    for (const bad of [null, [], 'x', { ...body(), providerId: undefined }, { ...body(), money: 25 }, { ...body(), money: { amount: 25, currency: 'BRL' } }]) {
      expect(() => parseSubmitTransactionRequest(bad, 'k', 'c')).toThrow(InvalidRequestError);
    }
  });

  test('referência opcional é preservada', () => {
    const command = parseSubmitTransactionRequest({ ...body(), kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }, 'k', 'c');
    expect(command.referenceExternalTransactionId).toBe('bet-1');
  });
});

describe('outros parsers', () => {
  test('criar wallet', () => {
    expect(parseCreateWalletBody({ playerId: 'p', initialBalance: { amount: '1000.00', currency: 'BRL' } })).toEqual({
      playerId: 'p',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(() => parseCreateWalletBody({ playerId: 'p' })).toThrow(InvalidRequestError);
  });

  test('UUID é normalizado para minúsculas', () => {
    expect(parseUuid('id', WALLET.toUpperCase())).toBe(WALLET);
  });

  test('paginação: default 50, limites 1..200, só inteiros', () => {
    expect(parseLedgerQuery({})).toEqual({ limit: 50 });
    expect(parseLedgerQuery({ limit: '200', cursor: 'abc' })).toEqual({ limit: 200, cursor: 'abc' });
    for (const limit of ['0', '201', '-1', '5.5', 'abc', '']) {
      expect(() => parseLedgerQuery({ limit })).toThrow(InvalidRequestError);
    }
  });
});

describe('cursor opaco', () => {
  test('ida e volta preserva (created_at, id)', () => {
    const cursor = { createdAt: new Date('2026-10-23T12:00:00.123Z'), id: WALLET };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.createdAt.toISOString()).toBe('2026-10-23T12:00:00.123Z');
    expect(decoded.id).toBe(WALLET);
  });

  test('cursor adulterado é 400', () => {
    for (const raw of ['', 'não-é-base64!!', Buffer.from('{"c":"x","i":"y"}').toString('base64url'), Buffer.from('[]').toString('base64url')]) {
      expect(() => decodeCursor(raw)).toThrow(InvalidRequestError);
    }
  });
});
