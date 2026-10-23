#!/usr/bin/env bash
#
# setup-https-saolei.sh — saolei HTTPS 配置（root 执行）
#
# 用法: sudo bash /home/deploy/setup-https-saolei.sh
#
# 动作:
#   1. acme.sh http-01 签发三域名 SAN 证书（new / www / 裸域 saolei.wang；
#      webroot=/home/deploy/acme-www，与 nginx conf 的 /.well-known/acme-challenge/
#      location 对应；已签发则等价于续期检查）
#   2. install-cert 到 /etc/nginx/ssl/saolei/（与 acme 目录解耦，续期后自动 reload nginx）
#   3. 重写 ~/nginx-conf/saolei.conf：80 留 acme 验证 + 301 到 https；新增 443 server 块
#      （三个域名同一 server_name 列表，共用上游）
#   4. nginx -t && nginx -s reload
#
# ============ 正式切换 www.saolei.wang 操作手册（2026-10-15） ============
# 前置（张老师在控制台/后台操作，缺一不可）：
#   a. DNS：www.saolei.wang 与 saolei.wang 的 A 记录 → 60.205.137.210
#      （旧站 123.56.177.46 已 502，直接切；TTL 建议提前调短到 600）
#   b. QQ互联控制台：回调域名白名单加 www.saolei.wang（回调路径 /api/auth/qq/callback）
#   c. 微信开放平台「网站应用」：授权回调域改为 www.saolei.wang（/api/auth/wechat/callback）
#   d. SMTP_* 五个环境变量补进 .env（邮箱找回密码）
# 切换顺序：
#   1. 先跑本脚本（DNS 生效后 http-01 才能验证 www/裸域；new 已在服、即时通过）
#   2. 改 /home/deploy/saolei.wang/.env 的 SITE_URL=https://www.saolei.wang
#   3. 蓝绿重启（两槽都要吃到新 env）：pm2 restart saolei saolei-green --update-env
#   4. 核验：https://www.saolei.wang 200、QQ/微信扫码登录走通、找回密码邮件到信、
#      sitemap.xml 域名已是 www、/Online/game.asp 等旧 URL 301 正常
#   5. /page/history 登记一条「正式启用 www.saolei.wang 域名」
# 回滚：DNS 切回 123.56.177.46 即恢复旧域名口径（新站不受影响，new.* 始终可用）
# ========================================================================

set -euo pipefail

ACME="/root/.acme.sh/acme.sh"
DOMAINS=(new.saolei.wang www.saolei.wang saolei.wang)
WEBROOT="/home/deploy/acme-www"
CONF="/home/deploy/nginx-conf/saolei.conf"
CERT_DIR="/etc/nginx/ssl/saolei"

[[ -x "$ACME" ]] || { echo "[fail] acme.sh 不存在: $ACME"; exit 1; }
[[ -f "$CONF" ]] || { echo "[fail] nginx conf 不存在: $CONF"; exit 1; }

# nginx worker 以 user nginx 运行，须能穿越 /home/deploy 才能读到 webroot 验证文件；
# deploy home 默认 700 → acme http-01 验证全 403（2026-09-26 实测踩坑）。
# o+x 仅允许穿越目录、不开放列目录/读内容，幂等无害
chmod o+x /home/deploy

# 预检：三个域名都必须解析到本机公网 IP，否则 http-01 必挂（DNS 没切就先别跑）
echo "[0/3] DNS 预检（须全部指向本机）..."
HOST_IP=$(curl -s --max-time 5 ifconfig.me || true)
for D in "${DOMAINS[@]}"; do
  RESOLVED=$(dig +short "$D" @223.5.5.5 2>/dev/null | grep -E '^[0-9.]+$' | tail -1)
  [[ -n "$RESOLVED" ]] || RESOLVED=$(getent hosts "$D" 2>/dev/null | awk '{print $1}' | tail -1)
  echo "  $D -> ${RESOLVED:-未解析}"
  if [[ -n "$HOST_IP" && "$RESOLVED" != "$HOST_IP" ]]; then
    echo "[fail] $D 未指向本机（$HOST_IP），先完成 DNS 切换再跑本脚本"
    exit 1
  fi
done

echo "[1/3] acme.sh 签发 SAN 证书：${DOMAINS[*]}（http-01, webroot=$WEBROOT, CA=Let's Encrypt）..."
# --server letsencrypt：复用 01xue 证书同款 LE 账户（account.conf 已注册），
# 避开 acme.sh 3.x 默认 ZeroSSL 需要额外注册的不确定性
ISSUE_ARGS=(); for D in "${DOMAINS[@]}"; do ISSUE_ARGS+=(-d "$D"); done
"$ACME" --issue -w "$WEBROOT" --server letsencrypt "${ISSUE_ARGS[@]}" 2>&1 | tail -4

echo "[2/3] 安装证书到 $CERT_DIR 并挂续期 reload..."
mkdir -p "$CERT_DIR"
"$ACME" --install-cert -d "${DOMAINS[0]}" \
  --fullchain-file "$CERT_DIR/fullchain.pem" \
  --key-file "$CERT_DIR/key.pem" \
  --reloadcmd "nginx -s reload" >/dev/null
chmod 644 "$CERT_DIR/fullchain.pem"
chmod 600 "$CERT_DIR/key.pem"

echo "[3/3] 重写 nginx conf（80 跳转 + 443）并 reload..."
cp "$CONF" "$CONF.pre-san.bak"
cat > "$CONF" <<'NGINXEOF'
# saolei.wang 三域名（new / www / 裸域）— 新版扫雷网（Next.js 蓝绿双槽 @ saolei_upstream）
# 由 scripts/setup-https-saolei.sh 生成。手工改动会被脚本覆盖。
# 站点主域名 = www.saolei.wang（SITE_URL 与 OAuth 回调同口径）；new.* 为过渡期别名。

log_format spider_saolei '$http_x_forwarded_for - $time_iso8601 "$request" $status $body_bytes_sent '
                  '"$http_referer" rt=$request_time "$http_user_agent"';

# ========== 反爬（2026-10-21）==========
# map / limit_req_zone 定义在 /etc/nginx/conf.d/00-saolei-antibot.conf（软链到
# /home/deploy/nginx-conf/00-saolei-antibot.conf，root-antibot-setup.sh 安装）。
# 本脚本重写本文件时，server 块内的挂载点（if 403 / limit_req）必须原样保留。
#
# 2026-10-23 限速豁免（静态资源）：limit_req 原挂 server 顶层，一次页面加载
# （HTML+JS chunk+CSS+头像 30-50 请求）叠加 Link prefetch 即打满 burst=20 → 玩家
# 切排行 tab 连点出 429。开源 nginx 无 limit_req off 参数——改为把 general 限速
# 下沉到 443 的动态 location /（只管 HTML/RSC/API）；静态 location 各自成块
# 不带 limit_req，天然不限速。/videos/ 档不变。

server {
    listen 80;
    server_name new.saolei.wang www.saolei.wang saolei.wang;
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
    server_name new.saolei.wang www.saolei.wang saolei.wang;
    access_log /home/deploy/nginx-logs/saolei.access.log spider_saolei;
    client_max_body_size 30m;

    ssl_certificate     /etc/nginx/ssl/saolei/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/saolei/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    # ========== 反爬（2026-10-21，定义见 00-saolei-antibot.conf）==========
    # UA 黑名单（空 UA / 脚本库 UA）直接 403；搜索引擎 bot 与 curl 不在黑名单
    if ($saolei_bad_ua) { return 403; }
    # 注意：general 限速不在此挂载（2026-10-23 下沉到 443 的动态 location /，
    # 见下方——server 顶层挂载会把 JS chunk/头像等静态请求也计入 burst，玩家
    # 切排行 tab 连点即 429；/videos/ 档仍在专属 location 内挂载）

    # ========== 静态缓存（2026-10-20）==========
    # 背景：Next 代理对 public/ 资源一律 max-age=0 每请求回源验证；这里按类型直读磁盘。
    # ^~ 前缀优先于下方正则，防止误劫持。

    # Next 构建产物：自带 Cache-Control immutable 一年，原样转发即可
    location ^~ /_next/ {
        proxy_pass http://saolei_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # 运行时上传（头像）由 nginx 直读磁盘：Next 生产模式 public/ 是构建期快照，
    # 运行期新增文件不经 nginx 读不到（01xue 同款坑）。URL 可能固定复用 → 只给 7d
    location ^~ /uploads/ {
        alias /home/deploy/saolei.wang/public/uploads/;
        expires 7d;
        access_log off;
    }

    # 论坛外链图本地化 WebP（2026-10-22，gitignore 不入库、部署 rsync --delete 不碰，
    # 运行期由 scripts/sync/bbs-img-localize.py 落盘；内容寻址不可变 → 长缓存）
    location ^~ /bbs-img/ {
        alias /home/deploy/saolei.wang/public/bbs-img/;
        expires 30d;
        access_log off;
    }

    # 旧站迁移用户照片（/images/player/{id}.jpg，gitignore 不入库，运行期补文件同样需要直读）
    location ^~ /images/player/ {
        alias /home/deploy/saolei.wang/public/images/player/;
        expires 7d;
        access_log off;
    }

    # 录像实体文件（/videos/** gitignore 不入库，单独 rsync，部署 --delete 不碰）
    location ^~ /videos/ {
        # 录像文件带宽保护：56 万文件，狂抓打爆带宽（2026-10-21）。
        # videos 档在本 location 内独立挂载（general 已下沉到动态 location /，两档不叠加）
        limit_req zone=saolei_videos burst=6 nodelay;
        alias /home/deploy/saolei.wang/videos/;
        expires 30d;
        access_log off;
    }

    # 唯一生效样式文件（改动相对频繁，部署即变）：短缓存，隔天全网可见
    location = /styles/legacy-2013.css {
        root /home/deploy/saolei.wang/public;
        expires 1d;
        access_log off;
    }

    # Next metadata 图标（编译产物在 src/app/，磁盘 public/ 没有）→ 交回 Next 处理
    location = /icon.svg       { proxy_pass http://saolei_upstream; }
    location = /favicon.ico    { proxy_pass http://saolei_upstream; }
    location = /apple-icon.png { proxy_pass http://saolei_upstream; }

    # 其余 public 静态（logo/表情/军衔图/下载包/皮肤包/练习页 js+css 等）：
    # 均为构建期快照、部署才变 → 长缓存。URL 路径与 public/ 下相对路径一致，用 root 直读
    location ~* \.(gif|jpe?g|png|svg|ico|webp|css|js|woff2?|ttf|eot|zip|rar|7z|apk|exe|mp3|wav)$ {
        root /home/deploy/saolei.wang/public;
        expires 30d;
        access_log off;
    }

    # ========== 静态缓存段结束 ==========

    location / {
        # general 限速下沉至此（2026-10-23）：只管动态路径（HTML/RSC/API）；
        # 静态 location 各自成块不带 limit_req 即天然不限速（server 顶层挂载会把
        # JS chunk/头像也算进 burst，玩家切排行 tab 连点即 429）
        limit_req zone=saolei_general burst=20 nodelay;
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
