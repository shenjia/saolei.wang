#!/usr/bin/env bash
#
# authority-gz-release.sh — 广州排行节点发布（2026-11-01 多地域）
#
# 从开发机直推 src/core/scripts/authority/server.mjs 到广州 ECS（systemd 托管），
# 含 drain 保护：先拒新局、等存量局打完（最多 90s）再重启，尽量不打断玩家。
# 主仓 CI 不涉及广州——core 的 server.mjs 有改动后手动跑本脚本。
#
# 用法：scripts/authority-gz-release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GZ_HOST="root@rank-gz.saolei.wang"
GZ_KEY="$HOME/.ssh/shenjia.pem"
GZ_TOKEN="$(grep -E '^AUTHORITY_GZ_TOKEN=' "$ROOT/.env" | cut -d= -f2-)"
SERVER="$ROOT/src/core/scripts/authority/server.mjs"

[[ -f "$SERVER" ]] || { echo "找不到 $SERVER"; exit 1; }
[[ -n "${GZ_TOKEN:-}" ]] || { echo ".env 缺 AUTHORITY_GZ_TOKEN"; exit 1; }

echo "[gz] 上传 server.mjs → $GZ_HOST:/opt/saolei-authority/"
scp -i "$GZ_KEY" -q "$SERVER" "$GZ_HOST:/opt/saolei-authority/server.mjs.new"

echo "[gz] drain（拒新局，等存量局打完，最多 90s）"
ssh -i "$GZ_KEY" "$GZ_HOST" "curl -s -X POST -H 'Authorization: Bearer $GZ_TOKEN' http://127.0.0.1:3104/drain -d '{\"on\":true}' >/dev/null"
for i in $(seq 1 30); do
  ACTIVE=$(ssh -i "$GZ_KEY" "$GZ_HOST" "curl -s http://127.0.0.1:3104/health" | grep -oE '"active":[0-9]+' | cut -d: -f2)
  [[ "$ACTIVE" == "0" ]] && break
  echo "[gz] 等待存量局打完… active=$ACTIVE"
  sleep 3
done

echo "[gz] 切换新版本并重启"
ssh -i "$GZ_KEY" "$GZ_HOST" "mv /opt/saolei-authority/server.mjs.new /opt/saolei-authority/server.mjs && systemctl restart saolei-authority && sleep 1"

HEALTH=$(ssh -i "$GZ_KEY" "$GZ_HOST" "curl -s http://127.0.0.1:3104/health")
echo "[gz] health: $HEALTH"
[[ "$HEALTH" == *'"region":"gz"'* ]] || { echo "[gz] ❌ health 校验失败"; exit 1; }

# 公网面最终验证（经 Caddy，鉴权应 401 拒绝无凭据请求）
CODE=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "https://rank-gz.saolei.wang/finalize")
[[ "$CODE" == "401" ]] || { echo "[gz] ❌ 公网鉴权异常（finalize=$CODE，应为 401）"; exit 1; }
echo "[gz] ✅ 发布完成（region=gz，公网鉴权正常）"
