import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError } from '../../application/errors.js';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionCommand,
  type ProcessWagerTransactionResult,
} from '../../application/process-wager-transaction.js';
import { FailureCode, WagerTransactionStatus as S } from '../../domain/wager-transaction.js';
import { buildOrmConfig } from './mikro-orm.config.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';

/**
 * Integração REAL: PostgreSQL do docker-compose, banco novo por execução e DUAS
 * instâncias da aplicação (dois ORMs, dois pools) disputando as mesmas wallets.
 *
 *   bun run test:integration
 *
 * Só roda com INTEGRATION=1, para o `bun test` comum não exigir o Postgres de pé.
 */
const suite = process.env.INTEGRATION === '1' ? describe : describe.skip;

suite('ProcessWagerTransaction contra PostgreSQL real (2 instâncias)', () => {
  const dbName = `wallet_it_${Date.now()}`;
  let admin: MikroORM;
  let ormA: MikroORM;
  let ormB: MikroORM;
  let instanceA: ProcessWagerTransaction;
  let instanceB: ProcessWagerTransaction;

  beforeAll(async () => {
    admin = await MikroORM.init(buildOrmConfig({ dbName: 'postgres' }));
    await admin.em.execute(`create database ${dbName}`);
    ormA = await MikroORM.init(buildOrmConfig({ dbName }));
    await ormA.migrator.up();
    ormB = await MikroORM.init(buildOrmConfig({ dbName }));

    const clock = { now: () => new Date() };
    const ids = { next: () => randomUUID() };
    instanceA = new ProcessWagerTransaction(new MikroOrmUnitOfWork(ormA), clock, ids);
    instanceB = new ProcessWagerTransaction(new MikroOrmUnitOfWork(ormB), clock, ids);
  });

  afterAll(async () => {
    await ormA?.close(true);
    await ormB?.close(true);
    await admin?.em.execute(`drop database if exists ${dbName} with (force)`);
    await admin?.close(true);
  });

  // ------------------------------------------------------------------ helpers
  type Row = Record<string, unknown>;
  const rows = async (sql: string, params: unknown[] = []) =>
    (await ormA.em.execute(sql, params, 'all')) as unknown as Row[];
  const count = async (sql: string, params: unknown[] = []) => Number((await rows(sql, params))[0]!.n);

  async function seedWallet(balance: string) {
    const id = randomUUID();
    const playerId = `player-${id}`;
    await ormA.em.execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'BRL', ?, 1, now(), now())`,
      [id, playerId, balance],
      'run',
    );
    return { id, playerId };
  }

  let seq = 0;
  const command = (
    wallet: { id: string; playerId: string },
    over: Partial<ProcessWagerTransactionCommand> = {},
  ): ProcessWagerTransactionCommand => {
    const ext = `ext-${++seq}`;
    return {
      idempotencyKey: `prov:${ext}`,
      providerId: 'prov',
      externalTransactionId: ext,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
      correlationId: `corr-${seq}`,
      ...over,
    };
  };
  const money = (amount: string) => ({ amount, currency: 'BRL' });
  const walletRow = async (id: string) => (await rows(`select balance, version from wallets where id = ?`, [id]))[0]!;
  const statuses = (results: ProcessWagerTransactionResult[]) => results.map((r) => r.status).sort();

  // -------------------------------------------------------------------- testes
  test('cenário obrigatório: duas apostas de 80,00 simultâneas -> uma PROCESSED, uma REJECTED, saldo 20,00', async () => {
    const wallet = await seedWallet('100.00');
    const results = await Promise.all([
      instanceA.execute(command(wallet)),
      instanceB.execute(command(wallet)),
    ]);

    expect(statuses(results)).toEqual([S.Processed, S.Rejected].sort());
    expect(results.find((r) => r.status === S.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);

    const row = await walletRow(wallet.id);
    expect(row.balance).toBe('20.00');
    expect(Number(row.version)).toBe(2);
    expect(await count(`select count(*) as n from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toBe(1);

    // outbox gravada na MESMA transação: Processed + BalanceChanged + Rejected, nada publicado ainda
    expect(await count(`select count(*) as n from outbox_messages where aggregate_id = ?`, [wallet.id])).toBe(3);
    expect(
      await count(`select count(*) as n from outbox_messages where aggregate_id = ? and published_at is null`, [
        wallet.id,
      ]),
    ).toBe(3);
  });

  test('hot wallet: 50 apostas de 10,00 em 100,00 -> exatamente 10 passam, saldo 0,00, sem lost update', async () => {
    const wallet = await seedWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 === 0 ? instanceA : instanceB).execute(command(wallet, { money: money('10.00') })),
      ),
    );

    expect(results.filter((r) => r.status === S.Processed)).toHaveLength(10);
    const rejected = results.filter((r) => r.status === S.Rejected);
    expect(rejected).toHaveLength(40);
    expect(rejected.every((r) => r.failureCode === FailureCode.InsufficientFunds)).toBe(true);

    const row = await walletRow(wallet.id);
    expect(row.balance).toBe('0.00');
    expect(Number(row.version)).toBe(11);

    // invariantes do ledger
    expect(await count(`select count(*) as n from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toBe(10);
    expect(
      await count(`select count(distinct balance_before) as n from wallet_ledger_entries where wallet_id = ?`, [
        wallet.id,
      ]),
    ).toBe(10); // dois débitos nunca partiram do mesmo saldo
    const [delta] = await rows(
      `select coalesce(sum(case when direction = 'DEBIT' then -amount else amount end), 0) as d
         from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(delta!.d).toBe('-100.00'); // saldo inicial + soma do ledger == saldo final

    // 10 Processed + 10 BalanceChanged + 40 Rejected
    expect(await count(`select count(*) as n from outbox_messages where aggregate_id = ?`, [wallet.id])).toBe(60);
  });

  test('idempotência concorrente: a mesma requisição 20x em 2 instâncias debita uma única vez', async () => {
    const wallet = await seedWallet('100.00');
    const same = command(wallet, { money: money('25.00') });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? instanceA : instanceB).execute(same)),
    );

    expect(results.every((r) => r.status === S.Processed)).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.balance?.amount === '75.00')).toBe(true);

    expect((await walletRow(wallet.id)).balance).toBe('75.00');
    expect(
      await count(`select count(*) as n from wager_transactions where idempotency_key = ?`, [same.idempotencyKey]),
    ).toBe(1);
    expect(await count(`select count(*) as n from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toBe(1);
  });

  test('mesma key com payloads diferentes em paralelo: um vence, o outro é conflito (não replay)', async () => {
    const wallet = await seedWallet('100.00');
    const base = command(wallet, { money: money('30.00') });
    const settled = await Promise.allSettled([
      instanceA.execute(base),
      instanceB.execute({ ...base, money: money('40.00') }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(IdempotencyConflictError);
    expect(await count(`select count(*) as n from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toBe(1);
  });

  test('regra 4 estrita sob corrida: REFUND e ROLLBACK da mesma BET -> só um é aplicado (10 rodadas)', async () => {
    const wallet = await seedWallet('100.00');
    for (let round = 0; round < 10; round++) {
      const bet = command(wallet, { money: money('25.00') });
      await instanceA.execute(bet);
      const refund = command(wallet, {
        kind: 'REFUND',
        money: money('25.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const rollback = command(wallet, {
        kind: 'ROLLBACK',
        money: money('25.00'),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const results = await Promise.all([instanceA.execute(refund), instanceB.execute(rollback)]);

      expect(statuses(results)).toEqual([S.Processed, S.Rejected].sort());
      expect(results.find((r) => r.status === S.Rejected)!.failureCode).toBe(FailureCode.AlreadyReversed);
    }
    expect((await walletRow(wallet.id)).balance).toBe('100.00'); // nenhum crédito duplicado
    expect(await count(`select count(*) as n from wallet_ledger_entries where wallet_id = ?`, [wallet.id])).toBe(20);
  });

  test('wallet inexistente: rejeição persistida e auditável (sem FK em wager_transactions.wallet_id)', async () => {
    const ghost = { id: randomUUID(), playerId: 'ghost' };
    const result = await instanceA.execute(command(ghost));

    expect(result.status).toBe(S.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);
    expect(
      await count(`select count(*) as n from wager_transactions where id = ? and status = 'REJECTED'`, [
        result.transactionId,
      ]),
    ).toBe(1);
  });
});
