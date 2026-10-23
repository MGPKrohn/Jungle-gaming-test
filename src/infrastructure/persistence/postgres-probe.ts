import type { MikroORM } from '@mikro-orm/postgresql';
import type { HealthProbe } from '../../application/queries.js';

export class PostgresProbe implements HealthProbe {
  readonly name = 'postgres';
  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await this.orm.em.fork().execute('select 1', [], 'all');
  }
}
