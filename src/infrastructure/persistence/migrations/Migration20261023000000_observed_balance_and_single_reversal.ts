import { Migration } from '@mikro-orm/migrations';

/**
 * 1) observed_balance: guarda o saldo observado quando a transação foi resolvida.
 *    A regra 7 exige devolver esse saldo num replay, e um LOSS não gera ledger
 *    de onde ler. PROCESSED sempre tem saldo observado.
 * 2) Regra 4 ESTRITA: uma referência só pode ser revertida UMA vez, por qualquer
 *    tipo (REFUND ou ROLLBACK). A versão por tipo permitia REFUND + ROLLBACK da
 *    mesma BET, creditando duas vezes um único débito.
 *
 * Pré-requisito: wager_transactions sem linhas PROCESSED antigas (ambiente de dev vazio).
 */
export class Migration20261023000000ObservedBalanceAndSingleReversal extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions add column observed_balance numeric(20,2)`);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_observed_balance_non_negative
        check (observed_balance is null or observed_balance >= 0)
    `);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_processed_has_balance
        check (status <> 'PROCESSED' or observed_balance is not null)
    `);

    this.addSql(`drop index wager_tx_one_reversal_per_reference`);
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index wager_tx_one_reversal_per_reference`);
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
    `);
    this.addSql(`alter table wager_transactions drop constraint wager_tx_processed_has_balance`);
    this.addSql(`alter table wager_transactions drop constraint wager_tx_observed_balance_non_negative`);
    this.addSql(`alter table wager_transactions drop column observed_balance`);
  }
}
