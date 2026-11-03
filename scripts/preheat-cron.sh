#!/usr/bin/env bash
#
# preheat-cron.sh — 一级页面常态预热（crontab 每分钟调用，2026-11-03 上线）
#
# ── 为什么需要（张老师报告「点首页经常卡几秒」）────────────────────────────
# 发布期预热（preheat.sh 由 server-release.sh 调用）只在切流前跑一次；平时
# unstable_cache 条目（首页链路原 60s 档）一过期，撞上的第一个访客就要同步
# 承担重建（实测首页 2.5s vs 热缓存 0.6s）。本脚本每分钟对**当前活跃槽**跑一遍
# slim 预热清单（间隔 < 最短 revalidate），让缓存条目永不过期——
# 重建成本全部由预热请求承担，访客永远命中热缓存。
# 配套代码改动：首页链路缓存统一 300s（queries.ts / title-system.ts），
# 首页新闻/新兵两条裸查流也挂了缓存。
#
# ── 设计要点 ─────────────────────────────────────────────────────────────
# · 活跃槽从 ~/nginx-upstream/saolei-upstream.conf 解析（server-release.sh 自动
#   管理，非 backup 的 server 行即活跃端口）——蓝绿切槽后 cron 自动跟随，无需改配置。
# · PREHEAT_SLIM=1 剔除 /area /team 两个无缓存实时重页（见 preheat.sh 注）。
# · 全部成功时静默（每分钟一条成功日志会滚爆磁盘），有失败才落日志便于排查。
# · 直连 pm2 端口，不过 nginx：不占限速配额、不进访问日志、不被 UA 黑名单拦。
# · 打的是当前活跃槽＝访客同款缓存；请求无登录态（游客路径与登录态共享全部
#   数据缓存），仪表盘 PV/UV 口径会将其作为零行为访客剔除，不污染统计。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$HOME/nginx-upstream/saolei-upstream.conf"

[[ -f "$CONF" ]] || exit 0
PORT=$(grep -E 'server 127\.0\.0\.1:[0-9]+' "$CONF" | grep -v backup | head -1 | sed -E 's/.*127\.0\.0\.1:([0-9]+).*/\1/')
[[ "$PORT" =~ ^[0-9]+$ ]] || exit 0

OUT=$(PREHEAT_SLIM=1 bash "$SCRIPT_DIR/preheat.sh" "$PORT" 2>&1)

if ! grep -q "预热全部成功" <<<"$OUT"; then
  echo "[$(date '+%F %T')] PORT=$PORT 预热存在失败项："
  echo "$OUT"
  echo "----"
fi
