import { DomainError } from '../domain/errors.js';

/** Mesma Idempotency-Key com payload diferente, ou mesmo (provider, externalId) sob outra chave. HTTP 409. */
export class IdempotencyConflictError extends DomainError {}
/** Já existe wallet para (playerId, currency). HTTP 409. */
export class WalletAlreadyExistsError extends DomainError {}
/** Recurso consultado não existe. HTTP 404. */
export class NotFoundError extends DomainError {}
/** Entrada malformada na borda (UUID inválido, campo ausente, cursor inválido). HTTP 400. */
export class InvalidRequestError extends DomainError {}
