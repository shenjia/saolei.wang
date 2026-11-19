#!/usr/bin/env bash
#
# authority-hz-release.sh — 杭州排行节点发布（2026-10-31 多地域）
#
# 从开发机直推 src/core/scripts/authority/server.mjs 到杭州 ECS（systemd 托管），
# 含 drain 保护：先拒新局、等存量局打完（最多 90s）再重启，尽量不打断玩家。
# 主仓 CI 不涉及杭州——core 的 server.mjs 有改动后手动跑本脚本。
#
# 用法：scripts/authority-hz-release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HZ_HOST="root@rank-hz.saolei.wang"
HZ_KEY="$HOME/.ssh/shenjia.pem"
HZ_TOKEN="$(grep -E '^AUTHORITY_HZ_TOKEN=' "$ROOT/.env" | cut -d= -f2-)"
SERVER="$ROOT/src/core/scripts/authority/server.mjs"

[[ -f "$SERVER" ]] || { echo "找不到 $SERVER"; exit 1; }
[[ -n "${HZ_TOKEN:-}" ]] || { echo ".env 缺 AUTHORITY_HZ_TOKEN"; exit 1; }

echo "[hz] 上传 server.mjs → $HZ_HOST:/opt/saolei-authority/"
scp -i "$HZ_KEY" -q "$SERVER" "$HZ_HOST:/opt/saolei-authority/server.mjs.new"

echo "[hz] drain（拒新局，等存量局打完，最多 90s）"
ssh -i "$HZ_KEY" "$HZ_HOST" "curl -s -X POST -H 'Authorization: Bearer $HZ_TOKEN' http://127.0.0.1:3104/drain -d '{\"on\":true}' >/dev/null"
for i in $(seq 1 30); do
  ACTIVE=$(ssh -i "$HZ_KEY" "$HZ_HOST" "curl -s http://127.0.0.1:3104/health" | grep -oE '"active":[0-9]+' | cut -d: -f2)
  [[ "$ACTIVE" == "0" ]] && break
  echo "[hz] 等待存量局打完… active=$ACTIVE"
  sleep 3
done

echo "[hz] 切换新版本并重启"
ssh -i "$HZ_KEY" "$HZ_HOST" "mv /opt/saolei-authority/server.mjs.new /opt/saolei-authority/server.mjs && systemctl restart saolei-authority && sleep 1"

HEALTH=$(ssh -i "$HZ_KEY" "$HZ_HOST" "curl -s http://127.0.0.1:3104/health")
echo "[hz] health: $HEALTH"
[[ "$HEALTH" == *'"region":"hz"'* ]] || { echo "[hz] ❌ health 校验失败"; exit 1; }

# 公网面最终验证（经 Caddy，鉴权应 401 拒绝无凭据请求）
CODE=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "https://rank-hz.saolei.wang/finalize")
[[ "$CODE" == "401" ]] || { echo "[hz] ❌ 公网鉴权异常（finalize=$CODE，应为 401）"; exit 1; }
echo "[hz] ✅ 发布完成（region=hz，公网鉴权正常）"
