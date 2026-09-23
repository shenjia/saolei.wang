#!/bin/sh
# dev.saolei.wang 持久开发服务一次性安装脚本
# 用法：sh scripts/setup-dev.sh（会请求 sudo 写 /etc/hosts）
#
# 构成：
#   launchd LaunchAgent com.saolei.dev → next dev @3100（开机自启 + 崩溃重拉）
#     plist   ~/Library/LaunchAgents/com.saolei.dev.plist
#     启动器  ~/Library/Application Support/saolei/dev-server.sh
#     日志    /tmp/saolei-dev.out.log / /tmp/saolei-dev.err.log
#   nginx    /usr/local/etc/nginx/servers/saolei.wang.conf（80/443 → 3100，mkcert 证书）
#   hosts    127.0.0.1 dev.saolei.wang
#
# 说明：plist 与启动器放本地目录而非坚果云同步目录——launchd 对云同步路径
# 的可执行文件会拒绝加载；WorkBuddy 会话内也无法注册 launchd（EIO），
# 所以本脚本需要张老师在终端里亲手跑一次。

set -e

# 1) hosts
if grep -q "dev.saolei.wang" /etc/hosts; then
    echo "[1/2] hosts 已有 dev.saolei.wang，跳过"
else
    echo "127.0.0.1 dev.saolei.wang" | sudo tee -a /etc/hosts
    echo "[1/2] hosts 已写入"
fi

# 2) launchd（必须在用户 GUI 会话里跑，不能 sudo）
UID_=$(id -u)
if launchctl print "gui/$UID_/com.saolei.dev" >/dev/null 2>&1; then
    echo "[2/2] launchd 服务已注册，跳过"
else
    launchctl bootstrap "gui/$UID_" "$HOME/Library/LaunchAgents/com.saolei.dev.plist"
    echo "[2/2] launchd 服务已注册并启动"
fi

sleep 3
echo "---"
launchctl list | grep saolei || echo "!! 服务未在运行，查 /tmp/saolei-dev.err.log"
curl -s --noproxy '*' -o /dev/null -w "http://localhost:3100 -> %{http_code}\n" --max-time 20 http://localhost:3100/
curl -s --noproxy '*' -o /dev/null -w "https://dev.saolei.wang -> %{http_code}\n" --max-time 20 https://dev.saolei.wang/
