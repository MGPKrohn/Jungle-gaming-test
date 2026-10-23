import type { MoneyProps } from '../domain/money.js';
import { InvalidRequestError } from './errors.js';
import type { ProcessWagerTransactionCommand } from './process-wager-transaction.js';

/** Validação de borda: devolve 400 em vez de deixar o banco estourar (ex.: UUID inválido viraria 500). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 200;
const MAX_KEY = 255;

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export function parseUuid(field: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidRequestError(`${field} must be a UUID`);
  return value.toLowerCase();
}

export function parseText(field: string, value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InvalidRequestError(`${field} is required`);
  if (value.length > max) throw new InvalidRequestError(`${field} is too long`);
  return value;
}

function parseObject(field: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseMoneyProps(field: string, value: unknown): MoneyProps {
  const obj = parseObject(field, value);
  if (typeof obj.amount !== 'string' || typeof obj.currency !== 'string') {
    throw new InvalidRequestError(`${field} must have string amount and currency`);
  }
  return { amount: obj.amount, currency: obj.currency }; // formato exato: validado por Money.from
}

export function parseCreateWalletBody(body: unknown): { playerId: string; initialBalance: MoneyProps } {
  const b = parseObject('body', body);
  return {
    playerId: parseText('playerId', b.playerId),
    initialBalance: parseMoneyProps('initialBalance', b.initialBalance),
  };
}

export function parseSubmitTransactionRequest(
  body: unknown,
  idempotencyKey: unknown,
  correlationId: string,
): ProcessWagerTransactionCommand {
  const b = parseObject('body', body);
  const reference = b.referenceExternalTransactionId;
  return {
    idempotencyKey: parseText('Idempotency-Key header', idempotencyKey, MAX_KEY),
    providerId: parseText('providerId', b.providerId),
    externalTransactionId: parseText('externalTransactionId', b.externalTransactionId),
    playerId: parseText('playerId', b.playerId),
    walletId: parseUuid('walletId', b.walletId),
    roundId: parseText('roundId', b.roundId),
    gameId: parseText('gameId', b.gameId),
    kind: parseText('kind', b.kind, 20),
    money: parseMoneyProps('money', b.money),
    ...(reference === undefined || reference === null
      ? {}
      : { referenceExternalTransactionId: parseText('referenceExternalTransactionId', reference) }),
    correlationId,
  };
}

export function parseLedgerQuery(query: Record<string, unknown>): { cursor?: string; limit: number } {
  const rawLimit = query.limit;
  let limit = DEFAULT_LEDGER_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) throw new InvalidRequestError('limit must be an integer');
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidRequestError(`limit must be between 1 and ${MAX_LEDGER_LIMIT}`);
    }
  }
  const cursor = query.cursor;
  if (cursor === undefined) return { limit };
  return { cursor: parseText('cursor', cursor, 500), limit };
}
