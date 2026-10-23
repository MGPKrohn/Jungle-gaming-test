import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from './application/create-wallet.js';
import { ProcessWagerTransaction } from './application/process-wager-transaction.js';
import { AllExceptionsFilter } from './api/all-exceptions.filter.js';
import { HealthController } from './api/health.controller.js';
import { systemClock, uuidV7Generator } from './api/ids.js';
import { Metrics } from './api/metrics.js';
import { TOKENS } from './api/tokens.js';
import { WageringController } from './api/wagering.controller.js';
import { WalletsController } from './api/wallets.controller.js';
import { createSqsClient, SqsProbe } from './infrastructure/messaging/sqs-probe.js';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work.js';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config.js';
import { PostgresProbe } from './infrastructure/persistence/postgres-probe.js';
import { PostgresWalletQueries } from './infrastructure/persistence/postgres-queries.js';

/**
 * Composition root: a ÚNICA classe que conhece as implementações concretas.
 * Fábricas explícitas (sem decorators nas classes de aplicação/domínio).
 */
@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    { provide: TOKENS.ORM, useFactory: () => MikroORM.init(buildOrmConfig()) },
    {
      provide: TOKENS.PROCESS_WAGER,
      useFactory: (orm: MikroORM) => new ProcessWagerTransaction(new MikroOrmUnitOfWork(orm), systemClock, uuidV7Generator),
      inject: [TOKENS.ORM],
    },
    {
      provide: TOKENS.CREATE_WALLET,
      useFactory: (orm: MikroORM) => new CreateWallet(new MikroOrmUnitOfWork(orm), systemClock, uuidV7Generator),
      inject: [TOKENS.ORM],
    },
    { provide: TOKENS.QUERIES, useFactory: (orm: MikroORM) => new PostgresWalletQueries(orm), inject: [TOKENS.ORM] },
    { provide: TOKENS.METRICS, useValue: new Metrics() },
    {
      provide: TOKENS.PROBES,
      useFactory: (orm: MikroORM) => [
        new PostgresProbe(orm),
        new SqsProbe(createSqsClient(), process.env.SQS_QUEUE_NAME ?? 'wager-transactions.fifo'),
      ],
      inject: [TOKENS.ORM],
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(TOKENS.ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(); // shutdown gracioso: devolve as conexões ao Postgres
  }
}
