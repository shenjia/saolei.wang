#!/bin/zsh
# 生产端：解禁「有高级 SUB60 录像的封禁用户」的全部连坐录像（与 unban-exp-sub60.sh --local 同口径）
# 用法：./unban-exp-sub60-prod.sh
set -e
cd "$(dirname "$0")/.."

SSH_HOST="deploy@60.205.137.210"
SSH_KEY="$HOME/.ssh/shenjia.pem"
MYSQL="mysql -usaolei -pSa0lei_Pr0d_2026 saolei"
DUMP="mysqldump -usaolei -pSa0lei_Pr0d_2026 --complete-insert --single-transaction saolei"
TS=$(date +%Y%m%d-%H%M%S)
BK=".workbuddy/backups/$TS-prod-unban-exp-sub60"
mkdir -p "$BK"

# 1) 生产上重算目标用户（应与本地一致：18 人 1771 部）
IDS=$(ssh -i $SSH_KEY $SSH_HOST "mysql -usaolei -pSa0lei_Pr0d_2026 -N -B saolei -e \"SELECT DISTINCT u.id FROM user u JOIN video v ON v.user=u.id AND v.status=0 JOIN video_info i ON i.id=v.id WHERE u.status=-1 AND EXISTS (SELECT 1 FROM video v2 JOIN video_info i2 ON i2.id=v2.id WHERE v2.user=u.id AND v2.status=0 AND v2.level='exp' AND i2.real_time<60000)\"" 2>/dev/null)
IDLIST=$(echo "$IDS" | tr '\n' ',' | sed 's/,$//')
N=$(echo "$IDS" | grep -c .)
echo "== 目标用户 $N 人: $IDLIST"

echo "== 1/4 备份生产受影响行（服务器 + 本地双份）→ $BK"
ssh -i $SSH_KEY $SSH_HOST "mkdir -p ~/backup/unban-exp-sub60-$TS && \
  $DUMP video --where=\"user IN ($IDLIST) AND status=0\" | gzip > ~/backup/unban-exp-sub60-$TS/video-restore-backup.sql.gz && \
  $DUMP user_scores user_scores_nf --where=\"id IN ($IDLIST)\" | gzip > ~/backup/unban-exp-sub60-$TS/user-scores-backup.sql.gz && \
  gzip -t ~/backup/unban-exp-sub60-$TS/*.sql.gz && ls -la ~/backup/unban-exp-sub60-$TS/"
scp -i $SSH_KEY "$SSH_HOST:~/backup/unban-exp-sub60-$TS/*.sql.gz" "$BK/"
gunzip -t "$BK"/*.sql.gz && echo "本地备份校验 OK"

echo "== 2/4 生成定向重算 SQL 并上传 =="
TPL=scripts/sync/apply-user-scores.sql.tpl
sed -e "s/:NF/0/g" -e "s/:TBL/user_scores/g" -e "s/:DB/saolei/g" -e "s/^FROM calc$/FROM calc WHERE uid IN ($IDLIST)/" "$TPL" > /tmp/unban-us-prod.sql
sed -e "s/:NF/1/g" -e "s/:TBL/user_scores_nf/g" -e "s/:DB/saolei/g" -e "s/^FROM calc$/FROM calc WHERE uid IN ($IDLIST)/" -e "s/WHERE c.uid IS NULL/WHERE c.uid IS NULL AND us.id IN ($IDLIST)/" "$TPL" > /tmp/unban-usn-prod.sql
scp -i $SSH_KEY /tmp/unban-us-prod.sql /tmp/unban-usn-prod.sql "$SSH_HOST:~/backup/unban-exp-sub60-$TS/"

echo "== 3/4 生产执行（事务：解禁录像 + 重算成绩）=="
ssh -i $SSH_KEY $SSH_HOST "{ echo 'START TRANSACTION;'; \
  echo \"UPDATE video SET status=20, update_time=UNIX_TIMESTAMP() WHERE user IN ($IDLIST) AND status=0; SELECT ROW_COUNT() AS videos_restored;\"; \
  echo 'SOURCE ~/backup/unban-exp-sub60-'$TS'/unban-us-prod.sql;'; \
  echo 'SOURCE ~/backup/unban-exp-sub60-'$TS'/unban-usn-prod.sql;'; \
  echo 'COMMIT;'; } | $MYSQL" 2>/dev/null

echo "== 4/4 生产全库对账（期望：missing_row=0、full_match=calc_rows、orphan=0）=="
scp -i $SSH_KEY scripts/sync/recompute-user-scores.sql "$SSH_HOST:~/backup/unban-exp-sub60-$TS/verify.sql"
ssh -i $SSH_KEY $SSH_HOST "$MYSQL < ~/backup/unban-exp-sub60-$TS/verify.sql" 2>/dev/null
echo "== 完成，本地备份在 $BK =="
