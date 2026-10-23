import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config.js';

/**
 * Uso:
 *   bun run db:migrate   -> aplica as migrations pendentes
 *   bun run db:rollback  -> desfaz a última migration
 *   bun run db:status    -> lista executadas e pendentes
 */
const command = process.argv[2] ?? 'up';
const orm = await MikroORM.init(config);

try {
  switch (command) {
    case 'up': {
      const applied = await orm.migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply');
      break;
    }
    case 'down': {
      const reverted = await orm.migrator.down();
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert');
      break;
    }
    case 'status': {
      const executed = await orm.migrator.getExecuted();
      const pending = await orm.migrator.getPending();
      console.log('Executed:', executed.map((m) => m.name));
      console.log('Pending: ', pending.map((m) => m.name));
      break;
    }
    default:
      console.error(`Unknown command "${command}". Use: up | down | status`);
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
