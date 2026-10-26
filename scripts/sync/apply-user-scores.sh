#!/bin/zsh
# 重算 user_scores(_nf) —— 2026-10-15 张老师批准的存量修复
# 口径见 recompute-user-scores.sql 头注释（user_scores=全量含NF；user_scores_nf=仅 noflag=1；3bvs=ROUND）
#
# 用法：
#   本地影子表验证：./apply-user-scores.sh --local-test
#   生产执行：      ./apply-user-scores.sh --prod    （执行前自动 mysqldump 备份两表）
set -e
cd "$(dirname "$0")"

DB_NAME=saolei
TPL=apply-user-scores.sql.tpl
SSH_HOST="deploy@60.205.137.210"
SSH_KEY="$HOME/.ssh/shenjia.pem"
TS=$(date +%Y%m%d-%H%M%S)
WORK=/tmp/apply-user-scores-$TS
mkdir -p $WORK

gen_sql() {  # gen_sql <nf> <table> <out>
  sed -e "s/:NF/$1/g" -e "s/:TBL/$2/g" -e "s/:DB/$3/g" "$TPL" > "$4"
}

if [[ "$1" == "--local-test" ]]; then
  echo "== 本地影子表验证 =="
  mysql -uroot $DB_NAME -e "
    DROP TABLE IF EXISTS user_scores_apitest, user_scores_nf_apitest;
    CREATE TABLE user_scores_apitest LIKE user_scores;
    INSERT INTO user_scores_apitest SELECT * FROM user_scores;
    CREATE TABLE user_scores_nf_apitest LIKE user_scores_nf;
    INSERT INTO user_scores_nf_apitest SELECT * FROM user_scores_nf;"

  gen_sql 0 user_scores_apitest $DB_NAME $WORK/us.sql
  gen_sql 1 user_scores_nf_apitest $DB_NAME $WORK/usn.sql

  echo "-- apply user_scores_apitest"; time mysql -uroot $DB_NAME < $WORK/us.sql
  echo "-- apply user_scores_nf_apitest"; time mysql -uroot $DB_NAME < $WORK/usn.sql

  echo "-- 对账（期望：missing_row=0、full_match=calc_rows、orphan clear=0）"
  # 用占位符避免子串二次替换（user_scores 是 user_scores_nf 的前缀）
  sed -e "s/user_scores/@MAIN@/g" -e "s/@MAIN@_nf/@NF@/g" \
      -e "s/@MAIN@/user_scores_apitest/g" -e "s/@NF@/user_scores_nf_apitest/g" \
    recompute-user-scores.sql > $WORK/verify.sql
  mysql -uroot $DB_NAME < $WORK/verify.sql

  mysql -uroot $DB_NAME -e "DROP TABLE user_scores_apitest, user_scores_nf_apitest;"
  echo "== 完成，影子表已清理 =="
  exit 0
fi

if [[ "$1" == "--prod" ]]; then
  # 生产避峰守卫（2026-10-27 慢 SQL 巡检治理）：2026-10-26 13:17 曾有会话在临近高峰期
  # 直跑重算（WITH 13.1s + INSERT 6s 万行级写）。高峰期（14-17 点）拒绝执行，
  # 确认无碍可加 --off-peak-ok 放行。
  if [[ $(date +%H) -ge 14 && $(date +%H) -lt 17 && "$2" != "--off-peak-ok" ]]; then
    echo "[避峰守卫] 当前 $(date +%H) 点处于生产高峰期（14-17 点），拒绝执行 user_scores 重算。" >&2
    echo "           请在低峰期运行，或确认无碍后追加 --off-peak-ok 放行。" >&2
    exit 1
  fi
  echo "== 1/4 备份生产两表 =="
  ssh -i $SSH_KEY $SSH_HOST 'DB_PASS=$(sed -n "s/^DATABASE_URL=\"mysql:\/\/saolei:\([^@]*\)@localhost.*/\1/p" /home/deploy/saolei.wang/.env); export MYSQL_PWD="$DB_PASS"; test -n "$MYSQL_PWD" && \
    mkdir -p ~/backup/user-scores-recompute-'"$TS"' && cd ~/backup/user-scores-recompute-'"$TS"' && \
    mysqldump -usaolei --complete-insert --single-transaction '"$DB_NAME"' user_scores user_scores_nf | gzip > user_scores-backup.sql.gz && \
    gzip -t user_scores-backup.sql.gz && ls -la'
  mkdir -p "../../.workbuddy/backups/$TS-prod-user-scores"
  scp -i $SSH_KEY $SSH_HOST:~/backup/user-scores-recompute-$TS/user_scores-backup.sql.gz "../../.workbuddy/backups/$TS-prod-user-scores/"
  gunzip -t "../../.workbuddy/backups/$TS-prod-user-scores/user_scores-backup.sql.gz" && echo "本地备份校验 OK"

  echo "== 2/4 生成 SQL 并上传 =="
  gen_sql 0 user_scores $DB_NAME $WORK/us.sql
  gen_sql 1 user_scores_nf $DB_NAME $WORK/usn.sql
  scp -i $SSH_KEY $WORK/us.sql $WORK/usn.sql $SSH_HOST:~/backup/user-scores-recompute-$TS/

  echo "== 3/4 生产执行（事务）=="
  { echo "START TRANSACTION;"; echo "SOURCE ~/backup/user-scores-recompute-$TS/us.sql;"; \
    echo "SOURCE ~/backup/user-scores-recompute-$TS/usn.sql;"; echo "COMMIT;"; } > $WORK/us-all.sql
  scp -i $SSH_KEY $WORK/us-all.sql $SSH_HOST:~/backup/user-scores-recompute-$TS/
  ssh -i $SSH_KEY $SSH_HOST 'DB_PASS=$(sed -n "s/^DATABASE_URL=\"mysql:\/\/saolei:\([^@]*\)@localhost.*/\1/p" /home/deploy/saolei.wang/.env); export MYSQL_PWD="$DB_PASS"; test -n "$MYSQL_PWD" && \
    mysql -usaolei '"$DB_NAME"' < ~/backup/user-scores-recompute-'"$TS"'/us-all.sql'
fi

echo "用法: $0 --local-test | --prod"
exit 1
