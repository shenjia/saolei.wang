#!/usr/bin/env bash
#
# authority-hk-release.sh — 香港排行节点发布（2026-10-28 多地域）
#
# 从开发机直推 src/core/scripts/authority/server.mjs 到香港 ECS（systemd 托管），
# 含 drain 保护：先拒新局、等存量局打完（最多 90s）再重启，尽量不打断玩家。
# 主仓 CI 不涉及香港——core 的 server.mjs 有改动后手动跑本脚本。
#
# 用法：scripts/authority-hk-release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HK_HOST="root@47.238.251.75"
HK_KEY="$HOME/.ssh/shenjia.pem"
HK_TOKEN="$(grep -E '^AUTHORITY_HK_TOKEN=' "$ROOT/.env" | cut -d= -f2-)"
SERVER="$ROOT/src/core/scripts/authority/server.mjs"

[[ -f "$SERVER" ]] || { echo "找不到 $SERVER"; exit 1; }
[[ -n "${HK_TOKEN:-}" ]] || { echo ".env 缺 AUTHORITY_HK_TOKEN"; exit 1; }

echo "[hk] 上传 server.mjs → $HK_HOST:/opt/saolei-authority/"
scp -i "$HK_KEY" -q "$SERVER" "$HK_HOST:/opt/saolei-authority/server.mjs.new"

echo "[hk] drain（拒新局，等存量局打完，最多 90s）"
ssh -i "$HK_KEY" "$HK_HOST" "curl -s -X POST -H 'Authorization: Bearer $HK_TOKEN' http://127.0.0.1:3104/drain -d '{\"on\":true}' >/dev/null"
for i in $(seq 1 30); do
  ACTIVE=$(ssh -i "$HK_KEY" "$HK_HOST" "curl -s http://127.0.0.1:3104/health" | grep -oE '"active":[0-9]+' | cut -d: -f2)
  [[ "$ACTIVE" == "0" ]] && break
  echo "[hk] 等待存量局打完… active=$ACTIVE"
  sleep 3
done

echo "[hk] 切换新版本并重启"
ssh -i "$HK_KEY" "$HK_HOST" "mv /opt/saolei-authority/server.mjs.new /opt/saolei-authority/server.mjs && systemctl restart saolei-authority && sleep 1"

HEALTH=$(ssh -i "$HK_KEY" "$HK_HOST" "curl -s http://127.0.0.1:3104/health")
echo "[hk] health: $HEALTH"
[[ "$HEALTH" == *'"region":"hk"'* ]] || { echo "[hk] ❌ health 校验失败"; exit 1; }

# 公网面最终验证（经 Caddy，鉴权应 401 拒绝无凭据请求）
CODE=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "https://rank-hk.saolei.wang/finalize")
[[ "$CODE" == "401" ]] || { echo "[hk] ❌ 公网鉴权异常（finalize=$CODE，应为 401）"; exit 1; }
echo "[hk] ✅ 发布完成（region=hk，公网鉴权正常）"
