-- rank_snapshot 行式 → 每人一行 JSON（2026-10-22 重构迁移）
-- 背景：旧结构每人每天一行（14 天 9.8 万行，~255 万行/年）；新结构每人一行，
--       ranks JSON 滚动 31 天总计时间名次 + 预计算 delta（30 天窗口最早可得快照 − 今日）。
-- 口径：基准 = 30 天窗口内最早可得快照（存量最早 2026-09-23，上线当天即有榜，
--       30 天后自然收敛为严格「30 天前」口径，旧站 day.sql 同款窗口）。
-- 用法（单次执行；失败可 DROP rank_snapshot_new 后从头重跑——本脚本不自动回滚）：
--   mysql saolei < scripts/migrate-rank-snapshot-json.sql
-- 执行前必备份：mysqldump --no-create-info --complete-insert saolei rank_snapshot | gzip > backup.sql.gz
-- 五步：① 建新表 ② 聚合 ③ 补零 ④ 原子切换 ⑤（确认后手工 DROP 旧表）
--
-- MySQL 兼容性实证（2026-10-22，本地 9.2 / 生产 8.0）：
--   JSON_TABLE 不能作相关子查询（1064），必须横向 JOIN（LATERAL 逗号写法）；
--   COLUMNS 列必须带表别名引用（jt.k，裸 k 报 Unknown column）。

-- ① 新表（结构与 schema.prisma RankSnapshot 一致）
CREATE TABLE IF NOT EXISTS rank_snapshot_new (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  user        BIGINT       NOT NULL,
  ranks       JSON         NOT NULL,
  delta       INT          NOT NULL DEFAULT 0,
  base_date   CHAR(10)     NOT NULL DEFAULT '',
  create_time BIGINT       NOT NULL DEFAULT 0,
  update_time BIGINT       NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY rank_snapshot_user_key (user),
  KEY rank_snapshot_delta_idx (delta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ② 聚合旧行：
--    ranks = {date: sum_time_rank}（剔除 >30 天旧日期；sum_3bvs_rank 无消费方直接丢弃）
--    latest_rank = 最新快照日的名次（迁移常跑在当日刷新前，最新只到昨天）
--    base_date = 窗口内除最新日外最早可得日期 → delta = base 名次 − latest 名次
--    （today 键由迁移后的首次 refreshRankSnapshots() 补齐并重算 delta）
TRUNCATE rank_snapshot_new;
INSERT INTO rank_snapshot_new (user, ranks, delta, base_date, create_time, update_time)
SELECT g.user, g.ranks,
       COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(g.ranks, CONCAT('$."', g.base_date, '"'))) AS SIGNED) - g.latest_rank, 0),
       COALESCE(g.base_date, ''),
       UNIX_TIMESTAMP(), UNIX_TIMESTAMP()
FROM (
  SELECT a.user, a.ranks, a.latest_rank, MIN(jt.k) AS base_date
  FROM (
    SELECT user,
           JSON_OBJECTAGG(date, sum_time_rank) AS ranks,
           SUBSTRING_INDEX(SUBSTRING_INDEX(GROUP_CONCAT(sum_time_rank ORDER BY date DESC), ',', 1), ',', -1) + 0 AS latest_rank
    FROM rank_snapshot
    WHERE date > DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    GROUP BY user
  ) a
  LEFT JOIN JSON_TABLE(JSON_KEYS(a.ranks), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) jt
       ON jt.k IS NOT NULL
       AND jt.k <> (SELECT MAX(date) FROM rank_snapshot)
  GROUP BY a.user, a.ranks, a.latest_rank
) g;

-- ③ 只有一天数据的玩家（base_date NULL）补零
UPDATE rank_snapshot_new SET base_date = '' WHERE base_date IS NULL;

-- ④ 原子切换（RENAME 原子，页面无感）
RENAME TABLE rank_snapshot TO rank_snapshot_old_rowwise, rank_snapshot_new TO rank_snapshot;

-- ⑤ 确认新表数据无误后手工执行（生产勿留 schema 外表——会阻塞 db push！）：
-- DROP TABLE rank_snapshot_old_rowwise;
