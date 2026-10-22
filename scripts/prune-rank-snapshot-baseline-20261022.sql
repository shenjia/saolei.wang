-- rank_snapshot 基线净化（2026-10-22，一次性）
-- 背景：30 天窗口「最早可得快照」锚到了迁移期脏数据——
--   09-23 首日快照生成于全量同步完成（19:30）前的过渡态（如 9301 sum_time 错算成 ~15 万级 → 假跳变 +1610）；
--   10-13~10-15 是增量同步 + 封禁回填 + user_scores 生产全量重算的震荡期（26770 名次来回震荡）；
--   10-16~10-20 仍有 user_scores 漏更余波（35322 到 10-17 才修正、30037 到 10-20 15:41 级别修复重算才修正——
--   生产备份 user-scores-recompute-20261015-200445 实证 10-15 重算后两人成绩仍旧值）。
-- 处置：剪掉 2026-10-21 之前的全部日期键（10-21 = 10-20 级别修复重算后首个完整干净快照日），
--   再跑 refreshRankSnapshots --force 重算 delta（基准 = 10-21）。
-- 用法：mysql saolei < scripts/prune-rank-snapshot-baseline-20261022.sql
--   随后：env -u NODE_OPTIONS node --experimental-transform-types \
--         --import ./scripts/sync/ts-extension-loader.mjs scripts/rank-snapshot-refresh.ts --force

UPDATE rank_snapshot rs
LEFT JOIN (
  SELECT rs2.user,
         JSON_OBJECTAGG(jt.k, JSON_EXTRACT(rs2.ranks, CONCAT('$."', jt.k, '"'))) AS pruned
  FROM rank_snapshot rs2
  JOIN JSON_TABLE(JSON_KEYS(rs2.ranks), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) jt
  WHERE jt.k >= '2026-10-21'
  GROUP BY rs2.user
) p ON p.user = rs.user
SET rs.ranks      = COALESCE(p.pruned, JSON_OBJECT()),
    rs.delta      = 0,
    rs.base_date  = '',
    rs.update_time = UNIX_TIMESTAMP();

-- 核对：全部行不应再含 2026-10-20 及更早的键
-- SELECT COUNT(*) FROM rank_snapshot
-- WHERE JSON_CONTAINS_PATH(ranks, 'one', '$."2026-10-20"');
