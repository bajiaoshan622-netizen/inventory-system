#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://inventory.formfill.cc}"
ADMIN_PASS="${ADMIN_PASS:-WfrK1nCvpUgpNtj}"
AGENT_API_KEY="${AGENT_API_KEY:-}"

echo "[1] admin login"
TOKEN=$(curl -sS -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ADMIN_PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')

if [[ -z "$TOKEN" ]]; then
  echo "login failed"; exit 1
fi


echo "[2] create admin inbound (approved)"
curl -sS -X POST "$BASE_URL/api/v2/inbound" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":1,"category_id":1,"batch_no":"BATCH-E2E","actual_qty":10,"actual_weight":1.0}'

echo "\n[3] check balance"
curl -sS "$BASE_URL/api/v2/balance?tenantId=1&categoryId=1&batchNo=BATCH-E2E" \
  -H "Authorization: Bearer $TOKEN"

echo "\n[4] outbound over-limit should fail (409)"
set +e
curl -sS -o /tmp/e2e_v2_out.json -w "%{http_code}" -X POST "$BASE_URL/api/v2/outbound" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenant_id":1,"category_id":1,"batch_no":"BATCH-E2E","outbound_qty":9999,"outbound_weight":999}'
set -e

echo "\n[done]"
