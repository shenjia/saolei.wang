#!/usr/bin/env bash
#
# preheat.sh — 发布切流前预热一级页面（由 server-release.sh / server-deploy.sh 调用）
#
# 用法: bash scripts/preheat.sh <端口>      例: bash scripts/preheat.sh 3102
#
# ── 为什么需要（2026-10-14 张老师要求）──────────────────────────────────────
# ① CI 产物 rsync 到服务器时排除了 .next/cache（deploy.yml 的 --exclude='cache/'），
#    所以每次发布新槽的 unstable_cache 全是冷的（见 lib/worldtop.ts、lib/queries.ts
#    的 fetchBvCollection）——切流后第一批访客要自己承担「冷缓存重建」。
# ② 重建的重活在 DB 侧：BV 榜是全站最重的查询（30 万行 video⋈video_info 全量聚合，
#    实测约 1s）；生产 Prisma 连接池只有 5 条（DATABASE_URL 未设 connection_limit，
#    默认 CPU×2+1，服务器 2 核），多份并发重建即 P1017 / P2024 打满。
# ③ 所以：切流**之前**、对着**备槽端口**把重页面串行跑一遍，把冷启动成本挪到部署
#    窗口内完成——此时线上仍由旧槽服务，预热对访客零影响；切流时新槽缓存已热。
#
# ── 设计要点 ───────────────────────────────────────────────────────────────
# · 串行不并发：避免预热自身把 5 条连接池占满（那正是要防的事）。
# · 失败只告警不退出：预热是优化手段，不该有能力阻断发布。
# · 走 127.0.0.1:<端口> 直连备槽，不经 nginx（避免回落到旧槽、也不过 TLS）。
# · 清单只放一级页面；动态详情页（/user/[id] 等）与需登录页（/message 等）不预热。
#
set -uo pipefail

PORT="${1:-}"
if [[ -z "$PORT" ]]; then
  echo "用法: bash scripts/preheat.sh <端口>" >&2
  exit 1
fi

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
# 单页超时（秒）：BV 冷缓存聚合约 1s，给足余量；可用 PREHEAT_TIMEOUT 覆盖
PAGE_TIMEOUT="${PREHEAT_TIMEOUT:-30}"
# 目标主机：默认 127.0.0.1（与 wait_healthy 同口径，生产实测可用）；
# 本机 dev 槽只绑 IPv6 通配，本地试跑用 PREHEAT_HOST='[::1]'
PREHEAT_HOST="${PREHEAT_HOST:-127.0.0.1}"

# ── 预热清单（按 DB 压力从高到低，最重的放最前，保证预算不够时先焐热关键页）──
# 每条都注明成本依据，日后路由/查询变化时按注释维护。
PREHEAT_PATHS=(
  "/ranking?view=bv"       # 最重：30 万行 video⋈video_info 全量聚合（1h 缓存）+ level_3bv_range 惰性补种
  "/ranking?view=bv&nf=1"  # NF BV：独立缓存键，避免切流后首击承担第二次全量聚合
  "/ranking?view=stnb"     # STNB 落盘表全量读取（60s 缓存紧凑元组）
  "/ranking?view=stnb&nf=1" # NF STNB：独立落盘表与缓存键
  "/"                   # 首页：6 条并发 + SiteStats 9 条 count（video 两条件全表扫 30 万行）
                        #   └ 2026-10-23 随之焐热录像发现流去重键 page1/all（窗口函数全量排序 ~2.1s/键）
  # 录像发现流去重缓存补键（2026-10-23）：级别 tabs 与 NF 开关的第 1 页——
  # 窗口函数 (用户,级别) 配额 + 纪录盘保位全量排序，冷键 ~2.1s，避免切流后首击承担
  "/api/video/more?feedPage=1&base=18&size=18&level=beg"
  "/api/video/more?feedPage=1&base=18&size=18&level=int"
  "/api/video/more?feedPage=1&base=18&size=18&level=exp"
  "/api/video/more?feedPage=1&base=18&size=18&nf=1"
  "/video"              # 录像列表：video.count 全表 + getVideoBoxStats 两个 groupBy（各扫 30 万行）
  "/video?order=stnb"   # STNB 排序列表页：stnb 索引反扫行查询 + 单表化 count（2026-10-20 进清单；FORCE INDEX 后 <0.5s，预热顺手）
  "/ranking"            # 雷界榜：顺带触发 rank_snapshot 当日惰性快照（全表窗口函数写入，每天一次）
  "/area"               # 地区排行：实时窗口函数大 SQL（user⋈user_scores + 活跃用户全表扫），无缓存
  "/ranking?view=world" # 世界榜：外部抓取 minesweepergame.com（1 天缓存，已加 8s 超时）
  "/grow"               # 进步榜：快照已被上面 /ranking 焐热，这里只是填页面缓存
  "/ranking?nf=1"       # NF 成绩榜：user_scores_nf 同构查询
  "/titles"             # 军衔页：20 条索引 count（各档人数）
  "/records"            # 纪录页（2026-10-28）：九条纪录演变窗口函数曲线 + 八项 TOP1 聚合（10min 缓存）
  "/bbs"                # 论坛首页：索引 count + 分页
  "/team"               # 管理团队：逐管理员 video.count（无 reviewUser 索引，各扫一次 30 万行）
)

printf "${BLUE}[PREHEAT]${NC} 预热备槽 ${PREHEAT_HOST}:%s（%s 个一级页面，串行，失败不阻断发布）\n" \
  "$PORT" "${#PREHEAT_PATHS[@]}"

ok_count=0
fail_count=0
start_all=$SECONDS

for path in "${PREHEAT_PATHS[@]}"; do
  t0=$SECONDS
  rc=0
  curl -sf --max-time "$PAGE_TIMEOUT" -o /dev/null "http://${PREHEAT_HOST}:${PORT}${path}" || rc=$?
  dt=$((SECONDS - t0))
  if (( rc == 0 )); then
    printf "  ${GREEN}✓${NC} %-22s %ss\n" "$path" "$dt"
    ok_count=$((ok_count + 1))
  else
    printf "  ${YELLOW}✗${NC} %-22s rc=%s %ss （已跳过，不阻断发布）\n" "$path" "$rc" "$dt"
    fail_count=$((fail_count + 1))
  fi
done

total_dt=$((SECONDS - start_all))
if (( fail_count > 0 )); then
  printf "${YELLOW}[PREHEAT]${NC} 预热完成：成功 %s / 失败 %s，共 %ss（失败的页面切流后由访客首访承担，功能不受影响）\n" \
    "$ok_count" "$fail_count" "$total_dt"
else
  printf "${GREEN}[PREHEAT]${NC} 预热全部成功：%s 个页面，共 %ss\n" "$ok_count" "$total_dt"
fi

exit 0
