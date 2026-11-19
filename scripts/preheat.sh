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
# 2026-11-03 起 cron 常态预热（scripts/preheat-cron.sh）以 PREHEAT_SLIM=1 调本脚本：
#   slim 模式剔除清单末尾两个**无缓存**的实时重页（/area 实时窗口函数、/team 逐管理员
#   全表 count）——它们没有缓存可保温，每分钟打一次纯烧 DB；仅发布预热（全量）时跑。
# ── 到期感知调度（2026-11-06 张老师定：距到期还有 5 分钟才刷，没到不刷）────────
# 清单不剔除：每条以「path|TTL」登记——TTL=该页链路**最短重缓存键**的 revalidate 秒数
# （逐键核实于 2026-11-06，来源见行尾注释；改缓存时长必须同步改这里）。
# · PREHEAT_STATE_FILE 存在时启用到期感知：按「上次完成重建时刻」记账，距
#   (上次 + TTL) 不足 PREHEAT_REFRESH_WINDOW（默认 300s）才打该路径——长缓存页
#   平时跳过，仅在到期前 5 分钟窗口内由每分钟 cron 完成重建，其余时间零 DB 成本。
# · 状态文件按槽位端口分片（preheat-cron.sh 传入）：蓝绿切槽后新槽无状态 ⇒ 首轮全量
#   （等价发布预热），且不会误用旧槽的记账时刻。
# · 完成一轮的判定：命中且响应耗时 ≥ TTL（说明真实发生了到期重建——unstable_cache
#   新鲜命中不重置 TTL，秒回=没重建）⇒ 记账时刻前移为本次，进入下一个周期；秒回则
#   记账不动，保持「到期后第一击由 cron 承担」——访客至多撞 ≤60s 过期窗，与原方案一致。
# · 无记账（新槽/新路径）＝冷启动：curl 成功即锚定该时刻，之后按 TTL 周期轮转
#   （避免「记 0 恒进窗」导致冷启动后每分钟空打到首次真实重建为止）。
# · 短 TTL 页（60s/300s 档）窗口恒成立，行为与原每分钟保温完全相同。
# · 发布预热（server-release.sh 全量路径）不设状态文件，行为不变。
PREHEAT_PATHS_TTL=(
  "/ranking?view=bv|3600"        # fetchBvCollection（bv-collection，1h；d1318f2 后顶层调用缓存生效）
  "/ranking?view=bv&nf=1|3600"   # NF BV：独立缓存键（同上，参数区分）
  "/ranking?view=stnb|60"        # stnb-table-v2 落盘表（60s）
  "/ranking?view=stnb&nf=1|60"   # NF STNB：同上（参数区分）
  "/|300"                        # 首页链路 9 键统一 REVALIDATE_HOME_CACHE=300（config.ts；含发现流去重键）
  "/api/video/more?feedPage=1&base=18&size=18&level=beg|300"  # feed-dedup-v3 系（REVALIDATE_HOME_CACHE）
  "/api/video/more?feedPage=1&base=18&size=18&level=int|300"
  "/api/video/more?feedPage=1&base=18&size=18&level=exp|300"
  "/api/video/more?feedPage=1&base=18&size=18&nf=1|300"
  "/video|300"                   # video-list-join-count v12（REVALIDATE_HOME_CACHE，2026-11-03 起 300s）
  "/video?order=stnb|300"        # 同上（排序参数区分键，行查询 <0.5s 顺手）
  "/ranking|60"                  # 主榜读取无 unstable_cache（rank_snapshot 快查），保守 60s 档
  "/area|0"                      # 无缓存实时页【slim 剔除；0=强制不跳过】
  "/ranking?view=world|86400"    # world-top100-v5（1 天）
  "/grow|60"                     # rank_snapshot 快查无缓存（借 /ranking 同源焐热），保守 60s 档
  "/ranking?nf=1|60"             # 主榜 NF：user_scores_nf 同构读取
  "/titles|60"                   # title-counts-v5（60s）
  "/records|300"                 # records-tops-v7（300s）+ bv-top-v1（1h）+ curves（24h）——最短键 300s
  "/bbs|60"                      # 论坛列表索引 count/分页：无 unstable_cache，查询轻，60s 保守档
  "/team|0"                      # 无缓存实时页【slim 剔除；0=强制不跳过】
)
# 到期感知参数与状态读入（PREHEAT_STATE_FILE 空=禁用，发布预热路径不受影响）
PREHEAT_STATE_FILE="${PREHEAT_STATE_FILE:-}"
PREHEAT_REFRESH_WINDOW="${PREHEAT_REFRESH_WINDOW:-300}"
declare -A lastHit=()
if [[ -n "$PREHEAT_STATE_FILE" && -f "$PREHEAT_STATE_FILE" ]]; then
  while IFS=$'\t' read -r p t; do
    [[ -n "$p" && -n "$t" ]] && lastHit["$p"]="$t"
  done < "$PREHEAT_STATE_FILE"
fi

# slim 模式：剔除无缓存的实时重页（见上 2026-11-03 注）——在 TTL 表上按 path 部分过滤
if [[ "${PREHEAT_SLIM:-0}" == "1" ]]; then
  SLIM_SKIP=("/area" "/team")
  FILTERED=()
  for entry in "${PREHEAT_PATHS_TTL[@]}"; do
    p="${entry%%|*}"
    skip=0
    for s in "${SLIM_SKIP[@]}"; do [[ "$p" == "$s" ]] && skip=1; done
    (( skip == 0 )) && FILTERED+=("$entry")
  done
  PREHEAT_PATHS_TTL=("${FILTERED[@]}")
fi
PREHEAT_PATHS=("${PREHEAT_PATHS_TTL[@]%%|*}")

printf "${BLUE}[PREHEAT]${NC} 预热备槽 ${PREHEAT_HOST}:%s（%s 个一级页面，串行，失败不阻断发布）\n" \
  "$PORT" "${#PREHEAT_PATHS[@]}"

ok_count=0
fail_count=0
skip_count=0
start_all=$SECONDS
NOW=$(date +%s)
declare -A newState=()   # 本轮结束后的记账（未跳过的路径保留旧值或写入新值）

for entry in "${PREHEAT_PATHS_TTL[@]}"; do
  path="${entry%%|*}"
  ttl="${entry##*|}"

  # 到期感知：距预估到期不足窗口秒数才刷；ttl=0 或未记账（新槽/新路径）恒刷
  last="${lastHit[$path]:-0}"
  if [[ -n "$PREHEAT_STATE_FILE" && "$ttl" != "0" ]]; then
    if (( last > 0 && NOW < last + ttl - PREHEAT_REFRESH_WINDOW )); then
      newState["$path"]="$last"
      skip_count=$((skip_count + 1))
      continue
    fi
  fi

  t0=$SECONDS
  t0e=$(date +%s)   # epoch 记账基准（SECONDS 是脚本内相对秒，不能当锚点）
  rc=0
  curl -sf --noproxy '*' --max-time "$PAGE_TIMEOUT" -o /dev/null "http://${PREHEAT_HOST}:${PORT}${path}" || rc=$?
  dt=$((SECONDS - t0))
  if (( rc == 0 )); then
    printf "  ${GREEN}✓${NC} %-22s %ss\n" "$path" "$dt"
    ok_count=$((ok_count + 1))
    # 记账规则：响应耗时 ≥ TTL ⇒ 真实发生了到期重建（unstable_cache 秒回不重置
    # TTL），本轮完成、锚点前移；秒回（仍在窗口内重试）记账不动，下分钟再来。
    # 无记账（新槽/新路径）＝冷启动场景，curl 成功即说明重建完成（或已热），直接锚定。
    if [[ -n "$PREHEAT_STATE_FILE" ]]; then
      if [[ "$ttl" == "0" ]]; then
        # 无缓存页：不打周期锚点（无 TTL 可轮转），仅回写旧值保住行
        newState["$path"]="${lastHit[$path]:-0}"
      elif (( last == 0 )); then
        newState["$path"]="$(( t0e ))"
      elif (( dt >= ttl )); then
        newState["$path"]="$(( t0e ))"
      else
        newState["$path"]="$last"
      fi
    fi
  else
    printf "  ${YELLOW}✗${NC} %-22s rc=%s %ss （已跳过，不阻断发布）\n" "$path" "$rc" "$dt"
    fail_count=$((fail_count + 1))
    # 失败保留旧记账（若有），让重试继续留在窗口内
    [[ -n "$PREHEAT_STATE_FILE" && -n "${lastHit[$path]:-}" ]] && newState["$path"]="${lastHit[$path]}"
  fi
done

# 状态落盘（原子写：先临时文件再 mv；目录不存在则建）
if [[ -n "$PREHEAT_STATE_FILE" ]]; then
  mkdir -p "$(dirname "$PREHEAT_STATE_FILE")"
  tmp="${PREHEAT_STATE_FILE}.tmp.$$"
  # 上次写入的路径本轮未出现在清单（路径下线）→ 丢弃；全部路径以本轮清单为准
  for p in "${!newState[@]}"; do printf '%s\t%s\n' "$p" "${newState[$p]}"; done | sort > "$tmp"
  mv -f "$tmp" "$PREHEAT_STATE_FILE"
fi

total_dt=$((SECONDS - start_all))
if (( fail_count > 0 )); then
  printf "${YELLOW}[PREHEAT]${NC} 预热完成：成功 %s / 跳过 %s / 失败 %s，共 %ss（失败的页面切流后由访客首访承担，功能不受影响）\n" \
    "$ok_count" "$skip_count" "$fail_count" "$total_dt"
else
  printf "${GREEN}[PREHEAT]${NC} 预热全部成功：%s 个页面（跳过 %s 个未到期），共 %ss\n" \
    "$ok_count" "$skip_count" "$total_dt"
fi

exit 0
