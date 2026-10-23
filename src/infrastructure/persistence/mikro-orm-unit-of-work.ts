import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork } from '../../application/ports.js';
import { createScope } from './postgres-scope.js';

/**
 * Uma transação SQL por chamada: commit se o trabalho resolve, rollback se lança.
 * `fork()` dá um EntityManager limpo por operação (sem estado compartilhado entre
 * requisições). Isolamento: READ COMMITTED (padrão), exigido pelo use case: o
 * SELECT após um claim perdido precisa enxergar a linha que o outro commit gravou.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional((em) => work(createScope(em)));
  }
}
