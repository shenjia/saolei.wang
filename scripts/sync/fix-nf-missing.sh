#!/bin/zsh
# NF 漏标修复（2026-10-20 补充）：14 条 Vienna rmv「实际 NF 却没标」→ noflag=1
# 依据：rmv.ts 解析补扫（261 条 rmv 全解析成功，14 条反向 mismatch，全部唐畅 user 26896
#       2022-06~11 Vienna 上传；抽验 232962/233128/261548/250802 纯 lc/lr 无右键事件）。
# 连带：video_scores_{beg,int}_nf 补插行（从主表 INSERT IGNORE）+ user_scores(_nf) 重算
#       + video_metrics 定点重算（--ids 全链路 dist/composite/rank/user_stnb_best）。
# 用法：
#   ./scripts/sync/fix-nf-missing.sh --local-test   # 本地：备份+执行+对账
#   ./scripts/sync/fix-nf-missing.sh --local-verify # 本地：仅对账
#   ./scripts/sync/fix-nf-missing.sh --prod         # 生产（本地验证通过后）
set -e
cd "$(dirname "$0")/../../"

IDS="232962,232963,233128,235063,247454,247586,250802,250804,257201,257202,258179,258180,261544,261548"
echo "$IDS" | tr ',' '\n' > /tmp/nf-missing-ids.txt

SSH_HOST="deploy@60.205.137.210"
SSH_KEY="$HOME/.ssh/shenjia.pem"
TS=$(date +%Y%m%d-%H%M%S)

run_sql() {
  if [[ "$1" == "local" ]]; then mysql -uroot saolei -e "$2"; else
    ssh -i "$SSH_KEY" "$SSH_HOST" "mysql -usaolei -pSa0lei_Pr0d_2026 saolei -e '$2'" 2>/dev/null; fi
}

apply_fix() {
  local scope=$1
  run_sql $scope "UPDATE video_info SET noflag=1 WHERE id IN ($IDS) AND noflag=0"
  # _nf 表补插（status=20 已过审；主表行已存在——这批录像早过审）
  run_sql $scope "INSERT IGNORE INTO video_scores_beg_nf (id,user,score_time,score_3bvs,create_time) SELECT s.id, s.user, s.score_time, s.score_3bvs, s.create_time FROM video_scores_beg s JOIN video v ON v.id=s.id JOIN video_info i ON i.id=s.id WHERE s.id IN ($IDS) AND v.status=20 AND v.level='beg'"
  run_sql $scope "INSERT IGNORE INTO video_scores_int_nf (id,user,score_time,score_3bvs,create_time) SELECT s.id, s.user, s.score_time, s.score_3bvs, s.create_time FROM video_scores_int s JOIN video v ON v.id=s.id JOIN video_info i ON i.id=s.id WHERE s.id IN ($IDS) AND v.status=20 AND v.level='int'"
  echo "[$scope] SQL 执行完成"
}

verify() {
  local scope=$1
  echo "== 对账 [$scope] =="
  echo "-- video_info.noflag=1 行数（期望 14）："
  run_sql $scope "SELECT COUNT(*) AS nf1_now FROM video_info WHERE id IN ($IDS) AND noflag=1"
  echo "-- _nf 表行数（期望 14）："
  run_sql $scope "SELECT (SELECT COUNT(*) FROM video_scores_beg_nf WHERE id IN ($IDS)) + (SELECT COUNT(*) FROM video_scores_int_nf WHERE id IN ($IDS)) AS nf_rows_now"
  echo "-- 唐畅 NF 榜最优（beg/int，ms）："
  run_sql $scope "SELECT MIN(beg_time), MIN(int_time) FROM user_scores_nf WHERE id=26896"
}

case "$1" in
  --local-test)
    mkdir -p .workbuddy/backups/$TS-nf-missing
    mysqldump -uroot saolei --complete-insert --skip-extended-insert \
      --where="id IN ($IDS)" video_info video_scores_beg video_scores_int video_scores_beg_nf video_scores_int_nf \
      | gzip > .workbuddy/backups/$TS-nf-missing/backup.sql.gz
    gunzip -t .workbuddy/backups/$TS-nf-missing/backup.sql.gz && echo "备份 OK"
    apply_fix local
    verify local
    ;;
  --local-verify)
    verify local
    ;;
  --prod)
    ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p ~/backup/nf-missing-$TS && cd ~/backup/nf-missing-$TS && \
      mysqldump -usaolei -pSa0lei_Pr0d_2026 --complete-insert --skip-extended-insert --single-transaction \
        --where='id IN ($IDS)' saolei video_info video_scores_beg video_scores_int video_scores_beg_nf video_scores_int_nf | gzip > backup.sql.gz && gzip -t backup.sql.gz"
    mkdir -p .workbuddy/backups/$TS-nf-missing-prod
    scp -i "$SSH_KEY" "$SSH_HOST:~/backup/nf-missing-$TS/backup.sql.gz" .workbuddy/backups/$TS-nf-missing-prod/ 2>/dev/null
    apply_fix prod
    verify prod
    ;;
  *)
    echo "用法: $0 --local-test | --local-verify | --prod"
    exit 1
    ;;
esac
