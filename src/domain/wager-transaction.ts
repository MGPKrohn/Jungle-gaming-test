import { DomainError } from './errors.js';
import { LedgerDirection } from './ledger-entry.js';
import { Money } from './money.js';

export class InvalidTransactionError extends DomainError {}
export class InvalidTransactionStateError extends DomainError {}

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: nunca vem da API nem da fila
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Taxonomia estável e legível por máquina. O que o provedor deve fazer:
 *  - corrigir o payload e reenviar com NOVA transação;
 *  - desistir (a rejeição é definitiva);
 *  - FAILED: erro nosso, pode reenviar a mesma idempotency key.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS', // BET sem saldo: desistir ou reenviar nova aposta
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW', // reversão deixaria saldo < 0 (distinto de aposta sem saldo)
  ReferenceNotFound = 'REFERENCE_NOT_FOUND', // referência nunca chegou (esgotou tentativas/TTL)
  ReferenceMismatch = 'REFERENCE_MISMATCH', // provider/player/wallet/rodada diferentes
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED', // ex.: REFUND de WIN
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH', // reversão parcial não suportada
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED', // referência REJECTED/FAILED
  AlreadyReversed = 'ALREADY_REVERSED', // mesma referência revertida duas vezes
  WalletNotFound = 'WALLET_NOT_FOUND',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE', // usado em FAILED
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;

  private constructor(s: WagerTransactionState) {
    this.id = s.id;
    this.providerId = s.providerId;
    this.externalTransactionId = s.externalTransactionId;
    this.idempotencyKey = s.idempotencyKey;
    this.payloadHash = s.payloadHash;
    this.walletId = s.walletId;
    this.playerId = s.playerId;
    this.roundId = s.roundId;
    this.gameId = s.gameId;
    this.kind = s.kind;
    this.money = s.money;
    this.referenceExternalTransactionId = s.referenceExternalTransactionId;
    this.createdAt = s.createdAt;
    this._status = s.status;
    this._referenceTransactionId = s.referenceTransactionId;
    this._failureCode = s.failureCode;
    this._processedAt = s.processedAt;
  }

  /**
   * Transação vinda de fora (API/SQS). Nasce PENDING.
   * Interpretações adotadas (documentar no ARCHITECTURE.md):
   *  - OPENING é recusado aqui (use `opening`);
   *  - BET não aceita referência; REFUND/ROLLBACK a exigem; WIN/LOSS a aceitam;
   *  - BET/WIN/REFUND/ROLLBACK exigem valor > 0; LOSS aceita 0 (não move saldo).
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    const needsRef = WagerTransaction.kindRequiresReference(props.kind);
    if (needsRef && !props.referenceExternalTransactionId) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && props.referenceExternalTransactionId) {
      throw new InvalidTransactionError('BET cannot reference another transaction');
    }
    if (props.money.isNegative()) {
      throw new InvalidTransactionError('Amount cannot be negative');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError(`${props.kind} amount must be greater than zero`);
    }
    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }

  /** Crédito interno de abertura da wallet. Valores fixos para as colunas de provedor. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('OPENING amount must be greater than zero');
    }
    const key = `internal:opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: key,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- Transições válidas:
  //   PENDING           -> PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
  //   PENDING_REFERENCE -> PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
  //   PROCESSED / REJECTED / FAILED -> nenhuma (terminais; tentar é erro de programação)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('process');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal('mark as pending reference');
    if (!this.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError('A transaction without a reference cannot wait for one');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  // ---- Consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  isProcessed(): boolean {
    return this._status === WagerTransactionStatus.Processed;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return WagerTransaction.kindRequiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK é o inverso da direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK needs its reference to define the direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS has no ledger effect');
    }
  }

  /**
   * Regras 2, 3 e 5 da seção 7: mesma identidade, tipo permitido e valor igual.
   * Retorna o FailureCode da violação, ou undefined se a referência é compatível.
   * Referência ainda PENDING/PENDING_REFERENCE devolve undefined: quem decide
   * esperar é o use case. A regra 4 (reversão dupla) é garantida pelo banco.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.money.currency !== this.money.currency) {
      return FailureCode.CurrencyMismatch;
    }
    if (!WagerTransaction.allowedReferenceKinds(this.kind).includes(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    const reverses = this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
    if (reverses && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }
    if (
      reference.status === WagerTransactionStatus.Rejected ||
      reference.status === WagerTransactionStatus.Failed
    ) {
      return FailureCode.ReferenceNotProcessed;
    }
    return undefined;
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${action} a transaction in terminal status ${this._status}`);
    }
  }

  private static kindRequiresReference(kind: WagerTransactionKind): boolean {
    return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  }

  private static allowedReferenceKinds(kind: WagerTransactionKind): WagerTransactionKind[] {
    switch (kind) {
      case WagerTransactionKind.Rollback:
        return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
        return [WagerTransactionKind.Bet];
      default:
        return [];
    }
  }
}
