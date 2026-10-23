-- Verifica que o BANCO (não a aplicação) rejeita o que precisa rejeitar.
-- Tudo roda dentro de uma transação que termina em ROLLBACK: não deixa dados.
--
-- Requer as DUAS migrations aplicadas (bun run db:migrate).
-- Uso (na raiz do projeto):
--   docker compose exec -T postgres psql -U wallet -d wallet < infra/postgres/verify-constraints.sql
--
-- Cada verificação imprime "PASS". Qualquer FAIL interrompe o script (ON_ERROR_STOP).
\set ON_ERROR_STOP on
\set VERBOSITY terse
\pset tuples_only on

begin;

-- ------------------------------------------------------------------ helpers
create function pg_temp.expect_violation(label text, stmt text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when integrity_constraint_violation then
    raise notice 'PASS  %', label;
    return;
  end;
  raise exception 'FAIL  %  (a instrucao foi aceita, mas deveria ser rejeitada)', label;
end $$;

create function pg_temp.expect_ok(label text, stmt text) returns void
language plpgsql as $$
begin
  execute stmt;
  raise notice 'PASS  %', label;
exception when others then
  raise exception 'FAIL  %  (esperava sucesso, mas deu erro: %)', label, sqlerrm;
end $$;

create function pg_temp.new_tx(
  p_id uuid, p_ext text, p_kind text, p_amount numeric, p_status text,
  p_ref_ext text default null, p_ref_id uuid default null,
  p_failure text default null, p_idem text default null,
  p_no_balance boolean default false
) returns void language plpgsql as $$
begin
  insert into wager_transactions (
    id, provider_id, external_transaction_id, idempotency_key, payload_hash,
    wallet_id, player_id, round_id, game_id, kind, amount, currency,
    reference_external_transaction_id, reference_transaction_id,
    status, failure_code, created_at, processed_at, reference_attempts, observed_balance)
  values (
    p_id, 'prov', p_ext, coalesce(p_idem, 'prov:' || p_ext), 'hash',
    'aaaaaaaa-0000-0000-0000-000000000001', 'verify-player', 'r1', 'g1', p_kind, p_amount, 'BRL',
    p_ref_ext, p_ref_id,
    p_status, p_failure, now(),
    case when p_status in ('PROCESSED','REJECTED','FAILED') then now() end, 0,
    case when p_status = 'PROCESSED' and not p_no_balance then 0.00 end);
end $$;

create function pg_temp.new_entry(
  p_id uuid, p_tx uuid, p_dir text, p_amount numeric, p_before numeric, p_after numeric
) returns void language plpgsql as $$
begin
  insert into wallet_ledger_entries (
    id, wallet_id, transaction_id, direction, amount, currency,
    balance_before, balance_after, created_at)
  values (
    p_id, 'aaaaaaaa-0000-0000-0000-000000000001', p_tx, p_dir, p_amount, 'BRL',
    p_before, p_after, now());
end $$;

-- ---------------------------------------------------------------- fixtures
insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'verify-player', 'BRL', 100.00, 1, now(), now());

select pg_temp.new_tx('bbbbbbbb-0000-0000-0000-000000000001', 'ext-bet-1', 'BET', 80.00, 'PENDING');
select pg_temp.new_tx('cccccccc-0000-0000-0000-000000000001', 'ext-win-1', 'WIN', 10.00, 'PROCESSED');

-- ----------------------------------------------------------------- wallets
select pg_temp.expect_violation('wallets: saldo negativo',
  $q$ update wallets set balance = -0.01, version = 2 where id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
select pg_temp.expect_violation('wallets: version sobe sem o saldo mudar',
  $q$ update wallets set version = 5 where id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
select pg_temp.expect_violation('wallets: saldo muda sem a version subir',
  $q$ update wallets set balance = 90.00 where id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
select pg_temp.expect_violation('wallets: player_id e imutavel',
  $q$ update wallets set player_id = 'other' where id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
select pg_temp.expect_violation('wallets: (player, moeda) duplicado',
  $q$ insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (gen_random_uuid(), 'verify-player', 'BRL', 1.00, 1, now(), now()) $q$);
select pg_temp.expect_violation('wallets: moeda em formato invalido',
  $q$ insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (gen_random_uuid(), 'other-player', 'brl', 1.00, 1, now(), now()) $q$);
select pg_temp.expect_ok('wallets: debito valido (100.00 -> 20.00, version 1 -> 2)',
  $q$ update wallets set balance = 20.00, version = 2 where id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);

-- ------------------------------------------------------------ transactions
select pg_temp.expect_violation('tx: idempotency_key duplicada',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-a', 'BET', 5.00, 'PENDING', null, null, null, 'prov:ext-bet-1') $q$);
select pg_temp.expect_violation('tx: (provider, external_transaction_id) duplicado',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-bet-1', 'BET', 5.00, 'PENDING', null, null, null, 'idem-x') $q$);
select pg_temp.expect_violation('tx: REFUND sem referencia',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-b', 'REFUND', 5.00, 'PENDING') $q$);
select pg_temp.expect_violation('tx: BET com valor zero',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-c', 'BET', 0.00, 'PENDING') $q$);
select pg_temp.expect_ok('tx: LOSS com valor zero e permitido',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-loss-1', 'LOSS', 0.00, 'PENDING') $q$);
select pg_temp.expect_violation('tx: kind invalido',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-d', 'FOO', 5.00, 'PENDING') $q$);
select pg_temp.expect_violation('tx: status invalido',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-e', 'BET', 5.00, 'DONE') $q$);
select pg_temp.expect_violation('tx: REJECTED sem failure_code',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-f', 'BET', 5.00, 'REJECTED') $q$);
select pg_temp.expect_violation('tx: failure_code em transacao PENDING',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-g', 'BET', 5.00, 'PENDING', null, null, 'X') $q$);
select pg_temp.expect_ok('tx: PENDING -> PROCESSED',
  $q$ update wager_transactions set status = 'PROCESSED', processed_at = now(), observed_balance = 20.00
      where id = 'bbbbbbbb-0000-0000-0000-000000000001' $q$);
select pg_temp.expect_violation('tx: estado terminal nao pode ser alterado',
  $q$ update wager_transactions set game_id = 'x' where id = 'bbbbbbbb-0000-0000-0000-000000000001' $q$);
select pg_temp.expect_violation('tx: nunca pode ser apagada',
  $q$ delete from wager_transactions where id = 'bbbbbbbb-0000-0000-0000-000000000001' $q$);

select pg_temp.expect_violation('tx: PROCESSED exige observed_balance',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-nb', 'BET', 5.00, 'PROCESSED', null, null, null, null, true) $q$);

-- ------------------------------------------------------------------ ledger
select pg_temp.expect_ok('ledger: DEBIT de 80.00 (100.00 -> 20.00)',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', 'DEBIT', 80.00, 100.00, 20.00) $q$);
select pg_temp.expect_violation('ledger: segundo lancamento para a mesma (wallet, transacao)',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'bbbbbbbb-0000-0000-0000-000000000001', 'DEBIT', 80.00, 100.00, 20.00) $q$);
select pg_temp.expect_violation('ledger: aritmetica inconsistente',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 'CREDIT', 10.00, 20.00, 35.00) $q$);
select pg_temp.expect_violation('ledger: direcao trocada',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 'DEBIT', 10.00, 20.00, 30.00) $q$);
select pg_temp.expect_violation('ledger: valor zero',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 'CREDIT', 0.00, 20.00, 20.00) $q$);
select pg_temp.expect_violation('ledger: saldo final negativo',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 'DEBIT', 30.00, 20.00, -10.00) $q$);
select pg_temp.expect_violation('ledger: wallet inexistente (FK)',
  $q$ insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
      values (gen_random_uuid(), 'ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'CREDIT', 10.00, 'BRL', 20.00, 30.00, now()) $q$);
select pg_temp.expect_ok('ledger: CREDIT de 10.00 (20.00 -> 30.00)',
  $q$ select pg_temp.new_entry(gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 'CREDIT', 10.00, 20.00, 30.00) $q$);
select pg_temp.expect_violation('ledger: UPDATE proibido (append-only)',
  $q$ update wallet_ledger_entries set amount = amount $q$);
select pg_temp.expect_violation('ledger: DELETE proibido (append-only)',
  $q$ delete from wallet_ledger_entries $q$);
select pg_temp.expect_violation('ledger: TRUNCATE proibido (append-only)',
  $q$ truncate wallet_ledger_entries $q$);

-- ---------------------------------------------------------------- reversoes
select pg_temp.expect_ok('reversao: REFUND processado referenciando a BET',
  $q$ select pg_temp.new_tx('dddddddd-0000-0000-0000-000000000001', 'ext-ref-1', 'REFUND', 80.00, 'PROCESSED',
        'ext-bet-1', 'bbbbbbbb-0000-0000-0000-000000000001') $q$);
select pg_temp.expect_violation('reversao: segundo REFUND da mesma BET (regra 4)',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-ref-2', 'REFUND', 80.00, 'PROCESSED',
        'ext-bet-1', 'bbbbbbbb-0000-0000-0000-000000000001') $q$);

select pg_temp.expect_violation('reversao: ROLLBACK da mesma BET apos REFUND (regra 4 estrita)',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-rb-1', 'ROLLBACK', 80.00, 'PROCESSED',
        'ext-bet-1', 'bbbbbbbb-0000-0000-0000-000000000001') $q$);
select pg_temp.expect_ok('reversao: ROLLBACK do REFUND e permitido (referencia diferente)',
  $q$ select pg_temp.new_tx(gen_random_uuid(), 'ext-rb-2', 'ROLLBACK', 80.00, 'PROCESSED',
        'ext-ref-1', 'dddddddd-0000-0000-0000-000000000001') $q$);

-- -------------------------------------------------------------- inbox/outbox
select pg_temp.expect_ok('inbox: primeira mensagem',
  $q$ insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c1', 'm1', 'h', now()) $q$);
select pg_temp.expect_violation('inbox: mensagem duplicada (consumer, message_id)',
  $q$ insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('c1', 'm1', 'h', now()) $q$);
select pg_temp.expect_violation('outbox: attempts negativo',
  $q$ insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
      values (gen_random_uuid(), 'agg', 'evt', '{}'::jsonb, now(), -1) $q$);

rollback;

select 'TODAS AS VERIFICACOES PASSARAM (transacao desfeita com ROLLBACK)' as resultado;
