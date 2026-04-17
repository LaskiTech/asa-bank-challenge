#!/usr/bin/env bash
# =============================================================================
# Resilience test script
# Tests: Circuit Breaker (open/close), Retry Storm prevention (Bulkhead),
#        API behaviour with OPEN circuit breaker.
#
# Usage:  bash scripts/test-resilience.sh
# Requires: curl, openssl, docker compose running
# =============================================================================

set -euo pipefail

BASE="http://localhost:3000/v1/pos/transactions"
MOCK="http://localhost:4000"
SECRET="${SHARED_SECRET:-dev-secret-key-change-in-production}"
NSU="RES-$(date +%s)"          # unique per run — avoids idempotency replays

# ── helpers ──────────────────────────────────────────────────────────────────

green()  { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
blue()   { echo -e "\033[34m$*\033[0m"; }
red()    { echo -e "\033[31m$*\033[0m"; }
hr()     { echo "────────────────────────────────────────────────────────────"; }

sign() {
  echo -n "$1" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}'
}

api_post() {
  local path="$1" body="$2"
  curl -s -w "\n[HTTP %{http_code}]" -X POST "${BASE}${path}" \
    -H "Content-Type: application/json" \
    -H "X-Signature: $(sign "$body")" \
    -H "X-Timestamp: $(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    -d "$body"
  echo
}

mock_mode() {
  curl -s -X POST "$MOCK/admin/mode" \
    -H "Content-Type: application/json" \
    -d "{\"mode\":\"$1\"}"
  echo
}

# ── Step 0 — authorize a transaction to use in confirm/void ──────────────────

hr
blue "SETUP — authorizing a fresh transaction (NSU: $NSU)"
hr
AUTH_BODY="{\"nsu\":\"$NSU\",\"amount\":10.00,\"terminalId\":\"T-TEST\"}"
AUTH_RESP=$(api_post /authorize "$AUTH_BODY")
echo "$AUTH_RESP"
TX_ID=$(echo "$AUTH_RESP" | grep -o '"transactionId":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$TX_ID" ]]; then
  red "ERROR: could not extract transactionId. Is the API running?"
  exit 1
fi
green "transactionId: $TX_ID"

CONFIRM_BODY="{\"transactionId\":\"$TX_ID\"}"

# =============================================================================
# SCENARIO 1 — Open the Circuit Breaker
# The CB opens after 5 consecutive failures.
# Each /confirm request goes through: Bulkhead → CB → 3 retries → fail.
# That counts as 1 CB failure per request → 5 requests = CB OPEN.
# =============================================================================

hr
blue "SCENARIO 1 — Opening the Circuit Breaker"
yellow "  Switching mock to FAIL mode…"
hr
mock_mode fail

yellow "  Sending 5 /confirm requests (each exhausts 3 retries → 1 CB failure)"
yellow "  Watch docker compose logs for: 'Circuit breaker failure recorded'"
echo

for i in 1 2 3 4 5; do
  echo "--- Request $i/5 ---"
  api_post /confirm "$CONFIRM_BODY"
  echo
done

green "Circuit Breaker should now be OPEN (5/5 failures recorded)."

# =============================================================================
# SCENARIO 2 — API behaviour with OPEN Circuit Breaker
# Once OPEN, the CB rejects immediately — no retry, no external call.
# Response is 503 { "error": "circuit_breaker_open" } in <1ms.
# =============================================================================

hr
blue "SCENARIO 2 — API behaviour with OPEN Circuit Breaker"
yellow "  Sending 2 more requests. Expect instant 503 circuit_breaker_open."
yellow "  No 'External API request' log lines should appear."
hr
echo

for i in 1 2; do
  echo "--- Fast-fail request $i ---"
  api_post /confirm "$CONFIRM_BODY"
  echo
done

green "Note: no retries happened — the CB short-circuits before the first attempt."

# =============================================================================
# SCENARIO 3 — Circuit Breaker recovery (HALF_OPEN → CLOSED)
# After 30s the CB transitions to HALF_OPEN and probes with real requests.
# 2 successes → CLOSED.
# =============================================================================

hr
blue "SCENARIO 3 — Circuit Breaker recovery"
yellow "  Switching mock back to OK mode…"
mock_mode ok
echo
yellow "  Waiting 31s for OPEN → HALF_OPEN transition…"
yellow "  (CB openTimeoutMs = 30 000 ms)"

for s in $(seq 31 -1 1); do
  printf "\r  %2d s remaining…" "$s"
  sleep 1
done
echo

yellow "  Sending probe request 1 — expect CB → HALF_OPEN in logs"
api_post /confirm "$CONFIRM_BODY"
echo
yellow "  Sending probe request 2 — expect CB → CLOSED (recovered) in logs"

# Need a new TX in AUTHORIZED state for a clean confirm
NSU2="RES2-$(date +%s)"
AUTH2="{\"nsu\":\"$NSU2\",\"amount\":5.00,\"terminalId\":\"T-TEST\"}"
AUTH2_RESP=$(api_post /authorize "$AUTH2")
echo "$AUTH2_RESP"
TX2=$(echo "$AUTH2_RESP" | grep -o '"transactionId":"[^"]*"' | cut -d'"' -f4)
api_post /confirm "{\"transactionId\":\"$TX2\"}"
echo

green "Circuit Breaker should now be CLOSED again."

# =============================================================================
# SCENARIO 4 — Retry Storm prevention (Bulkhead)
# Mock switches to SLOW (6s delay > 5s timeout → TimeoutError).
# We fire 11 concurrent requests. First 10 acquire bulkhead slots.
# The 11th is rejected immediately with 503 bulkhead_full.
# Without the bulkhead, 11+ slow Promises would pile up indefinitely.
# =============================================================================

hr
blue "SCENARIO 4 — Retry Storm prevention (Bulkhead)"
yellow "  Authorizing 11 fresh transactions (mock still in OK mode)…"
hr

# Authorize while mock is still OK so none of the setups are slow
TXS=()
for i in $(seq 1 11); do
  N="BULK-$(date +%s)-$i"
  R=$(api_post /authorize "{\"nsu\":\"$N\",\"amount\":1.00,\"terminalId\":\"T-BULK\"}" 2>/dev/null)
  T=$(echo "$R" | grep -o '"transactionId":"[^"]*"' | cut -d'"' -f4)
  TXS+=("$T")
done
green "  Authorized 11 transactions."
echo

yellow "  Switching mock to SLOW mode (6 s delay — longer than the 5 s timeout)…"
mock_mode slow
echo
yellow "  Firing 11 concurrent /confirm requests in the background…"
yellow "  Requests 1-10: acquire bulkhead slots → timeout after 5s → retry chain"
yellow "  Request 11:    instant 503 bulkhead_full (no slot available)"
echo

TMPDIR_RESULTS=$(mktemp -d)
for i in "${!TXS[@]}"; do
  CB="{\"transactionId\":\"${TXS[$i]}\"}"
  (api_post /confirm "$CB" > "$TMPDIR_RESULTS/req_$i.txt" 2>&1) &
done

wait
echo
yellow "Results:"
for i in $(seq 0 10); do
  result=$(cat "$TMPDIR_RESULTS/req_$i.txt" 2>/dev/null || echo "(no output)")
  if echo "$result" | grep -q "bulkhead_full"; then
    red   "  Request $((i+1)): REJECTED — $result"
  elif echo "$result" | grep -q "503\|circuit_breaker"; then
    yellow "  Request $((i+1)): 503 — $result"
  else
    echo  "  Request $((i+1)): $result"
  fi
done
rm -rf "$TMPDIR_RESULTS"

echo
green "Bulkhead prevented the 11th request from adding to the pile-up."
yellow "(Switch mock back to ok mode when done: curl -X POST http://localhost:4000/admin/mode -H 'Content-Type: application/json' -d '{\"mode\":\"ok\"}')"

hr
green "All resilience scenarios complete. Check 'docker compose logs api' for full trace."
hr
