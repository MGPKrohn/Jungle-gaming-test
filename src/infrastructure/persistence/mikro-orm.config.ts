import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261021000000InitialSchema } from './migrations/Migration20261021000000_initial_schema.js';
import { Migration20261023000000ObservedBalanceAndSingleReversal } from './migrations/Migration20261023000000_observed_balance_and_single_reversal.js';
import { persistenceSchemas } from './schemas.js';

/**
 * Config único, usado pelo script de migrations, pelo app Nest e pelos testes
 * de integração. O Bun carrega o .env sozinho (a v7 do MikroORM não faz isso).
 * Defaults batem com o docker-compose.yml (Postgres publicado na 5433).
 */
export function buildOrmConfig(overrides: { dbName?: string } = {}) {
  return defineConfig({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    user: process.env.POSTGRES_USER ?? 'wallet',
    password: process.env.POSTGRES_PASSWORD ?? 'wallet',
    dbName: overrides.dbName ?? process.env.POSTGRES_DB ?? 'wallet',

    entities: persistenceSchemas,
    extensions: [Migrator],

    migrations: {
      // Lista explícita: não depende de glob de arquivos nem de loader de TS
      // (ambos são pontos frágeis sob Bun). Nova migration => nova linha aqui.
      migrationsList: [
        {
          name: 'Migration20261021000000_initial_schema',
          class: Migration20261021000000InitialSchema,
        },
        {
          name: 'Migration20261023000000_observed_balance_and_single_reversal',
          class: Migration20261023000000ObservedBalanceAndSingleReversal,
        },
      ],
      tableName: 'mikro_orm_migrations',
      transactional: true, // cada migration roda numa transação SQL
      allOrNothing: true,
      snapshot: false,
      // false: o padrão tenta `session_replication_role = replica`, que exige
      // superuser e desliga triggers de usuário. Não precisamos disso.
      disableForeignKeys: false,
    },
  });
}

export default buildOrmConfig();
