#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT_DIR/src/index.ts"
API_DOC="$ROOT_DIR/docs/api-v2.md"
UI_DOC="$ROOT_DIR/docs/ui-admin-v2.md"

pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; exit 1; }

echo "[C5/C6] 静态验收检查开始"

grep -q "app.get('/api/v2/ledger/inbound-outbound'" "$SRC" || fail "缺少 ledger 接口"
grep -q "outbounds" "$SRC" || fail "ledger 未输出 outbounds"
grep -q "outbound_summary" "$SRC" || fail "ledger 未输出 outbound_summary"
grep -q "remaining:" "$SRC" || fail "ledger 未输出 remaining"
pass "P0-1 ledger 嵌套结构代码存在"

grep -q "toggleOutboundDetails" "$SRC" || fail "缺少主行展开逻辑"
grep -q "未出库" "$SRC" || fail "缺少未出库空态文案"
pass "P0-2 UI 展开与未出库空态代码存在"

grep -q "最多可出" "$SRC" || fail "缺少超限动态文案"
grep -q "lastUpdatedInboundId" "$SRC" || fail "缺少成功后定位高亮状态"
grep -q "row-highlight" "$SRC" || fail "缺少高亮样式"
pass "P0-3 超限动态文案 + 成功定位高亮代码存在"

grep -q "inbound/outbounds/outbound_summary/remaining" "$API_DOC" || fail "API 文档缺少结构要求"
grep -q "一对多出库可视化" "$UI_DOC" || fail "UI 文档缺少展开规范"
pass "文档契约已补齐"

echo "[C5/C6] 静态验收检查通过"

if [[ -n "${BASE_URL:-}" ]]; then
  echo "[C5/C6] 运行时检查 BASE_URL=$BASE_URL"
  curl -fsS "$BASE_URL/api/health" >/dev/null
  pass "health 检查通过"
else
  echo "[C5/C6] 未设置 BASE_URL，跳过运行时 API 检查"
fi
