import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HealthProbe } from '../application/queries.js';
import { Metrics } from './metrics.js';
import { TOKENS } from './tokens.js';

/** Abertos por decisão do enunciado (sem autenticação). */
@Controller()
export class HealthController {
  constructor(
    @Inject(TOKENS.PROBES) private readonly probes: HealthProbe[],
    @Inject(TOKENS.METRICS) private readonly metrics: Metrics,
  ) {}

  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    await Promise.all(
      this.probes.map(async (probe) => {
        try {
          await Promise.race([
            probe.check(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ]);
          checks[probe.name] = 'up';
        } catch {
          checks[probe.name] = 'down';
        }
      }),
    );
    const healthy = Object.values(checks).every((state) => state === 'up');
    if (!healthy) res.status(503);
    return { status: healthy ? 'ok' : 'unavailable', checks };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  prometheus(): string {
    return this.metrics.render();
  }
}
