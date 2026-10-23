import {
  type EventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events.js';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry.js';
import { Money, type MoneyProps } from '../domain/money.js';
import { computePayloadHash } from '../domain/payload-hash.js';
import { InsufficientFundsError } from '../domain/wallet.js';
import {
  FailureCode,
  InvalidTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import { IdempotencyConflictError } from './errors.js';
import { nextReferenceAttemptAt } from './pending-reference-policy.js';
import type { Clock, IdGenerator, StoredTransaction, TransactionScope, UnitOfWork } from './ports.js';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

interface Run {
  scope: TransactionScope;
  now: Date;
  correlationId: string;
}

/**
 * Fluxo (uma transação SQL):
 *  1. valida payload e calcula payloadHash (fora da transação: erro => 400);
 *  2. reivindica a idempotência (claim); se já existia => replay ou conflito;
 *  3. trava a wallet (FOR UPDATE) — serializa apenas operações da MESMA wallet;
 *  4. resolve a referência DEPOIS do lock (enxerga o commit de quem estava na frente);
 *  5. decide com o domínio: aplica, rejeita ou fica PENDING_REFERENCE;
 *  6. grava transação, wallet, ledger e outbox juntos. Rejeição é COMMIT (auditável),
 *     não rollback; só falha de infraestrutura desfaz tudo.
 *
 * Requer isolamento READ COMMITTED (padrão do Postgres): o SELECT após um claim
 * perdido precisa enxergar a linha que o outro commit acabou de gravar.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const incoming = this.buildTransaction(command);
    return this.uow.run(async (scope) => {
      const claimed = await scope.transactions.claim(incoming);
      if (!claimed) return this.replay(scope, incoming);
      return this.apply(scope, command.correlationId, incoming);
    });
  }

  private buildTransaction(command: ProcessWagerTransactionCommand): WagerTransaction {
    const kind = parseKind(command.kind);
    const money = Money.from(command.money);
    const providerId = requireText('providerId', command.providerId);
    const externalTransactionId = requireText('externalTransactionId', command.externalTransactionId);
    const playerId = requireText('playerId', command.playerId);
    const walletId = requireText('walletId', command.walletId);
    const roundId = requireText('roundId', command.roundId);
    const gameId = requireText('gameId', command.gameId);
    const idempotencyKey = requireText('idempotencyKey', command.idempotencyKey);
    const reference = command.referenceExternalTransactionId;

    const payloadHash = computePayloadHash({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId: reference,
    });

    return WagerTransaction.create({
      id: this.ids.next(),
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId,
      playerId,
      roundId,
      gameId,
      kind,
      money,
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
      createdAt: this.clock.now(),
    });
  }

  private async replay(scope: TransactionScope, incoming: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    const existing = await scope.transactions.findByIdempotencyKey(incoming.idempotencyKey);
    if (!existing) {
      throw new IdempotencyConflictError('externalTransactionId already used under a different Idempotency-Key');
    }
    if (!existing.transaction.matchesPayload(incoming.payloadHash)) {
      throw new IdempotencyConflictError('Idempotency-Key reused with a different payload');
    }
    return toResult(existing, true);
  }

  private async apply(
    scope: TransactionScope,
    correlationId: string,
    tx: WagerTransaction,
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await scope.wallets.lockById(tx.walletId);
    // `now` só DEPOIS do lock: os timestamps do ledger e da wallet ficam
    // monotônicos na ordem de serialização, e não na ordem de chegada.
    const run: Run = { scope, now: this.clock.now(), correlationId };
    const { now } = run;
    if (!wallet) return this.reject(run, tx, undefined, FailureCode.WalletNotFound);
    if (wallet.currency !== tx.money.currency) {
      return this.reject(run, tx, wallet.balance, FailureCode.CurrencyMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      const stored = await scope.transactions.findByProviderExternalId(tx.providerId, tx.referenceExternalTransactionId);
      if (!stored) return this.pendReference(run, tx);
      const violation = tx.checkReference(stored.transaction);
      if (violation) return this.reject(run, tx, wallet.balance, violation);
      if (!stored.transaction.isProcessed()) return this.pendReference(run, tx);
      reference = stored.transaction;
    }

    const reverses = tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback;
    if (reverses && reference) {
      const prior = await scope.transactions.findProcessedReversalOf(reference.id);
      if (prior) return this.reject(run, tx, wallet.balance, FailureCode.AlreadyReversed);
    }

    // LOSS: resolve sem mover saldo e sem ledger.
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now);
      await scope.transactions.save(tx, { observedBalance: wallet.balance });
      await scope.outbox.enqueue(WagerTransactionProcessed.from(tx, wallet.balance, this.ctx(run)));
      return toResult({ transaction: tx, observedBalance: wallet.balance }, false);
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at: now };
    let entry: WalletLedgerEntry;
    try {
      entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        const code = tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
        return this.reject(run, tx, wallet.balance, code);
      }
      throw error;
    }

    tx.markProcessed(reference?.id, now);
    await scope.wallets.save(wallet);
    await scope.ledger.append(entry);
    await scope.transactions.save(tx, { observedBalance: wallet.balance });
    await scope.outbox.enqueue(WagerTransactionProcessed.from(tx, wallet.balance, this.ctx(run)));
    await scope.outbox.enqueue(WalletBalanceChanged.from(wallet, entry, this.ctx(run, tx.id)));
    return toResult({ transaction: tx, observedBalance: wallet.balance }, false);
  }

  private async reject(
    run: Run,
    tx: WagerTransaction,
    observedBalance: Money | undefined,
    code: FailureCode,
  ): Promise<ProcessWagerTransactionResult> {
    tx.reject(code, run.now);
    await run.scope.transactions.save(tx, observedBalance ? { observedBalance } : {});
    await run.scope.outbox.enqueue(WagerTransactionRejected.from(tx, code, this.ctx(run)));
    return toResult({ transaction: tx, ...(observedBalance ? { observedBalance } : {}) }, false);
  }

  private async pendReference(run: Run, tx: WagerTransaction): Promise<ProcessWagerTransactionResult> {
    tx.markPendingReference();
    await run.scope.transactions.save(tx, { nextAttemptAt: nextReferenceAttemptAt(0, run.now) });
    await run.scope.outbox.enqueue(WagerTransactionPendingReference.from(tx, this.ctx(run)));
    return toResult({ transaction: tx }, false);
  }

  private ctx(run: Run, causationId?: string): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId: run.correlationId,
      occurredAt: run.now,
      ...(causationId !== undefined ? { causationId } : {}),
    };
  }
}

function toResult(stored: StoredTransaction, idempotentReplay: boolean): ProcessWagerTransactionResult {
  const { transaction, observedBalance } = stored;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(observedBalance ? { balance: observedBalance.toJSON() } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    idempotentReplay,
  };
}

function parseKind(value: string): WagerTransactionKind {
  if (!(Object.values(WagerTransactionKind) as string[]).includes(value)) {
    throw new InvalidTransactionError('Unknown transaction kind');
  }
  return value as WagerTransactionKind;
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidTransactionError(`${field} is required`);
  }
  return value;
}
