import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config.js';

/** Banco novo por execução, migrations aplicadas, N instâncias (ORMs/pools) independentes. */
export async function createTestDatabase(instances = 2) {
  const dbName = `wallet_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = await MikroORM.init(buildOrmConfig({ dbName: 'postgres' }));
  await admin.em.execute(`create database ${dbName}`);
  const orms: MikroORM[] = [];
  for (let i = 0; i < instances; i++) orms.push(await MikroORM.init(buildOrmConfig({ dbName })));
  await orms[0]!.migrator.up();
  return {
    orms,
    async drop() {
      await Promise.all(orms.map((orm) => orm.close(true)));
      await admin.em.execute(`drop database if exists ${dbName} with (force)`);
      await admin.close(true);
    },
  };
}
