#!/bin/sh
# dev 冷启动（2026-10-22）：Turbopack 对运行中新建的文件会死缓存旧编译产物
# （实证：practice-local.ts 新建后客户端 bundle 一直跑旧版逻辑），普通
# kickstart 重启不换 .next 缓存，必须 bootout → rm .next → bootstrap 全套。
# 用法：sh scripts/dev-cold-start.sh（约 1-2 分钟，首次请求现编译较慢）

set -e
UID_=$(id -u)

echo "[1/4] bootout 停掉 com.saolei.dev …"
launchctl bootout "gui/$UID_/com.saolei.dev" 2>/dev/null || true
sleep 2

echo "[2/4] 删除 .next 编译缓存 …"
cd "/Users/shenjia/Nutstore Files/我的坚果云/works/github/saolei.wang"
rm -rf .next

echo "[3/4] bootstrap 重新拉起 …"
launchctl bootstrap "gui/$UID_" "$HOME/Library/LaunchAgents/com.saolei.dev.plist"
sleep 10

echo "[4/4] 探活 …"
curl -s --noproxy '*' -o /dev/null -w "http://127.0.0.1:3100 -> %{http_code}\n" --max-time 60 http://127.0.0.1:3100/
curl -s --noproxy '*' -o /dev/null -w "https://dev.saolei.wang -> %{http_code}\n" --max-time 60 https://dev.saolei.wang/
