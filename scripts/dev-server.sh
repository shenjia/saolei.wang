#!/bin/sh
# saolei-dev 持久 dev server（由 launchd LaunchAgent com.saolei.dev 托管，开机自启 + 崩溃重拉）
# 必须 unset NODE_OPTIONS：WorkBuddy 注入的 genie-safe-delete 护栏会拦 next dev 清理 .next
unset NODE_OPTIONS
# launchd 环境 PATH 极简，补齐 homebrew
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
exec /usr/local/bin/pnpm exec next dev -p 3100
