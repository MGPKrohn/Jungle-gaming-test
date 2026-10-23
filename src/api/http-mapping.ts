import {
  IdempotencyConflictError,
  InvalidRequestError,
  NotFoundError,
  WalletAlreadyExistsError,
} from '../application/errors.js';
import type { ProcessWagerTransactionResult } from '../application/process-wager-transaction.js';
import { InvalidMoneyError } from '../domain/money.js';
import { InvalidTransactionError, WagerTransactionStatus } from '../domain/wager-transaction.js';

/**
 * Mapa único e consistente (todos os endpoints):
 *   400 payload inválido            -> corrigir e reenviar
 *   404 recurso inexistente
 *   409 conflito de idempotência    -> NÃO reenviar igual (a key já foi usada com outro conteúdo)
 *   422 rejeição de negócio         -> resultado definitivo (failureCode no corpo); reenviar igual dá o mesmo 422
 *   202 aceita, aguardando referência -> consultar depois; o provedor NÃO precisa reenviar
 *   201 processada / 200 replay
 *   503 falha transitória           -> reenviar a MESMA Idempotency-Key (Retry-After)
 *   500 erro inesperado
 */
export function statusForResult(result: ProcessWagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
      return 422;
    default:
      return 202; // PENDING_REFERENCE (e PENDING, que não é confirmado)
  }
}

export interface HttpErrorDescriptor {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

const TRANSIENT_SQLSTATE = new Set(['40001', '40P01', '55P03', '57014', '53300', '57P01', '57P02', '57P03']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

/** Deadlock, serialização, lock timeout, conexão caída/saturada: reenviar a mesma requisição é seguro. */
export function isTransientInfrastructureError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof e.code === 'string') {
      if (TRANSIENT_SQLSTATE.has(e.code) || e.code.startsWith('08') || TRANSIENT_NODE_CODES.has(e.code)) return true;
    }
    if (typeof e.name === 'string' && /Connection|Deadlock|LockWait/.test(e.name)) return true;
    current = e.cause;
  }
  return false;
}

export function toHttpError(error: unknown): HttpErrorDescriptor {
  if (
    error instanceof InvalidRequestError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidTransactionError
  ) {
    return { status: 400, code: 'INVALID_REQUEST', message: error.message };
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: error.message };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: 'WALLET_ALREADY_EXISTS', message: error.message };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, code: 'NOT_FOUND', message: error.message };
  }
  if (isTransientInfrastructureError(error)) {
    return {
      status: 503,
      code: 'TRANSIENT_FAILURE',
      message: 'Temporary failure: retry with the same Idempotency-Key',
      retryAfterSeconds: 1,
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error' };
}
