import { describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
  WalletAlreadyExistsError,
} from '../application/errors.js';
import type { ProcessWagerTransactionResult } from '../application/process-wager-transaction.js';
import { InvalidMoneyError } from '../domain/money.js';
import { FailureCode, InvalidTransactionError, WagerTransactionStatus as S } from '../domain/wager-transaction.js';
import { extractCorrelationId } from './correlation.js';
import { isTransientInfrastructureError, statusForResult, toHttpError } from './http-mapping.js';
import { Metrics } from './metrics.js';

const result = (over: Partial<ProcessWagerTransactionResult>): ProcessWagerTransactionResult => ({
  transactionId: 't',
  status: S.Processed,
  idempotentReplay: false,
  ...over,
});

describe('status HTTP por resultado', () => {
  test('cada situação tem um código distinto', () => {
    expect(statusForResult(result({}))).toBe(201);
    expect(statusForResult(result({ idempotentReplay: true }))).toBe(200);
    expect(statusForResult(result({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds }))).toBe(422);
    expect(statusForResult(result({ status: S.PendingReference }))).toBe(202);
  });
});

describe('erros -> HTTP', () => {
  test('400 / 404 / 409 / 503 / 500 sem colapsar situações', () => {
    expect(toHttpError(new InvalidRequestError('x')).status).toBe(400);
    expect(toHttpError(new InvalidMoneyError('x')).status).toBe(400);
    expect(toHttpError(new InvalidTransactionError('x')).status).toBe(400);
    expect(toHttpError(new NotFoundError('x'))).toEqual({ status: 404, code: 'NOT_FOUND', message: 'x' });
    expect(toHttpError(new IdempotencyConflictError('x')).code).toBe('IDEMPOTENCY_CONFLICT');
    expect(toHttpError(new WalletAlreadyExistsError('x')).code).toBe('WALLET_ALREADY_EXISTS');
    expect(toHttpError(new Error('boom'))).toEqual({ status: 500, code: 'INTERNAL_ERROR', message: 'Internal error' });
  });

  test('falha transitória vira 503 com Retry-After', () => {
    for (const error of [
      Object.assign(new Error('deadlock'), { code: '40P01' }),
      Object.assign(new Error('serialization'), { code: '40001' }),
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('conn'), { code: '08006' }),
      Object.assign(new Error('wrapper'), { cause: Object.assign(new Error('inner'), { code: '55P03' }) }),
    ]) {
      expect(toHttpError(error).status).toBe(503);
      expect(toHttpError(error).retryAfterSeconds).toBe(1);
    }
    expect(isTransientInfrastructureError(Object.assign(new Error('unique'), { code: '23505' }))).toBe(false);
  });

  test('mensagem de erro 500 não vaza detalhes internos', () => {
    expect(toHttpError(new Error('password=secret')).message).toBe('Internal error');
  });
});

describe('correlationId e métricas', () => {
  const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
  test('prioridade: traceparent > x-correlation-id > gerado', () => {
    expect(extractCorrelationId({ traceparent: `00-${trace}-00f067aa0ba902b7-01`, 'x-correlation-id': 'abc' }, () => 'gen')).toBe(trace);
    expect(extractCorrelationId({ 'x-correlation-id': 'abc' }, () => 'gen')).toBe('abc');
    expect(extractCorrelationId({ traceparent: 'lixo' }, () => 'gen')).toBe('gen');
    expect(extractCorrelationId({}, () => 'gen')).toBe('gen');
  });

  test('formato Prometheus', () => {
    const metrics = new Metrics();
    metrics.increment('x_total', { a: '1' });
    metrics.increment('x_total', { a: '1' });
    metrics.increment('y_total');
    expect(metrics.render()).toBe('# TYPE x_total counter\nx_total{a="1"} 2\n# TYPE y_total counter\ny_total 1\n');
  });
});
