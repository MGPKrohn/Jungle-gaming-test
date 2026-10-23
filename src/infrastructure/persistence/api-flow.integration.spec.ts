import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletAlreadyExistsError } from '../../application/errors.js';
import { CreateWallet } from '../../application/create-wallet.js';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction.js';
import { WagerTransactionStatus as S } from '../../domain/wager-transaction.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { PostgresWalletQueries } from './postgres-queries.js';
import { createTestDatabase } from './testing/test-database.js';

/** Integração real: criação de wallet (OPENING), consultas, paginação por cursor e reconciliação. */
const suite = process.env.INTEGRATION === '1' ? describe : describe.skip;

suite('Fluxo da API contra PostgreSQL real', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let createA: CreateWallet;
  let createB: CreateWallet;
  let process_: ProcessWagerTransaction;
  let queries: PostgresWalletQueries;

  beforeAll(async () => {
    db = await createTestDatabase(2);
    const clock = { now: () => new Date() };
    const ids = { next: () => randomUUID() };
    createA = new CreateWallet(new MikroOrmUnitOfWork(db.orms[0]!), clock, ids);
    createB = new CreateWallet(new MikroOrmUnitOfWork(db.orms[1]!), clock, ids);
    process_ = new ProcessWagerTransaction(new MikroOrmUnitOfWork(db.orms[0]!), clock, ids);
    queries = new PostgresWalletQueries(db.orms[0]!);
  });

  afterAll(async () => {
    await db?.drop();
  });

  const brl = (amount: string) => ({ amount, currency: 'BRL' });
  const count = async (sql: string, params: unknown[] = []) =>
    Number(((await db.orms[0]!.em.execute(sql, params, 'all')) as unknown as { n: unknown }[])[0]!.n);

  let seq = 0;
  const bet = (walletId: string, playerId: string, amount: string) => {
    const ext = `ext-${++seq}`;
    return {
      idempotencyKey: `prov:${ext}`,
      providerId: 'prov',
      externalTransactionId: ext,
      playerId,
      walletId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: brl(amount),
      correlationId: 'corr',
    };
  };

  test('criar wallet com saldo gera OPENING + lançamento CREDIT (0,00 -> saldo) + 2 eventos, atomicamente', async () => {
    const created = await createA.execute({ playerId: 'p-open', initialBalance: brl('1000.00'), correlationId: 'c' });
    expect(created.balance).toEqual(brl('1000.00'));
    expect(created.version).toBe(1);

    const ledger = await queries.getLedger(created.id, { limit: 10 });
    expect(ledger!.items).toHaveLength(1);
    expect(ledger!.items[0]!.direction).toBe('CREDIT');
    expect(ledger!.items[0]!.balanceBefore).toEqual(brl('0.00'));
    expect(ledger!.items[0]!.balanceAfter).toEqual(brl('1000.00'));
    expect(await count(`select count(*) as n from outbox_messages where aggregate_id = ?`, [created.id])).toBe(2);
    expect(await count(`select count(*) as n from wager_transactions where wallet_id = ? and kind = 'OPENING'`, [created.id])).toBe(1);
  });

  test('wallet duplicada (playerId + moeda) é conflito, inclusive criando em paralelo em 2 instâncias', async () => {
    const attempts = await Promise.allSettled([
      createA.execute({ playerId: 'p-dup', initialBalance: brl('10.00'), correlationId: 'c' }),
      createB.execute({ playerId: 'p-dup', initialBalance: brl('10.00'), correlationId: 'c' }),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const failed = attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(WalletAlreadyExistsError);
    expect(await count(`select count(*) as n from wallets where player_id = 'p-dup'`)).toBe(1);
  });

  test('saldo inicial zero cria a wallet sem OPENING nem ledger', async () => {
    const created = await createA.execute({ playerId: 'p-zero', initialBalance: brl('0.00'), correlationId: 'c' });
    expect((await queries.getLedger(created.id, { limit: 10 }))!.items).toHaveLength(0);
    expect(await count(`select count(*) as n from wager_transactions where wallet_id = ?`, [created.id])).toBe(0);
  });

  test('ledger paginado por cursor: sem repetir nem pular, e consistente com a reconciliação', async () => {
    const wallet = await createA.execute({ playerId: 'p-page', initialBalance: brl('1000.00'), correlationId: 'c' });
    for (let i = 0; i < 5; i++) {
      const result = await process_.execute(bet(wallet.id, 'p-page', '25.00'));
      expect(result.status).toBe(S.Processed);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await queries.getLedger(wallet.id, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page!.items.map((i) => i.id));
      cursor = page!.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(seen).toHaveLength(6); // OPENING + 5 BETs
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBe(3);

    const reconciliation = await queries.reconcile(wallet.id);
    expect(reconciliation!.consistent).toBe(true);
    expect(reconciliation!.checkedEntries).toBe(6);
    expect(reconciliation!.storedBalance).toEqual(brl('875.00'));
    expect(reconciliation!.calculatedBalance).toEqual(brl('875.00'));
    expect(reconciliation!.difference).toEqual(brl('0.00'));
  });

  test('reconciliação sinaliza divergência sem corrigir o saldo', async () => {
    const wallet = await createA.execute({ playerId: 'p-diverge', initialBalance: brl('100.00'), correlationId: 'c' });
    // adulteração direta (o trigger exige version+1 quando o saldo muda)
    await db.orms[0]!.em.execute(`update wallets set balance = balance + 1.00, version = version + 1 where id = ?`, [wallet.id], 'run');

    const reconciliation = await queries.reconcile(wallet.id);
    expect(reconciliation!.consistent).toBe(false);
    expect(reconciliation!.storedBalance).toEqual(brl('101.00'));
    expect(reconciliation!.calculatedBalance).toEqual(brl('100.00'));
    expect(reconciliation!.difference).toEqual(brl('1.00'));
    expect((await queries.getWallet(wallet.id))!.balance).toEqual(brl('101.00')); // não foi "consertado"
  });

  test('consultas de transação por id e por (provider, externalId)', async () => {
    const wallet = await createA.execute({ playerId: 'p-query', initialBalance: brl('100.00'), correlationId: 'c' });
    const command = bet(wallet.id, 'p-query', '30.00');
    const result = await process_.execute(command);

    const byId = await queries.getTransactionById(result.transactionId);
    const byExternal = await queries.getTransactionByExternalId('prov', command.externalTransactionId);
    expect(byId).toEqual(byExternal!);
    expect(byId!.status).toBe('PROCESSED');
    expect(byId!.balance).toEqual(brl('70.00'));
    expect(await queries.getTransactionById(randomUUID())).toBeUndefined();
    expect(await queries.getWallet(randomUUID())).toBeUndefined();
  });
});
