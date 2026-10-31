#!/usr/bin/env bash
#
# authority-heartbeat.sh — 排名权威集中心跳告警（2026-10-31 张老师需求）
#
# 跑在北京生产机（root systemd timer 每分钟），探全部权威实例：
#   北京 a/b（本机回环 3104/3105）+ 香港/杭州/成都（公网 /health，读生产 .env 的
#   AUTHORITY_HK_URL 等运行时键——节点增删只改 .env，脚本零改动）。
#
# 分工：各节点的「自救」由 authority-watchdog.sh（同 repo scripts/）负责；
# 本脚本负责「发现 + 告警」——连续 FAIL_N 次失败发告警邮件（30 分钟一封防轰炸），
# 恢复发恢复通知。节点自救动作本脚本看不到，只看结果面。
#
# 配置：/etc/saolei-heartbeat.env（600）：
#   ALERT_TO=137516@qq.com     # 告警收件邮箱
# SMTP 凭据读 /home/deploy/saolei.wang/.env 的 SMTP_*（阿里云 DirectMail）。
# 状态：/var/tmp/saolei-heartbeat/；日志：journalctl -t saolei-heartbeat
set -u

ENV_FILE="${1:-/etc/saolei-heartbeat.env}"
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"
APP_ENV=/home/deploy/saolei.wang/.env
[[ -f "$APP_ENV" ]] && . "$APP_ENV"
NODE_BIN=$(command -v node || echo /usr/local/bin/node)
FAIL_N=3
ALERT_INTERVAL=1800   # 同一节点重复告警最小间隔（秒）
STATE_DIR=/var/tmp/saolei-heartbeat
mkdir -p "$STATE_DIR"
now=$(date +%s)

# 探测目标：名称|URL。北京走回环；其余取生产 .env 的 AUTHORITY_<R>_URL
TARGETS=(
  "北京a|http://127.0.0.1:${AUTHORITY_PORT_A:-3104}/health"
  "北京b|http://127.0.0.1:${AUTHORITY_PORT_B:-3105}/health"
)
for r in HK HZ CD; do
  eval "u=\$AUTHORITY_${r}_URL"
  [[ -n "${u:-}" ]] && TARGETS+=("${r,,}|${u%/}/health")
done

send_mail() { # $1=主题 $2=正文
  [[ -n "${ALERT_TO:-}" ]] || { logger -t saolei-heartbeat "未配置 ALERT_TO，跳过邮件: $1"; return 0; }
  "$NODE_BIN" - "$1" "$2" <<'NODEEOF' >/dev/null 2>&1
const nodemailer = require("/home/deploy/saolei.wang/node_modules/nodemailer");
const [subject, text] = process.argv.slice(2);
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 80),
  secure: false, tls: { rejectUnauthorized: false },
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
t.sendMail({ from: process.env.SMTP_FROM, to: process.env.ALERT_TO, subject, text })
  .then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
NODEEOF
}

alerts=()
for t in "${TARGETS[@]}"; do
  name="${t%%|*}"; url="${t#*|}"
  sf="$STATE_DIR/$name.fail"; sa="$STATE_DIR/$name.alertts"
  if curl -fsS -m 8 "$url" 2>/dev/null | grep -q '"ok":true'; then
    prev=$(cat "$sf" 2>/dev/null || echo 0)
    if (( prev >= FAIL_N )); then
      logger -t saolei-heartbeat "[$name] 恢复（此前连续失败 $prev 次）"
      send_mail "[扫雷权威] $name 节点已恢复" "$url 探测恢复正常（北京时间 $(date '+%F %T')），此前连续失败 $prev 次。"
    fi
    echo 0 > "$sf"
  else
    c=$(( $(cat "$sf" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$sf"
    last=$(cat "$sa" 2>/dev/null || echo 0)
    if (( c >= FAIL_N && now - last >= ALERT_INTERVAL )); then
      echo "$now" > "$sa"
      logger -t saolei-heartbeat -p user.err "[$name] 连续 $c 次探测失败，发告警邮件"
      send_mail "[扫雷权威] $name 节点探测失败" "$url 连续 $c 次探测失败（北京时间 $(date '+%F %T')）。节点自救 watchdog（若有部署）应已尝试重启；请检查后台负载面板 https://saolei.wang/admin/practice 与节点 journalctl -t saolei-watchdog。"
      alerts+=("$name:$c")
    else
      logger -t saolei-heartbeat "[$name] 探测失败 $c/$FAIL_N"
    fi
  fi
done

# 汇总一行状态进 journal（巡检方便）
status=""
for t in "${TARGETS[@]}"; do
  name="${t%%|*}"; status+=" $name=$(cat "$STATE_DIR/$name.fail" 2>/dev/null || echo 0)fail"
done
logger -t saolei-heartbeat "心跳巡检:${status}${alerts:+  本轮告警:${alerts[*]}}"
