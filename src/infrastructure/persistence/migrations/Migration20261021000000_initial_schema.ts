import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem aqui, no banco — o código de aplicação é só a primeira linha de defesa.
 *
 * Atenção: não usar o caractere "?" nos SQLs abaixo (o driver pode tratá-lo
 * como placeholder de binding).
 */
export class Migration20261021000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id          uuid          primary key,
        player_id   text          not null,
        currency    char(3)       not null,
        balance     numeric(20,2) not null,
        version     integer       not null default 1,
        created_at  timestamptz   not null,
        updated_at  timestamptz   not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive     check (version >= 1),
        constraint wallets_currency_format      check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_player_currency_uq   unique (player_id, currency)
      )
    `);

    // version só sobe quando o saldo muda; player/moeda são imutáveis.
    this.addSql(`
      create function wallets_enforce_rules() returns trigger as $$
      begin
        if new.player_id <> old.player_id or new.currency <> old.currency then
          raise exception 'wallets.player_id and wallets.currency are immutable'
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance is distinct from old.balance then
          if new.version <> old.version + 1 then
            raise exception 'wallets.version must increase by 1 when balance changes'
              using errcode = 'integrity_constraint_violation';
          end if;
        elsif new.version <> old.version then
          raise exception 'wallets.version can only change together with balance'
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger wallets_enforce_rules before update on wallets
        for each row execute function wallets_enforce_rules()
    `);

    // ----------------------------------------------------- wager_transactions
    // Sem FK em wallet_id de propósito: uma transação para wallet inexistente
    // precisa ser gravada como REJECTED (WALLET_NOT_FOUND) para ser idempotente
    // e auditável. O ledger, que move dinheiro, tem FK.
    this.addSql(`
      create table wager_transactions (
        id                                uuid          primary key,
        provider_id                       text          not null,
        external_transaction_id           text          not null,
        idempotency_key                   text          not null,
        payload_hash                      text          not null,
        wallet_id                         uuid          not null,
        player_id                         text          not null,
        round_id                          text          not null,
        game_id                           text          not null,
        kind                              text          not null,
        amount                            numeric(20,2) not null,
        currency                          char(3)       not null,
        reference_external_transaction_id text,
        reference_transaction_id          uuid          references wager_transactions(id),
        status                            text          not null,
        failure_code                      text,
        created_at                        timestamptz   not null,
        processed_at                      timestamptz,
        reference_attempts                integer       not null default 0,
        next_attempt_at                   timestamptz,
        constraint wager_tx_idempotency_key_uq  unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_kind_valid check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_valid check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_tx_amount_valid check (amount >= 0 and (kind = 'LOSS' or amount > 0)),
        constraint wager_tx_reference_required check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null
        ),
        constraint wager_tx_failure_code_consistent check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)
        ),
        constraint wager_tx_processed_at_consistent check (
          (status in ('PROCESSED','REJECTED','FAILED')) = (processed_at is not null)
        ),
        constraint wager_tx_reference_link_only_if_processed check (
          reference_transaction_id is null or status = 'PROCESSED'
        ),
        constraint wager_tx_attempts_non_negative check (reference_attempts >= 0)
      )
    `);

    // Regra 4: uma referência não pode ser revertida duas vezes pelo mesmo tipo.
    this.addSql(`
      create unique index wager_tx_one_reversal_per_reference
        on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id)`);
    // Worker de PENDING_REFERENCE: o que está vencido para nova tentativa.
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);
    // Quando uma referência chega, achar quem estava esperando por ela.
    this.addSql(`
      create index wager_tx_waiting_for_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE'
    `);

    // Estados terminais não mudam; nada é apagado (trilha de auditoria).
    this.addSql(`
      create function wager_transactions_guard() returns trigger as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted'
            using errcode = 'integrity_constraint_violation';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transactions % is terminal (%) and cannot be modified', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger wager_transactions_guard before update or delete on wager_transactions
        for each row execute function wager_transactions_guard()
    `);

    // ---------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id             uuid          primary key,
        wallet_id      uuid          not null references wallets(id),
        transaction_id uuid          not null references wager_transactions(id),
        direction      text          not null,
        amount         numeric(20,2) not null,
        currency       char(3)       not null,
        balance_before numeric(20,2) not null,
        balance_after  numeric(20,2) not null,
        created_at     timestamptz   not null,
        constraint ledger_direction_valid  check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive  check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_currency_format  check (currency ~ '^[A-Z]{3}$'),
        constraint ledger_entry_balanced check (
          (direction = 'DEBIT'  and balance_before - amount = balance_after) or
          (direction = 'CREDIT' and balance_before + amount = balance_after)
        ),
        -- no máximo um lançamento por wallet para cada transação financeira
        constraint ledger_one_entry_per_wallet_tx unique (wallet_id, transaction_id)
      )
    `);
    // Paginação por cursor estável (ids são UUID v7, ordenáveis no tempo).
    this.addSql(`create index ledger_wallet_cursor_idx on wallet_ledger_entries (wallet_id, id)`);
    this.addSql(`create index ledger_transaction_idx on wallet_ledger_entries (transaction_id)`);

    // Append-only: nem UPDATE, nem DELETE, nem TRUNCATE.
    this.addSql(`
      create function wallet_ledger_entries_append_only() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% is not allowed)', tg_op
          using errcode = 'integrity_constraint_violation';
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_append_only()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_append_only()
    `);

    // ------------------------------------------------------------------ inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name text        not null,
        message_id    text        not null,
        payload_hash  text        not null,
        received_at   timestamptz not null,
        processed_at  timestamptz,
        primary key (consumer_name, message_id)
      )
    `);

    // ----------------------------------------------------------------- outbox
    this.addSql(`
      create table outbox_messages (
        id              uuid        primary key,
        aggregate_id    text        not null,
        event_type      text        not null,
        payload         jsonb       not null,
        occurred_at     timestamptz not null,
        attempts        integer     not null default 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        constraint outbox_attempts_non_negative check (attempts >= 0)
      )
    `);
    // Publishers concorrentes leem lotes com FOR UPDATE SKIP LOCKED sobre este índice.
    this.addSql(`
      create index outbox_pending_idx on outbox_messages (occurred_at)
        where published_at is null
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages`);
    this.addSql(`drop table if exists inbox_messages`);
    this.addSql(`drop table if exists wallet_ledger_entries`);
    this.addSql(`drop function if exists wallet_ledger_entries_append_only()`);
    this.addSql(`drop table if exists wager_transactions`);
    this.addSql(`drop function if exists wager_transactions_guard()`);
    this.addSql(`drop table if exists wallets`);
    this.addSql(`drop function if exists wallets_enforce_rules()`);
  }
}
