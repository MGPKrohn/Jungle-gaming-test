import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { uuidV7Generator } from './api/ids.js';
import type { Metrics } from './api/metrics.js';
import { requestLogging } from './api/request-logging.js';
import { TOKENS } from './api/tokens.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT => onApplicationShutdown => fecha o pool
  app.use(requestLogging(app.get<Metrics>(TOKENS.METRICS), () => uuidV7Generator.next()));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'listening', port }));
}

void bootstrap();
