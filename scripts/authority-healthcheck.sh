#!/usr/bin/env bash
# authority 心跳监控（2026-10-27 张老师要求：线上心跳监控+重启方案）。
# 部署：服务器 crontab 每分钟执行（deploy 用户）：
#   * * * * * /home/deploy/saolei.wang/scripts/authority-healthcheck.sh >> /tmp/authority-healthcheck.log 2>&1
#
# 三层防线（pm2 max_restarts 管崩溃重启；本脚本管三种 pm2 覆盖不到的情况）：
# 1. 进程不在（pm2 停了/被人删了）→ pm2 start 拉起
# 2. 进程在但 /health 不可达（死锁/端口异常）→ pm2 restart 强制拉起
# 3. 磁盘满等环境异常 → 日志留痕供告警（/health 5xx 持续时 next 在 nginx 侧
#    的 /api/health 也会因 WS 升级失败暴露——玩家侧排名局无法开局是最终信号）
#
# 注意：排名局是内存态，restart 会作废进行中的对局——所以只在「确死」时动手，
# 每分钟一探，死透（连续 2 次）才拉，避免抖动误杀。

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_URL="http://127.0.0.1:3104/health"
FAIL_FLAG="/tmp/authority-healthcheck.failing"
LOG_PREFIX="[$(date '+%F %T')]"

# 第一层：进程在不在
if ! pm2 describe saolei-authority >/dev/null 2>&1; then
  echo "$LOG_PREFIX 进程不存在，pm2 start 拉起"
  pm2 start "$DEPLOY_DIR/ecosystem.config.js" --only saolei-authority
  pm2 save
  exit 0
fi

# 第二/三层：健康探测（连续 2 次失败才重启——防瞬时抖动作废进行中的对局）
if curl -sf --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  rm -f "$FAIL_FLAG"
  exit 0
fi

if [[ -f "$FAIL_FLAG" ]]; then
  echo "$LOG_PREFIX /health 连续 2 次不可达，pm2 restart 强制拉起"
  pm2 restart saolei-authority
  rm -f "$FAIL_FLAG"
else
  echo "$LOG_PREFIX /health 不可达（第 1 次），下轮复查"
  touch "$FAIL_FLAG"
fi
