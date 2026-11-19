#!/usr/bin/env bash
# 一次性 root 配置（在 01xue 服务器上以 root 执行）：
#   sudo bash /home/deploy/root-setup-saolei.sh
#
# 做三件事：
#   1. 软链 saolei 主站 conf 与 upstream conf 进 /etc/nginx/conf.d/
#      （deploy 用户 sudoers 只放行 nginx -t / nginx -s reload，写不了 conf.d）
#   2. 创建 saolei 蓝绿槽的 nginx 日志目录（属主 deploy，可读）
#   3. reload nginx
set -euo pipefail

for CONF_TARGET in \
  "/etc/nginx/conf.d/saolei.conf:/home/deploy/nginx-conf/saolei.conf" \
  "/etc/nginx/conf.d/saolei-upstream.conf:/home/deploy/nginx-upstream/saolei-upstream.conf"; do
  CONF="${CONF_TARGET%%:*}"
  TARGET="${CONF_TARGET##*:}"
  if [ -L "$CONF" ]; then
    echo "[skip] 已是软链: $CONF -> $(readlink "$CONF")"
  else
    ln -s "$TARGET" "$CONF"
    echo "[ok] $CONF -> $TARGET"
  fi
done

mkdir -p /home/deploy/nginx-logs
chown deploy:deploy /home/deploy/nginx-logs

/usr/sbin/nginx -t
/usr/sbin/nginx -s reload
echo "[done] saolei nginx 配置生效"
