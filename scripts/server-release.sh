#!/usr/bin/env bash
#
# server-release.sh — 服务器端发布脚本（由 GitHub Actions 通过 SSH 调用）
#
# B1 架构（2026-09-27 起）：构建在 GitHub Actions 完成，本脚本只做：
#   pnpm install（生产依赖）→ prisma generate → prisma db push → pm2 重启备槽
#   → 健康检查 → 切 nginx 主备 → 终检（失败自动回滚）
# B2 单活模式（2026-10-22 起）：发布成功后 pm2 stop 旧主力槽（回滚失败路径亦然），
#   常驻只留一个 Next 实例省 ~300MB 内存；回滚 = pm2 start 旧槽 + 切 upstream，秒级。
#
# ⚠️ 本脚本绝不运行 next build（旧机教训：服务器 build 触发 SWC 崩溃 + OOM + 内核 hang）
# ⚠️ CI 只构建一次（标准 .next，Turbopack 二次构建会互删产物），rsync 到 .next-release/；
#    本脚本负责把它复制成本次备槽目录（.next-blue / .next-green）
#
# 槽位固定: blue=saolei@3100(.next-blue)  green=saolei-green@3102(.next-green)
# upstream 配置: ~/nginx-upstream/saolei-upstream.conf
#   （/etc/nginx/conf.d/saolei-upstream.conf 是指向它的软链，root 一次性配置）
set -euo pipefail

# ---------- 配置 ----------
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

NGINX_BIN="/usr/sbin/nginx"
NGINX_UPSTREAM_CONF="$HOME/nginx-upstream/saolei-upstream.conf"
HEALTH_PATH="/api/health"
HEALTH_TIMEOUT=90

export CI=true

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[RELEASE]${NC} $1"; }
ok()    { echo -e "${GREEN}[RELEASE]${NC} $1"; }
warn()  { echo -e "${YELLOW}[RELEASE]${NC} $1"; }
fail()  { echo -e "${RED}[RELEASE]${NC} $1"; exit 1; }

# ---------- 槽位定义 ----------
slot_app()   { [[ $1 == blue ]] && echo saolei || echo saolei-green; }
slot_port()  { [[ $1 == blue ]] && echo 3100 || echo 3102; }
slot_dir()   { [[ $1 == blue ]] && echo .next-blue || echo .next-green; }

# ---------- 前置检查 ----------
[[ -f .env ]] || fail "缺少 .env 文件（服务器上应已配置好，rsync 已排除不覆盖）"
command -v pnpm >/dev/null 2>&1 || fail "pnpm 未安装"
[[ -f "$NGINX_UPSTREAM_CONF" ]] || fail "缺少 $NGINX_UPSTREAM_CONF（nginx upstream 配置）"
[[ -d .next-release/server/app ]] || fail "CI 构建产物缺失（.next-release 无 server/app）——CI 构建或 rsync 步骤未完成?"

# ---------- 读取当前主力槽 ----------
read_active() { grep -oE 'active: (blue|green)' "$NGINX_UPSTREAM_CONF" | head -1 | awk '{print $2}'; }
ACTIVE="$(read_active)"
[[ "$ACTIVE" == blue || "$ACTIVE" == green ]] || ACTIVE=blue
if [[ "$ACTIVE" == blue ]]; then STANDBY=green; else STANDBY=blue; fi
S_APP="$(slot_app "$STANDBY")"; S_PORT="$(slot_port "$STANDBY")"; S_DIR="$(slot_dir "$STANDBY")"
A_APP="$(slot_app "$ACTIVE")"

info "当前主力: $ACTIVE  → 本次发布备槽: $STANDBY (app=$S_APP port=$S_PORT dir=$S_DIR)"

# ---------- 生成 upstream 配置（$1 = 主力色） ----------
write_upstream() {
  local active=$1
  local primary_line backup_line
  if [[ $active == blue ]]; then
    primary_line="server 127.0.0.1:3100;"
    backup_line="server 127.0.0.1:3102 backup;"
  else
    primary_line="server 127.0.0.1:3102;"
    backup_line="server 127.0.0.1:3100 backup;"
  fi
  cat > "$NGINX_UPSTREAM_CONF.tmp" <<EOF
# 此文件由 scripts/server-release.sh 自动管理，勿手动修改
# active: $active
upstream saolei_upstream {
    $primary_line        # $active (active)
    $backup_line         # $([[ $active == blue ]] && echo green || echo blue) (standby)
}
EOF
  cat "$NGINX_UPSTREAM_CONF.tmp" > "$NGINX_UPSTREAM_CONF"   # cp 保 inode（软链不换）
  rm -f "$NGINX_UPSTREAM_CONF.tmp"
}

# ---------- 等待健康检查（$1=端口） ----------
wait_healthy() {
  local port=$1 label=$2
  info "健康检查 http://127.0.0.1:$port$HEALTH_PATH ..."
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  until curl -sf --max-time 5 "http://127.0.0.1:$port$HEALTH_PATH" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      fail "$label 健康检查超时（${HEALTH_TIMEOUT}s）。请检查: pm2 logs $S_APP --lines 50"
    fi
    sleep 2
  done
  ok "$label 健康 ✓"
}

# ---------- 依赖安装（仅生产依赖；nice 降载保险仍保留） ----------
info "安装生产依赖 (pnpm install --frozen-lockfile --prod)..."
nice -n 19 ionice -c3 pnpm install --frozen-lockfile --prod

# ---------- 生成 Prisma Client ----------
info "生成 Prisma Client..."
pnpm exec prisma generate

# ---------- 同步数据库 schema ----------
# 约定：schema.prisma 的加法改动（加列/加表/加索引）随部署自动应用。
# 破坏性改动（删列/删表/缩类型）会让 db push 要求 --accept-data-loss 而报错退出 →
#   部署中止，属预期保护：必须人工确认后手动执行，不允许部署链路静默删数据。
info "同步数据库 schema (prisma db push)..."
pnpm exec prisma db push --skip-generate

# ---------- 生成备槽构建产物 ----------
# CI 的单一 .next 产物复制成本次备槽目录（rm+cp 原子性足够：备槽此刻不在服务，
# 主力槽目录不动；Turbopack 产物无绝对路径依赖，cp 即可用）
info "复制 CI 构建产物 → 备槽 ${S_DIR}..."
rm -rf "$S_DIR"
cp -a .next-release "$S_DIR"
[[ -f "$S_DIR/BUILD_ID" ]] || fail "复制后 $S_DIR/BUILD_ID 缺失（CI 产物不完整）"

# ---------- 修复 @prisma/client stub（rsync 软链实体化坑，2026-09-28） ----------
# 本地 .next/node_modules/@prisma/client-<hash> 是指向 pnpm store 的软链，
# require 链经它解析到 .pnpm/.../node_modules/.prisma/client（prisma generate 产物）。
# rsync -a 会跟随软链把 stub 传成实体目录——实体 stub 里没有 .prisma，
# next start 时 "Cannot find module '.prisma/client/default'" 全站 500。
# 服务器上重新把 stub 换成软链，指向本机 pnpm store 里的真实 client：
fix_prisma_stub() {
  local slot_dir=$1
  local stub_dir="$slot_dir/node_modules/@prisma"
  local real_client
  real_client="$(readlink -f /home/deploy/saolei.wang/node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client)"
  [[ -d "$real_client" ]] || fail "找不到服务器上的 @prisma/client 实体（pnpm install 未完成？）"
  local stub_name
  stub_name="$(ls "$stub_dir" 2>/dev/null | grep -E '^client-' | head -1)"
  [[ -n "$stub_name" ]] || { info "槽位无 prisma stub（纯静态页？跳过）"; return 0; }
  if [[ ! -L "$stub_dir/$stub_name" ]]; then
    rm -rf "$stub_dir/$stub_name"
    ln -s "$real_client" "$stub_dir/$stub_name"
    info "已将 $stub_name stub 换回软链 → $real_client"
  fi
}
fix_prisma_stub "$S_DIR"

# ---------- 启动/更新权威对局服务 ----------
# 独立于 Next 蓝绿槽。对局状态在 authority 进程内存——重启即清空。
# 2026-10-27 排名模式上线后：有进行中对局（active>0，未结束局；games 含已结束
# 未过 30min TTL 的历史局不可作判据）则等待其结束（15 分钟上限，覆盖高级局最长
# 时长；期间 Next 槽已切完、页面正常，对局玩家无感）；无对局或超时才重启
# （超时兜底：极少见的挂机局不能永远阻塞发布）。
AUTH_WAITED=0
if pm2 describe saolei-authority >/dev/null 2>&1; then
  GAMES_DEADLINE=$((SECONDS + 900))
  while :; do
    # ⚠️ 脚本头 set -euo pipefail：旧 authority（无 active 字段）grep 无匹配
    # exit 1 会经命令替换杀掉整个发布——管道尾加 || true 兜底
    GAMES_NOW=$(curl -sf --max-time 3 http://127.0.0.1:3104/health 2>/dev/null | grep -oE '"active":[0-9]+' | grep -oE '[0-9]+' || true)
    [ -z "$GAMES_NOW" ] && GAMES_NOW=0
    if [ "$GAMES_NOW" -eq 0 ] || (( SECONDS >= GAMES_DEADLINE )); then
      [ "$GAMES_NOW" -gt 0 ] && warn "仍有 $GAMES_NOW 局进行中，等待超时（15min）——强制重启，进行中的对局需重开"
      break
    fi
    if (( AUTH_WAITED == 0 )); then info "排名对局进行中（$GAMES_NOW 局），等待结束（最多 15 分钟）..."; AUTH_WAITED=1; fi
    sleep 10
  done
  info "重启 saolei-authority ..."
  pm2 restart saolei-authority
else
  info "首次启动 saolei-authority ..."
  pm2 start "$DEPLOY_DIR/ecosystem.config.js" --only saolei-authority
fi
# 权威对局健康检查（2026-10-27 改循环等待）：pm2 restart 到端口可听有几秒延迟，
# 单发 curl 在发布序列里偶发抢跑（run 4 次 CI 里两次「进程终将 ready 但检查已 fail」）；
# 沿用 wait_healthy 的循环语义但走 /health 独立路径，60s 上限。
AUTH_DEADLINE=$((SECONDS + 60))
until curl -sf --max-time 5 http://127.0.0.1:3104/health >/dev/null 2>&1; do
  if (( SECONDS >= AUTH_DEADLINE )); then
    fail "权威对局服务健康检查超时（60s）。请检查: pm2 logs saolei-authority --lines 50"
  fi
  sleep 2
done
ok "权威对局服务健康 ✓"

# ---------- 重启备槽实例 ----------
# 单活模式（2026-10-22）下备槽处于 stopped 态。⚠️ 2026-10-27 生产事故教训：
# pm2 restart **不重读 ecosystem.config.js 的新 env**（RANKED_MODE_OPEN 加进
# ecosystem 后，老进程 restart 仍是旧 env——排名入口在生产消失 22 分钟）。
# 备槽此刻不在服务（nginx 指向主力槽），delete + start 重建无流量损失，
# 且保证每次发布后两槽都是最新 ecosystem env。
if pm2 describe "$S_APP" >/dev/null 2>&1; then
  info "重建 $S_APP（delete+start，确保加载最新 ecosystem env）..."
  pm2 delete "$S_APP" >/dev/null 2>&1
  pm2 start "$DEPLOY_DIR/ecosystem.config.js" --only "$S_APP"
else
  info "首次启动 $S_APP ..."
  pm2 start "$DEPLOY_DIR/ecosystem.config.js" --only "$S_APP"
fi

# ---------- 备槽健康检查 ----------
wait_healthy "$S_PORT" "$STANDBY 槽"

# ---------- 预热一级页面（切流前，直连备槽端口） ----------
# 新槽的 .next/cache 是冷的（CI 产物 rsync 排除了 cache/），切流后并发首访会各自做冷
# 缓存重建——最重的 BV 全量聚合（30 万行，约 1s）叠并发即打满 5 条 Prisma 连接池（P1017）。
# 这里在切流**之前**串行预热一遍：此时线上仍由旧槽服务，对访客零影响；切流时缓存已热。
# 失败只告警——预热是优化手段，不该有能力阻断发布。清单见 scripts/preheat.sh。
bash "$DEPLOY_DIR/scripts/preheat.sh" "$S_PORT" || warn "预热脚本异常（不阻断发布）"

# ---------- 切换 nginx 主备（平滑 reload，不断连接） ----------
info "切换 nginx 主力: $ACTIVE → $STANDBY ..."
write_upstream "$STANDBY"
sudo -n "$NGINX_BIN" -t || fail "nginx 配置校验失败，未 reload（线上仍由 $ACTIVE 服务）"
sudo -n "$NGINX_BIN" -s reload
sleep 1

# ---------- 终检（本机直连新主力；失败自动回滚） ----------
final_check() {
  # 主域 saolei.wang（2026-10-25 切换；勿用 new.*——它已 301 归一化，探测会打到 301 上，
  # curl -sf 对 301 返回 0 → 永远「通过」，探测不到真实上游）
  curl -sf --max-time 10 --resolve "saolei.wang:443:127.0.0.1" "https://saolei.wang$HEALTH_PATH" >/dev/null 2>&1 && return 0
  curl -sf --max-time 10 --resolve "saolei.wang:80:127.0.0.1" "http://saolei.wang$HEALTH_PATH" >/dev/null 2>&1 && return 0
  return 1
}
if final_check; then
  ok "经 nginx 终检通过 ✓  新主力: $STANDBY"
  # ---------- 单活模式（2026-10-22）：停掉旧主力槽，释放常驻内存 ----------
  # 3.5G 内存机上空闲槽常驻 ~300MB 是颠簸挂机事故的诱因之一（见 .workbuddy/memory/2026-10-22.md）。
  # 回滚 = pm2 start 旧槽 + write_upstream 切回 + reload，秒级。upstream 里的 backup 行保留，
  # 空闲槽停止后 nginx 在主力故障时只是少一层兜底，属单活模式的已知取舍。
  info "单活模式: 停止旧主力槽 $A_APP ..."
  pm2 stop "$A_APP" || warn "pm2 stop $A_APP 失败（不阻断发布，请人工检查 pm2 ls）"
else
  warn "终检失败！自动回滚到 $ACTIVE ..."
  write_upstream "$ACTIVE"
  sudo -n "$NGINX_BIN" -t && sudo -n "$NGINX_BIN" -s reload
  # 回滚同样维持单活：停掉本次刚拉起的新槽
  pm2 stop "$S_APP" || true
  fail "已回滚。请查: pm2 logs $S_APP --lines 50 / pm2 ls"
fi

pm2 save

# ---------- authority 心跳监控 cron 安装（2026-10-27 张老师要求）----------
# 每分钟探测 /health：进程消失→pm2 start；连续 2 次不可达→pm2 restart。
# 幂等安装（grep 防重复行）。
CRON_LINE="* * * * * $DEPLOY_DIR/scripts/authority-healthcheck.sh >> /tmp/authority-healthcheck.log 2>&1"
if ! (crontab -l 2>/dev/null | grep -qF "authority-healthcheck.sh"); then
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  ok "已安装 authority 心跳监控 cron（每分钟）"
fi

ok "发布完成 ✓  $(date '+%Y-%m-%d %H:%M:%S')  (active=$STANDBY, 空闲槽 $A_APP 已停)"
