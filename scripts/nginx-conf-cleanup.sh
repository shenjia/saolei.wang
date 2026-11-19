#!/usr/bin/env bash
# 一次性 root 清理（01xue 服务器）：把 conf.d 里被 *.conf 通配误 include 的
# 备份文件改成 .bak 后缀（不再被 include）。
#
# 背景：/etc/nginx/conf.d/01xue.conf.bak.20260830201937 与 01xue.conf.pre-bluegreen
# 后缀仍以 .conf 结尾（*.bak.20260830201937 不以 .conf 结尾？——实测它以
# .20260830201937 结尾，不含 .conf，但 01xue.conf.bak 也不以 .conf 结尾……
# 真正被 include 的只有 *.conf；此脚本将所有非正式 conf 移出 conf.d 归档到
# /root/nginx-conf-archive/，一劳永逸消除「备份文件被通配 include 成为
# default server」的隐患（2026-09-25 排查：未知 Host 被 301 到 01xue.com）。
#
# 用法（root）：sudo bash /home/deploy/nginx-conf-cleanup-saolei.sh
set -euo pipefail

ARCHIVE=/root/nginx-conf-archive
mkdir -p "$ARCHIVE"

cd /etc/nginx/conf.d
for f in *.bak *.bak.* *.pre-bluegreen; do
  [[ -e "$f" ]] || continue
  mv "$f" "$ARCHIVE/"
  echo "[ok] 归档: $f"
done

/usr/sbin/nginx -t
echo "[done] 清理完成（未 reload，运行配置不变；下次任意 reload 生效）"
