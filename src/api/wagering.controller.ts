import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../application/errors.js';
import {
  ProcessWagerTransaction,
  type ProcessWagerTransactionResult,
} from '../application/process-wager-transaction.js';
import type { TransactionView, WalletQueries } from '../application/queries.js';
import { parseSubmitTransactionRequest, parseText, parseUuid } from '../application/request-parsing.js';
import { statusForResult } from './http-mapping.js';
import { Metrics } from './metrics.js';
import { NoopAuthGuard } from './noop-auth.guard.js';
import { TOKENS } from './tokens.js';

@Controller()
@UseGuards(NoopAuthGuard)
export class WageringController {
  constructor(
    @Inject(TOKENS.PROCESS_WAGER) private readonly processWager: ProcessWagerTransaction,
    @Inject(TOKENS.QUERIES) private readonly queries: WalletQueries,
    @Inject(TOKENS.METRICS) private readonly metrics: Metrics,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessWagerTransactionResult> {
    const correlationId = (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    const command = parseSubmitTransactionRequest(body, idempotencyKey, correlationId);
    const result = await this.processWager.execute(command);

    res.status(statusForResult(result));
    this.metrics.increment('wager_transactions_total', {
      kind: command.kind,
      status: result.status,
      replay: String(result.idempotentReplay),
    });
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    const view = await this.queries.getTransactionById(parseUuid('transactionId', transactionId));
    if (!view) throw new NotFoundError('Transaction not found');
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    const view = await this.queries.getTransactionByExternalId(
      parseText('providerId', providerId),
      parseText('externalTransactionId', externalTransactionId),
    );
    if (!view) throw new NotFoundError('Transaction not found');
    return view;
  }
}
