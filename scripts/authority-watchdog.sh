#!/usr/bin/env bash
#
# authority-watchdog.sh — 权威节点本地心跳自救（2026-10-31 张老师需求）
#
# 部署在每台权威机（北京本部 / hk / hz / cd），systemd timer 每分钟 root 执行：
#   1. 探本机 authority /health；连续 FAIL_N 次失败 → 执行 WATCHDOG_RESTART_CMD
#   2. 本机健康时探公网 URL（过 Caddy）；连续 FAIL_N 次失败 → 执行 WATCHDOG_CADDY_RESTART_CMD
#
# systemd Restart=always 只覆盖进程崩溃，覆盖不到：进程 hang（事件循环卡死、
# 连接泄漏不响应）、Caddy 挂掉/TLS 异常——这两类是本脚本的存在意义。
# 注意：重启会丢内存里进行中的对局，阈值 3 分钟是「节点已死」与「玩家丢局」的权衡。
#
# 配置：/etc/saolei-watchdog/watchdog.env（600），键：
#   WATCHDOG_NAME=hz                                  # 日志标签
#   WATCHDOG_PORT=3104                                # 本机 authority 端口
#   WATCHDOG_PUBLIC_URL=https://rank-hz.saolei.wang   # 可选，公网面探测（配了才查 Caddy）
#   WATCHDOG_RESTART_CMD=systemctl restart saolei-authority      # 北京 pm2 机换成 pm2 restart
#   WATCHDOG_CADDY_RESTART_CMD=systemctl restart caddy
#
# 日志：journalctl -t saolei-watchdog；状态：/var/tmp/saolei-watchdog/
set -u

ENV_FILE="${1:-/etc/saolei-watchdog/watchdog.env}"
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"

NAME="${WATCHDOG_NAME:-$(hostname)}"
PORT="${WATCHDOG_PORT:-3104}"
PUBLIC_URL="${WATCHDOG_PUBLIC_URL:-}"
RESTART_CMD="${WATCHDOG_RESTART_CMD:-systemctl restart saolei-authority}"
CADDY_CMD="${WATCHDOG_CADDY_RESTART_CMD:-systemctl restart caddy}"
FAIL_N=3
COOLDOWN=300   # 两次自救动作最小间隔（秒），防重启风暴
STATE_DIR=/var/tmp/saolei-watchdog
mkdir -p "$STATE_DIR"
now=$(date +%s)

cnt()   { cat "$STATE_DIR/${NAME}.$1" 2>/dev/null || echo 0; }
setc()  { echo "$2" > "$STATE_DIR/${NAME}.$1"; }

# 自救动作：$1=动作名 $2=命令 $3=验证命令
selfheal() {
  local last; last=$(cnt "$1.lastts")
  if (( now - ${last:-0} < COOLDOWN )); then
    logger -t saolei-watchdog "[$NAME] $1 仍在冷却期（${COOLDOWN}s 内已动作过），跳过"
    return 0
  fi
  logger -t saolei-watchdog "[$NAME] $1 连续 $FAIL_N 次探测失败 → 自救: $2"
  setc "$1.lastts" "$now"
  bash -c "$2" >/dev/null 2>&1
  sleep 3
  if bash -c "$3" >/dev/null 2>&1; then
    logger -t saolei-watchdog "[$NAME] $1 自救成功，探测恢复"
    setc "$1.fail" 0
  else
    logger -t saolei-watchdog -p user.err "[$NAME] $1 自救后验证仍失败，等下轮重试"
  fi
}

probe() { # $1=标签 $2=探测命令 $3=自救命令 $4=验证命令
  if bash -c "$2" >/dev/null 2>&1; then
    # 恢复清零（若之前有失败记录则记一条恢复日志）
    if (( $(cnt "$1.fail") > 0 )); then
      logger -t saolei-watchdog "[$NAME] $1 探测恢复（此前连续失败 $(cnt "$1.fail") 次）"
    fi
    setc "$1.fail" 0
  else
    local c; c=$(( $(cnt "$1.fail") + 1 )); setc "$1.fail" "$c"
    if (( c >= FAIL_N )); then
      selfheal "$1" "$3" "$4"
    else
      logger -t saolei-watchdog "[$NAME] $1 探测失败 $c/$FAIL_N"
    fi
  fi
}

# 1) 本机 authority 进程
probe auth \
  "curl -fsS -m 5 http://127.0.0.1:${PORT}/health" \
  "$RESTART_CMD" \
  "curl -fsS -m 5 http://127.0.0.1:${PORT}/health"

# 2) 公网面（本机进程健康才有意义——进程死了先自救进程，Caddy 问题下轮暴露）
if [[ -n "$PUBLIC_URL" ]]; then
  probe pub \
    "curl -fsS -m 8 ${PUBLIC_URL%/}/health" \
    "$CADDY_CMD" \
    "curl -fsS -m 8 ${PUBLIC_URL%/}/health"
fi
