#!/usr/bin/env bash
#
# server-deploy.sh — 服务器端部署脚本（由 GitHub Actions 通过 SSH 调用）
#
# 蓝绿零停机部署:
#   pnpm install → prisma generate
#   → build 到备槽(.next-green/.next-blue) → 重启备槽 pm2 → 健康检查
#   → 切换 nginx upstream 主备(sudo nginx -s reload, 平滑) → 终检(失败自动回滚)
#
# 槽位固定: blue=saolei@3100(.next-blue)  green=saolei-green@3102(.next-green)
# upstream 配置: ~/nginx-upstream/saolei-upstream.conf
#   （/etc/nginx/conf.d/saolei-upstream.conf 是指向它的软链，root 一次性配置）
# 原则: 任何一步失败立即退出，不半成品上线；构建失败不影响线上正在运行的旧版本
#
# 与 01xue 版差异：
#   - saolei 用 prisma db push 语义（无 migrations 目录），跳过 migrate deploy
#   - 同机还跑着 01xue 双槽，nice/ionice 降载尤其重要
set -euo pipefail

# ---------- 配置 ----------
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"

NGINX_BIN="/usr/sbin/nginx"
NGINX_UPSTREAM_CONF="$HOME/nginx-upstream/saolei-upstream.conf"
HEALTH_PATH="/api/health"
HEALTH_TIMEOUT=90

# SSH 非交互环境无 TTY：pnpm 需要清空 node_modules 重装时会因无法交互确认而中止
# （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），置 CI=true 让其自动执行
export CI=true

# ---------- 颜色输出 ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[DEPLOY]${NC} $1"; }
ok()    { echo -e "${GREEN}[DEPLOY]${NC} $1"; }
warn()  { echo -e "${YELLOW}[DEPLOY]${NC} $1"; }
fail()  { echo -e "${RED}[DEPLOY]${NC} $1"; exit 1; }

# ---------- 槽位定义 ----------
slot_app()   { [[ $1 == blue ]] && echo saolei || echo saolei-green; }
slot_port()  { [[ $1 == blue ]] && echo 3100 || echo 3102; }
slot_dir()   { [[ $1 == blue ]] && echo .next-blue || echo .next-green; }

# ---------- 前置检查 ----------
[[ -f .env ]] || fail "缺少 .env 文件（服务器上应已配置好，rsync 已排除不覆盖）"
command -v pnpm >/dev/null 2>&1 || fail "pnpm 未安装"
[[ -f "$NGINX_UPSTREAM_CONF" ]] || fail "缺少 $NGINX_UPSTREAM_CONF（nginx upstream 配置）"
sudo -n "$NGINX_BIN" -t >/dev/null 2>&1 || fail "deploy 用户无 sudo nginx 权限（需 root 配 sudoers）"

info "部署目录: $DEPLOY_DIR"
info "Node $(node -v) / pnpm $(pnpm -v)"

# ---------- 读取当前主力槽 ----------
read_active() { grep -oE 'active: (blue|green)' "$NGINX_UPSTREAM_CONF" | head -1 | awk '{print $2}'; }
ACTIVE="$(read_active)"
[[ "$ACTIVE" == blue || "$ACTIVE" == green ]] || ACTIVE=blue
if [[ "$ACTIVE" == blue ]]; then STANDBY=green; else STANDBY=blue; fi
S_APP="$(slot_app "$STANDBY")"; S_PORT="$(slot_port "$STANDBY")"; S_DIR="$(slot_dir "$STANDBY")"

info "当前主力: $ACTIVE  → 本次部署备槽: $STANDBY (app=$S_APP port=$S_PORT dir=$S_DIR)"

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
# 此文件由 scripts/server-deploy.sh 自动管理，勿手动修改
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

# ---------- 依赖安装 ----------
# nice/ionice 降为最低调度优先级：同机还跑着 01xue，install/build 打满 CPU 会
# 饿死 nginx TLS 握手（01xue 2026-08-30 实测 525 事故）
info "安装依赖 (pnpm install --frozen-lockfile)..."
nice -n 19 ionice -c3 pnpm install --frozen-lockfile

# ---------- 生成 Prisma Client ----------
info "生成 Prisma Client..."
pnpm exec prisma generate

# ---------- 同步数据库 schema ----------
# 约定：schema.prisma 的加法改动（加列/加表/加索引）随部署自动应用。
#   教训（2026-09-25）：并行会话给 bbs_post 加 is_pinned 列并上线代码，生产库没列 →
#   首页/BBS 全站 500（P2022）。db push 是防线。
# 破坏性改动（删列/删表/缩类型）会让 db push 要求 --accept-data-loss 而报错退出 →
#   部署中止，属预期保护：必须人工确认后手动执行，不允许部署链路静默删数据。
#   注意：库里有 schema 外的表（备份表等）也会触发同样中止——先归档移出。
info "同步数据库 schema (prisma db push)..."
pnpm exec prisma db push --skip-generate

# ---------- 构建到备槽（主力不受影响，无 502 窗口） ----------
info "构建生产版本到备槽 ${S_DIR}（主力 $ACTIVE 继续服务）..."
# 清理全部槽位的 Next 生成类型缓存（01xue 踩过：路由删除后旧 types 误报编译错误）
rm -rf .next/types .next/dev/types .next-blue/types .next-green/types
# nice/ionice 让路给 nginx/Next，避免部署窗口 CPU 争抢
NEXT_DIST_DIR="$S_DIR" nice -n 19 ionice -c3 pnpm build

# ---------- 重启备槽实例 ----------
if pm2 describe "$S_APP" >/dev/null 2>&1; then
  info "重启 $S_APP ..."
  pm2 restart "$S_APP"
else
  info "首次启动 $S_APP ..."
  pm2 start "$DEPLOY_DIR/ecosystem.config.js" --only "$S_APP"
fi

# ---------- 备槽健康检查 ----------
wait_healthy "$S_PORT" "$STANDBY 槽"

# ---------- 切换 nginx 主备（平滑 reload，不断连接） ----------
info "切换 nginx 主力: $ACTIVE → $STANDBY ..."
write_upstream "$STANDBY"
sudo -n "$NGINX_BIN" -t || fail "nginx 配置校验失败，未 reload（线上仍由 $ACTIVE 服务）"
sudo -n "$NGINX_BIN" -s reload
sleep 1

# ---------- 终检（本机直连新主力；失败自动回滚） ----------
# 双协议探测：证书就位前只有 80（HTTP），证书就位后 443（HTTPS）——任一通即过。
# 正式切 https 后可只留 443 探测。
final_check() {
  curl -sf --max-time 10 --resolve "new.saolei.wang:443:127.0.0.1" "https://new.saolei.wang$HEALTH_PATH" >/dev/null 2>&1 && return 0
  curl -sf --max-time 10 --resolve "new.saolei.wang:80:127.0.0.1" "http://new.saolei.wang$HEALTH_PATH" >/dev/null 2>&1 && return 0
  return 1
}
if final_check; then
  ok "经 nginx 终检通过 ✓  新主力: $STANDBY"
else
  warn "终检失败！自动回滚到 $ACTIVE ..."
  write_upstream "$ACTIVE"
  sudo -n "$NGINX_BIN" -t && sudo -n "$NGINX_BIN" -s reload
  fail "已回滚。请查: pm2 logs $S_APP --lines 50 / pm2 ls"
fi

pm2 save
ok "部署完成 ✓  $(date '+%Y-%m-%d %H:%M:%S')  (active=$STANDBY, standby=$ACTIVE 下次部署再更新)"
