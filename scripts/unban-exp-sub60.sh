#!/bin/zsh
# 解禁「有高级 SUB60 录像的封禁用户」的全部连坐录像（2026-10-16 张老师指令）
# 口径：封禁用户只要拥有高级(real_time<60000ms)录像，说明其封禁大概率与作弊无关，
#       其名下全部 status=0 录像（旧站连坐，status_bak 未记录）整体恢复为 20（通过）；
#       账号本身保持封禁（仅不上榜），随后重算 user_scores(_nf) 恢复其记录与军衔。
#
# 用法：./unban-exp-sub60.sh --local
set -e
cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
BK=".workbuddy/backups/$TS-unban-exp-sub60"
mkdir -p "$BK"

# 目标用户：封禁中 + 名下有被屏蔽的高级 SUB60 录像
IDS=$(mysql -uroot -N -B saolei -e "SELECT DISTINCT u.id FROM user u JOIN video v ON v.user=u.id AND v.status=0 JOIN video_info i ON i.id=v.id WHERE u.status=-1 AND EXISTS (SELECT 1 FROM video v2 JOIN video_info i2 ON i2.id=v2.id WHERE v2.user=u.id AND v2.status=0 AND v2.level='exp' AND i2.real_time<60000)")
IDLIST=$(echo "$IDS" | tr '\n' ',' | sed 's/,$//')
N=$(echo "$IDS" | grep -c .)
echo "== 目标用户 $N 人: $IDLIST"

echo "== 1/4 备份受影响行 → $BK"
mysqldump -uroot saolei video --complete-insert --where="user IN ($IDLIST) AND status=0" > "$BK/video-restore-backup.sql"
mysqldump -uroot saolei user_scores user_scores_nf --complete-insert --where="id IN ($IDLIST)" > "$BK/user-scores-backup.sql"
wc -l "$BK"/*.sql

echo "== 2/4 解禁录像（status 0→20）=="
mysql -uroot saolei -e "UPDATE video SET status=20, update_time=UNIX_TIMESTAMP() WHERE user IN ($IDLIST) AND status=0; SELECT ROW_COUNT();"

echo "== 3/4 定向重算 user_scores(_nf)（仅目标用户）=="
TPL=scripts/sync/apply-user-scores.sql.tpl
sed -e "s/:NF/0/g" -e "s/:TBL/user_scores/g" -e "s/:DB/saolei/g" -e "s/^FROM calc$/FROM calc WHERE uid IN ($IDLIST)/" "$TPL" > /tmp/unban-us.sql
sed -e "s/:NF/1/g" -e "s/:TBL/user_scores_nf/g" -e "s/:DB/saolei/g" -e "s/^FROM calc$/FROM calc WHERE uid IN ($IDLIST)/" -e "s/WHERE c.uid IS NULL/WHERE c.uid IS NULL AND us.id IN ($IDLIST)/" "$TPL" > /tmp/unban-usn.sql
mysql -uroot saolei < /tmp/unban-us.sql
mysql -uroot saolei < /tmp/unban-usn.sql

echo "== 4/4 全库对账（期望：missing_row=0、full_match=calc_rows、orphan=0）=="
mysql -uroot saolei < scripts/sync/recompute-user-scores.sql

echo "== 目标用户成绩抽样 =="
mysql -uroot saolei -e "SELECT id, exp_time, exp_3bvs, int_time, beg_time, sum_time, sum_3bvs FROM user_scores WHERE id IN ($IDLIST) ORDER BY sum_time DESC LIMIT 8;"
echo "== 完成，备份在 $BK =="
