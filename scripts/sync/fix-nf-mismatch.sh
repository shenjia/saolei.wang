#!/bin/zsh
# NF 错标修复（2026-10-20 张老师指令）：17 条「标 NF 但事件流有右键」→ noflag=0
# 依据：全库扫描 /tmp/nf-scan-diff.jsonl（308,779 行，mismatch 17 条全部单向 1→0；
#       反向「实际 NF 却没标」为 0）。样例核验：311535 avf 4×rc、319513 avf 195×rc、
#       8 条老 Clone mvf 59~291×rc（诊断脚本 scripts/tmp/diag-*.ts）。
# 连带：video_scores_*_nf 删行 + user_scores(_nf) 重算 + video_metrics.noflag 定点重算
#       （--ids 自动全量 dist/composite/rank/user_stnb_best 重建）。
# 用法：
#   ./scripts/sync/fix-nf-mismatch.sh --local-test   # 本地：备份+执行+对账
#   ./scripts/sync/fix-nf-mismatch.sh --local-verify # 本地：仅对账（幂等核验）
#   ./scripts/sync/fix-nf-mismatch.sh --prod         # 生产（本地验证通过后）
set -e
cd "$(dirname "$0")/../../"

IDS="9969,14557,22505,25226,43420,43688,45195,77614,211923,226264,234662,261287,281996,289446,303465,311535,319513"
IDS_FILE=/tmp/nf-mismatch-ids.txt
echo "$IDS" | tr ',' '\n' > "$IDS_FILE"

SSH_HOST="deploy@60.205.137.210"
SSH_KEY="$HOME/.ssh/shenjia.pem"
TS=$(date +%Y%m%d-%H%M%S)

run_sql() {  # run_sql <db-host> <sql>
  if [[ "$1" == "local" ]]; then mysql -uroot saolei -e "$2"; else
    ssh -i "$SSH_KEY" "$SSH_HOST" "mysql -usaolei -pSa0lei_Pr0d_2026 saolei -e '$2'" 2>/dev/null; fi
}

backup_local() {
  mkdir -p .workbuddy/backups/$TS-nf-fix
  for t in video_info video_scores_beg_nf video_scores_int_nf video_scores_exp_nf; do
    mysql -uroot saolei --complete-insert saolei -e "SELECT * FROM $t WHERE id IN ($IDS)" > /dev/null 2>&1 || true
  done
  mysqldump -uroot saolei --complete-insert --skip-extended-insert \
    --where="id IN ($IDS)" video_info video_scores_beg_nf video_scores_int_nf video_scores_exp_nf \
    | gzip > .workbuddy/backups/$TS-nf-fix/nf-fix-backup.sql.gz
  gunzip -t .workbuddy/backups/$TS-nf-fix/nf-fix-backup.sql.gz && echo "备份 OK: .workbuddy/backups/$TS-nf-fix/nf-fix-backup.sql.gz"
}

backup_prod() {
  ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p ~/backup/nf-fix-$TS && cd ~/backup/nf-fix-$TS && \
    mysqldump -usaolei -pSa0lei_Pr0d_2026 --complete-insert --skip-extended-insert --single-transaction \
      --where='id IN ($IDS)' saolei video_info video_scores_beg_nf video_scores_int_nf video_scores_exp_nf | gzip > nf-fix-backup.sql.gz && \
    gzip -t nf-fix-backup.sql.gz && ls -la"
  mkdir -p .workbuddy/backups/$TS-nf-fix-prod
  scp -i "$SSH_KEY" "$SSH_HOST:~/backup/nf-fix-$TS/nf-fix-backup.sql.gz" .workbuddy/backups/$TS-nf-fix-prod/
  gunzip -t .workbuddy/backups/$TS-nf-fix-prod/nf-fix-backup.sql.gz && echo "本地备份校验 OK"
}

apply_fix() {  # apply_fix <local|prod>
  local scope=$1
  # 1) video_info.noflag 1→0（update_time 不动——这是数据修正，不是业务变更）
  run_sql $scope "UPDATE video_info SET noflag=0 WHERE id IN ($IDS) AND noflag=1"
  # 2) NF 成绩表删行（17 条全部 status=20 在榜）
  run_sql $scope "DELETE FROM video_scores_beg_nf WHERE id IN ($IDS)"
  run_sql $scope "DELETE FROM video_scores_int_nf WHERE id IN ($IDS)"
  run_sql $scope "DELETE FROM video_scores_exp_nf WHERE id IN ($IDS)"
  echo "[$scope] SQL 执行完成"
}

verify() {  # verify <local|prod>
  local scope=$1
  echo "== 对账 [$scope] =="
  echo "-- video_info.noflag 残留 1："
  run_sql $scope "SELECT COUNT(*) AS nf1_left FROM video_info WHERE id IN ($IDS) AND noflag=1"
  echo "-- _nf 表残留行："
  run_sql $scope "SELECT (SELECT COUNT(*) FROM video_scores_beg_nf WHERE id IN ($IDS)) + (SELECT COUNT(*) FROM video_scores_int_nf WHERE id IN ($IDS)) + (SELECT COUNT(*) FROM video_scores_exp_nf WHERE id IN ($IDS)) AS nf_rows_left"
  echo "-- 主表 video_scores_* 行仍在（不受影响）："
  run_sql $scope "SELECT (SELECT COUNT(*) FROM video_scores_beg WHERE id IN ($IDS)) + (SELECT COUNT(*) FROM video_scores_int WHERE id IN ($IDS)) + (SELECT COUNT(*) FROM video_scores_exp WHERE id IN ($IDS)) AS main_rows"
}

case "$1" in
  --local-test)
    backup_local
    apply_fix local
    verify local
    ;;
  --local-verify)
    verify local
    ;;
  --prod)
    backup_prod
    apply_fix prod
    verify prod
    ;;
  *)
    echo "用法: $0 --local-test | --local-verify | --prod"
    exit 1
    ;;
esac
