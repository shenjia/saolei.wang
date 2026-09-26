#!/usr/bin/env bash
#
# setup-https-saolei.sh — saolei HTTPS 一次性配置（root 执行）
#
# 用法: sudo bash /home/deploy/setup-https-saolei.sh
#
# 动作:
#   1. acme.sh http-01 签发 new.saolei.wang（webroot=/home/deploy/acme-www，
#      与 nginx conf 的 /.well-known/acme-challenge/ location 对应；已签发则等价于续期检查）
#   2. install-cert 到 /etc/nginx/ssl/saolei/（与 acme 目录解耦，续期后自动 reload nginx）
#   3. 重写 ~/nginx-conf/saolei.conf：80 留 acme 验证 + 301 到 https；新增 443 server 块
#   4. nginx -t && nginx -s reload
#
# 正式切换 www.saolei.wang 时：DNS 改指本机后重跑本脚本变体（加 -d www.saolei.wang -d saolei.wang
# 重新签发并改 server_name），或用 DNS-01（aliyun API token）提前签好双域名证书。
set -euo pipefail

ACME="/root/.acme.sh/acme.sh"
DOMAIN="new.saolei.wang"
WEBROOT="/home/deploy/acme-www"
CONF="/home/deploy/nginx-conf/saolei.conf"
CERT_DIR="/etc/nginx/ssl/saolei"

[[ -x "$ACME" ]] || { echo "[fail] acme.sh 不存在: $ACME"; exit 1; }
[[ -f "$CONF" ]] || { echo "[fail] nginx conf 不存在: $CONF"; exit 1; }

# nginx worker 以 user nginx 运行，须能穿越 /home/deploy 才能读到 webroot 验证文件；
# deploy home 默认 700 → acme http-01 验证全 403（2026-09-26 实测踩坑）。
# o+x 仅允许穿越目录、不开放列目录/读内容，幂等无害
chmod o+x /home/deploy

echo "[1/3] acme.sh 签发 $DOMAIN（http-01, webroot=$WEBROOT, CA=Let's Encrypt）..."
# --server letsencrypt：复用 01xue 证书同款 LE 账户（account.conf 已注册），
# 避开 acme.sh 3.x 默认 ZeroSSL 需要额外注册的不确定性
"$ACME" --issue -d "$DOMAIN" -w "$WEBROOT" --server letsencrypt 2>&1 | tail -4

echo "[2/3] 安装证书到 $CERT_DIR 并挂续期 reload..."
mkdir -p "$CERT_DIR"
"$ACME" --install-cert -d "$DOMAIN" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --key-file "$CERT_DIR/key.pem" \
  --reloadcmd "nginx -s reload" >/dev/null
chmod 644 "$CERT_DIR/fullchain.pem"
chmod 600 "$CERT_DIR/key.pem"

echo "[3/3] 重写 nginx conf（80 跳转 + 443）并 reload..."
cp "$CONF" "$CONF.pre-https.bak"
cat > "$CONF" <<'NGINXEOF'
# new.saolei.wang — 新版扫雷网（Next.js 蓝绿双槽 @ saolei_upstream）
# 由 scripts/setup-https-saolei.sh 生成（2026-09-25）。手工改动会被脚本覆盖。
# 正式切换 www.saolei.wang 时：DNS 切换 + 本脚本加 SAN 重签 + server_name 更新。

log_format spider_saolei '$http_x_forwarded_for - $time_iso8601 "$request" $status $body_bytes_sent '
                  '"$http_referer" rt=$request_time "$http_user_agent"';

server {
    listen 80;
    server_name new.saolei.wang;
    access_log /home/deploy/nginx-logs/saolei.access.log spider_saolei;
    client_max_body_size 30m;

    # acme http-01 验证目录（证书续期也要走这里，不能跟着 301 走）
    location /.well-known/acme-challenge/ {
        root /home/deploy/acme-www;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name new.saolei.wang;
    access_log /home/deploy/nginx-logs/saolei.access.log spider_saolei;
    client_max_body_size 30m;

    ssl_certificate     /etc/nginx/ssl/saolei/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/saolei/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    # 运行时上传（头像）由 nginx 直读磁盘：Next 生产模式 public/ 是构建期快照，
    # 运行期新增文件不经 nginx 读不到（01xue 同款坑）
    location /uploads/ {
        alias /home/deploy/saolei.wang/public/uploads/;
        expires 7d;
        access_log off;
    }

    # 录像实体文件（/videos/** gitignore 不入库，单独 rsync，部署 --delete 不碰）
    location /videos/ {
        alias /home/deploy/saolei.wang/videos/;
        expires 30d;
        access_log off;
    }

    location / {
        proxy_pass http://saolei_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINXEOF

nginx -t
nginx -s reload
echo "[ok] HTTPS 就绪 → https://new.saolei.wang  （80 端口已整体 301 到 https）"
