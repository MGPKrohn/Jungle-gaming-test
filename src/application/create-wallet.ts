import { WagerTransactionProcessed, WalletBalanceChanged, type EventContext } from '../domain/events.js';
import { LedgerDirection, WalletLedgerEntry } from '../domain/ledger-entry.js';
import { Money, type MoneyProps } from '../domain/money.js';
import { computePayloadHash } from '../domain/payload-hash.js';
import { Wallet } from '../domain/wallet.js';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction.js';
import { InvalidRequestError, WalletAlreadyExistsError } from './errors.js';
import type { Clock, IdGenerator, UnitOfWork } from './ports.js';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Saldo inicial > 0 gera, NA MESMA transação SQL: a wallet, a
 * transação interna OPENING, o lançamento CREDIT (saldo anterior 0,00) e os
 * eventos na outbox. (playerId, currency) duplicado => WalletAlreadyExistsError.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    if (typeof command.playerId !== 'string' || command.playerId.trim() === '') {
      throw new InvalidRequestError('playerId is required');
    }
    const initial = Money.from(command.initialBalance);
    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: command.playerId, initialBalance: initial, now });

    return this.uow.run(async (scope) => {
      if (!(await scope.wallets.insert(wallet))) {
        throw new WalletAlreadyExistsError('A wallet for this playerId and currency already exists');
      }

      if (initial.isPositive()) {
        const tx = WagerTransaction.opening({
          id: this.ids.next(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initial,
          payloadHash: computePayloadHash({
            providerId: 'internal',
            externalTransactionId: `opening:${wallet.id}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'opening',
            gameId: 'opening',
            kind: WagerTransactionKind.Opening,
            money: initial.toJSON(),
          }),
          createdAt: now,
        });
        if (!(await scope.transactions.claim(tx))) throw new Error('OPENING transaction already exists');

        const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: tx.id,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: initial,
          createdAt: now,
        });
        tx.markProcessed(undefined, now);
        await scope.ledger.append(entry);
        await scope.transactions.save(tx, { observedBalance: initial });

        const ctx = (causationId?: string): EventContext => ({
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          occurredAt: now,
          ...(causationId !== undefined ? { causationId } : {}),
        });
        await scope.outbox.enqueue(WagerTransactionProcessed.from(tx, initial, ctx()));
        await scope.outbox.enqueue(WalletBalanceChanged.from(wallet, entry, ctx(tx.id)));
      }

      return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
    });
  }
}
