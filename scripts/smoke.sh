#!/usr/bin/env bash
# Fumaça manual da API (app rodando em $BASE). Uso: bash scripts/smoke.sh
set -u
BASE="${BASE:-http://localhost:3000}"
PLAYER="player-$(date +%s)"
show() { echo; echo "### $1"; }

show "1) criar wallet com 1000,00 (esperado 201)"
WALLET_JSON=$(curl -s -w '\nHTTP %{http_code}' -X POST "$BASE/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}")
echo "$WALLET_JSON"
WALLET_ID=$(echo "$WALLET_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

show "2) wallet duplicada (esperado 409)"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/wallets" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1.00\",\"currency\":\"BRL\"}}"

bet() { # $1=ext $2=valor $3=idempotency-key
  curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/wagering/transactions" \
    -H 'content-type: application/json' -H "Idempotency-Key: $3" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"$2\",\"currency\":\"BRL\"}}"
}
EXT="tx-$(date +%s%N)"
show "3) BET de 25,00 (esperado 201, saldo 975.00)";            bet "$EXT" "25.00" "provider-a:$EXT"
show "4) mesma requisição (esperado 200, idempotentReplay=true)"; bet "$EXT" "25.00" "provider-a:$EXT"
show "5) mesma key, valor diferente (esperado 409)";             bet "$EXT" "30.00" "provider-a:$EXT"
show "6) aposta acima do saldo (esperado 422 INSUFFICIENT_FUNDS)"; E2="tx-big-$(date +%s%N)"; bet "$E2" "99999.00" "provider-a:$E2"
show "7) valor sem 2 casas (esperado 400)";                      E3="tx-bad-$(date +%s%N)"; bet "$E3" "25" "provider-a:$E3"
show "8) wallet inexistente com UUID inválido (esperado 400)";   curl -s -w '\nHTTP %{http_code}\n' "$BASE/wallets/nao-e-uuid"
show "9) ledger (OPENING + BET)";                               curl -s -w '\nHTTP %{http_code}\n' "$BASE/wallets/$WALLET_ID/ledger?limit=1"
show "10) reconciliação (esperado consistent=true)";            curl -s -w '\nHTTP %{http_code}\n' -X POST "$BASE/wallets/$WALLET_ID/reconciliation"
show "11) health";                                              curl -s -w '\nHTTP %{http_code}\n' "$BASE/health/ready"
show "12) métricas";                                            curl -s "$BASE/metrics" | head -12
