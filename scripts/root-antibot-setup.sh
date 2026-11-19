#!/usr/bin/env bash
# root-antibot-setup.sh — 反爬配置 root 一次性安装（2026-10-21）
# 在生产机以 root 执行：sudo bash /home/deploy/root-antibot-setup.sh
#
# 做三件事：
#   1. 修 ~/nginx-conf 目录属主为 deploy（该目录 09-27 被 root 建成 root:root，
#      与 saolei.conf 文件本身的 deploy 属主不一致，导致 deploy 无法自助更新配置）
#   2. 软链反爬配置进 /etc/nginx/conf.d/00-saolei-antibot.conf
#      （00 前缀保证 map/limit_req_zone 在站点 conf 之前加载）
#   3. nginx -t 校验 + reload
set -euo pipefail

CONF="/etc/nginx/conf.d/00-saolei-antibot.conf"
TARGET="/home/deploy/nginx-conf/00-saolei-antibot.conf"

# 1. 目录属主修正
if [ "$(stat -c '%U' /home/deploy/nginx-conf)" != "deploy" ]; then
  chown deploy:deploy /home/deploy/nginx-conf
  echo "[ok] /home/deploy/nginx-conf 属主修正为 deploy"
else
  echo "[skip] nginx-conf 属主已是 deploy"
fi

# 2. 软链（幂等）
if [ -L "$CONF" ]; then
  echo "[skip] 已是软链: $CONF -> $(readlink "$CONF")"
else
  ln -s "$TARGET" "$CONF"
  echo "[ok] $CONF -> $TARGET"
fi

# 3. 校验 + 生效
/usr/sbin/nginx -t
/usr/sbin/nginx -s reload
echo "[done] 反爬配置已生效（UA 黑名单 + 三档限速）"
