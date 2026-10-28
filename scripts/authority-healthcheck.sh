#!/usr/bin/env bash
# cron 环境 PATH 极简（2026-10-28 实证：无 /usr/local/bin 时 pm2 找不到，
# 脚本误判「进程不存在」且拉起失败，每分钟刷错误日志）——顶层钉死 PATH
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# authority 心跳监控（2026-10-27 张老师要求：线上心跳监控+重启方案）。
# 部署：服务器 crontab 每分钟执行（deploy 用户）：
#   * * * * * /home/deploy/saolei.wang/scripts/authority-healthcheck.sh >> /tmp/authority-healthcheck.log 2>&1
#
# 2026-10-27 双实例热备改造：a(3104) / b(3105) 两槽都守护——
#   active 槽死了玩家直接不能开局；standby 槽死了发布切换就没兜底，同样要拉。
#   standby 上正常情况下没有对局，重启它零损失；老槽转 standby 期间若还有存量局
#   又恰好死透，重启是唯一选择（对局已随进程消失，早恢复早接客）。
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
LOG_PREFIX="[$(date '+%F %T')]"

# 旧单实例清理（2026-10-27 过渡：a/b 双槽取代 saolei-authority）
if pm2 describe saolei-authority >/dev/null 2>&1; then
  echo "$LOG_PREFIX 发现旧单实例 saolei-authority，已由双槽取代 → pm2 delete"
  pm2 delete saolei-authority >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

check_slot() {
  local slot=$1 app=$2 port=$3
  local flag="/tmp/authority-healthcheck.failing-$slot"
  if ! pm2 describe "$app" >/dev/null 2>&1; then
    echo "$LOG_PREFIX [$slot] 进程不存在，pm2 start 拉起"
    pm2 start "$DEPLOY_DIR/ecosystem.config.js" --only "$app"
    pm2 save >/dev/null 2>&1 || true
    rm -f "$flag"
    return
  fi
  if curl -sf --max-time 5 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    rm -f "$flag"
    return
  fi
  if [[ -f "$flag" ]]; then
    echo "$LOG_PREFIX [$slot] /health 连续 2 次不可达，pm2 restart 强制拉起"
    pm2 restart "$app"
    rm -f "$flag"
  else
    echo "$LOG_PREFIX [$slot] /health 不可达（第 1 次），下轮复查"
    touch "$flag"
  fi
}

check_slot a saolei-authority-a 3104
check_slot b saolei-authority-b 3105
