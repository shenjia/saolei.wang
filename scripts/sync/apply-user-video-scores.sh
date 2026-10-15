#!/bin/zsh
# video_scores_* 6 张表全量重算（2026-10-15 口径统一：ROUND + 清洗 NF 脏行）
# 用法：
#   apply-user-video-scores.sh --local-test   本地影子表全流程验证
#   apply-user-video-scores.sh --prod         生产：备份 → 事务内重建 → 对账
set -euo pipefail
cd "$(dirname "$0")"

TPL=apply-user-video-scores.sql.tpl
SSH_KEY=~/.ssh/shenjia.pem
SSH_HOST=deploy@60.205.137.210
DB_NAME=saolei
# 6 张表：级别 NF(0/1)
TABLES=(beg:0 beg_nf:1 int:0 int_nf:1 exp:0 exp_nf:1)

gen_sql() { # $1=out  —— 6 张表按模板展开，:TBL/:LVL/:NFFLAG/:DB 全替换
  : > "$1"
  for spec in $TABLES; do
    tbl=${spec%%:*}; nf=${spec##*:}; lvl=${tbl%%_nf}
    sed -e "s/:DB/$DB_NAME/g" -e "s/:TBL/$tbl/g" -e "s/:LVL/$lvl/g" -e "s/:NFFLAG/$nf/g" "$TPL" >> "$1"
  done
}

# 只读对账：重算口径 vs 表现值，期望全 0
diff_sql() { # $1=out
  : > "$1"
  for spec in $TABLES; do
    tbl=${spec%%:*}; nf=${spec##*:}; lvl=${tbl%%_nf}
    nfcond="1=1"; [[ $nf == 1 ]] && nfcond="vi.noflag=1"
    cat >> "$1" <<SQL
SELECT '$tbl' t,
  SUM(x.id IS NULL) missing,
  SUM(y.id IS NULL) orphan,
  SUM(x.id IS NOT NULL AND y.id IS NOT NULL AND (NOT(x.score_time<=>y.score_time) OR NOT(x.score_3bvs<=>y.score_3bvs) OR NOT(x.user<=>y.user) OR NOT(x.create_time<=>y.create_time))) mismatched
FROM (SELECT v.id, v.user, vi.real_time score_time, ROUND(vi.board_3bv*1000000/vi.real_time) score_3bvs, v.create_time
      FROM $DB_NAME.video v JOIN $DB_NAME.video_info vi ON vi.id=v.id
      WHERE v.status=20 AND v.level='$lvl' AND $nfcond AND vi.real_time>0) x
LEFT JOIN $DB_NAME.video_scores_$tbl y ON y.id=x.id;
SQL
  done
}

case "${1:-}" in
  --local-test)
    DB=saolei
    echo "== 1/3 本地备份现表 =="
    mkdir -p ../../.workbuddy/backups/local-video-scores-$(date +%Y%m%d-%H%M%S)
    BK=../../.workbuddy/backups/local-video-scores-$(date +%Y%m%d-%H%M%S)
    mkdir -p $BK; for t in beg int exp beg_nf int_nf exp_nf; do
      mysqldump -uroot $DB video_scores_$t | gzip > $BK/video_scores_$t.sql.gz
    done; ls $BK
    echo "== 2/3 本地执行重建 =="
    gen_sql /tmp/uvs-apply.sql && mysql -uroot $DB < /tmp/uvs-apply.sql
    echo "== 3/3 对账（期望全 0）=="
    diff_sql /tmp/uvs-diff.sql && mysql -uroot $DB < /tmp/uvs-diff.sql
    ;;
  --prod)
    TS=$(date +%Y%m%d-%H%M%S)
    echo "== 1/4 生产备份 6 张表 =="
    ssh -i $SSH_KEY $SSH_HOST "mkdir -p ~/backup/video-scores-recompute-$TS && for t in beg int exp beg_nf int_nf exp_nf; do mysqldump -usaolei -pSa0lei_Pr0d_2026 $DB_NAME video_scores_\$t 2>/dev/null | gzip > ~/backup/video-scores-recompute-$TS/video_scores_\$t.sql.gz; done && ls -la ~/backup/video-scores-recompute-$TS/"
    echo "== 2/4 下载备份到本地 .workbuddy/backups =="
    BK=../../.workbuddy/backups/$TS-prod-video-scores
    mkdir -p $BK
    for t in beg int exp beg_nf int_nf exp_nf; do
      scp -q -i $SSH_KEY $SSH_HOST:~/backup/video-scores-recompute-$TS/video_scores_$t.sql.gz $BK/
    done
    ls -la $BK
    echo "== 3/4 生产执行（每表单事务）=="
    DB_NAME=saolei gen_sql /tmp/uvs-apply.sql
    scp -q -i $SSH_KEY /tmp/uvs-apply.sql $SSH_HOST:/tmp/uvs-apply.sql
    ssh -i $SSH_KEY $SSH_HOST "mysql -usaolei -pSa0lei_Pr0d_2026 $DB_NAME < /tmp/uvs-apply.sql" 2>/dev/null
    echo "== 4/4 生产对账（期望全 0）=="
    diff_sql /tmp/uvs-diff.sql
    scp -q -i $SSH_KEY /tmp/uvs-diff.sql $SSH_HOST:/tmp/uvs-diff.sql
    ssh -i $SSH_KEY $SSH_HOST "mysql -usaolei -pSa0lei_Pr0d_2026 $DB_NAME -e 'source /tmp/uvs-diff.sql'" 2>/dev/null
    ;;
  *) echo "usage: $0 --local-test | --prod"; exit 1;;
esac
