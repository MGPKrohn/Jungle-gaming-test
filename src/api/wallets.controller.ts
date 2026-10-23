import { Body, Controller, Get, HttpCode, Inject, Logger, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CreateWallet, type CreateWalletResult } from '../application/create-wallet.js';
import { NotFoundError } from '../application/errors.js';
import type {
  LedgerPageView,
  ReconciliationView,
  WalletQueries,
  WalletView,
} from '../application/queries.js';
import { parseCreateWalletBody, parseLedgerQuery, parseUuid } from '../application/request-parsing.js';
import { NoopAuthGuard } from './noop-auth.guard.js';
import { Metrics } from './metrics.js';
import { TOKENS } from './tokens.js';

const correlationOf = (req: Request): string =>
  (req as Request & { correlationId?: string }).correlationId ?? 'unknown';

@Controller()
@UseGuards(NoopAuthGuard)
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    @Inject(TOKENS.CREATE_WALLET) private readonly createWallet: CreateWallet,
    @Inject(TOKENS.QUERIES) private readonly queries: WalletQueries,
    @Inject(TOKENS.METRICS) private readonly metrics: Metrics,
  ) {}

  @Post('wallets')
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: Request): Promise<CreateWalletResult> {
    const input = parseCreateWalletBody(body);
    return this.createWallet.execute({ ...input, correlationId: correlationOf(req) });
  }

  @Get('wallets/:walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    const wallet = await this.queries.getWallet(parseUuid('walletId', walletId));
    if (!wallet) throw new NotFoundError('Wallet not found');
    return wallet;
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<LedgerPageView> {
    const page = await this.queries.getLedger(parseUuid('walletId', walletId), parseLedgerQuery(query));
    if (!page) throw new NotFoundError('Wallet not found');
    return page;
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    const id = parseUuid('walletId', walletId);
    const result = await this.queries.reconcile(id);
    if (!result) throw new NotFoundError('Wallet not found');
    if (!result.consistent) {
      // divergência NUNCA é corrigida em silêncio: log + métrica + sinal na resposta
      this.metrics.increment('reconciliation_divergences_total');
      this.logger.error(
        JSON.stringify({
          msg: 'reconciliation_divergence',
          walletId: id,
          storedBalance: result.storedBalance,
          calculatedBalance: result.calculatedBalance,
          difference: result.difference,
        }),
      );
    }
    this.metrics.increment('reconciliations_total', { consistent: String(result.consistent) });
    return result;
  }
}
