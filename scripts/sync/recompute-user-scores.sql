-- 重算 user_scores(_nf)：从 video ⋈ video_info（仅 status=20 已通过）聚合各用户最好成绩
-- 口径（2026-10-15 与张老师确认前先按 MSSQL 数据实证得出，见 2026-10-15 日志）：
--   * user_scores      = 全部 status=20 录像的最优（老站语义不筛 NF，实证 us_better=0）
--   * user_scores_nf   = 仅 noflag=1 的 status=20 录像（NF 榜设计语义；顺带清洗 NF 表 125 行 noflag=0 脏数据）
--   * time = real_time；3bvs = ROUND(board_3bv×1e6/real_time)（MSSQL 原始浮点数据实证为 round，
--            仅 board 修正遗留的 69/72058 行例外），仅 board_3bv>=4（3bvs>0）参与
--   * tie-break：同成绩取 vid 最小（与增量「严格更优才替换」语义一致）
--   * video/date 字段 = 达成该最优的录像 id 与其 create_time
--   * sum_time/sum_3bvs = 三级都 >0 才求和，否则 0（review.ts withSum）
--   * 有行无通过录像的用户（117 例「全屏蔽但成绩未清零」遗留）→ 成绩清零
--
-- 用法：
--   校验：跑本文件（只含 SELECT，安全）
--   应用：见 scripts/sync/apply-user-scores.sh（事务内执行 INSERT...ON DUP + 清零 UPDATE）

-- ============ calc CTE（两表共用，nf 由 :NF 位置区分） ============
-- 下列两个语句结构相同，仅 noflag 取值不同：
--   语句 A（nf=0）→ 对账 user_scores
--   语句 B（nf=1）→ 对账 user_scores_nf

-- ---------- 语句 A：user_scores（noflag 不限） ----------
WITH
b_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='beg' AND vi.real_time>0) x WHERE rn=1),
i_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='int' AND vi.real_time>0) x WHERE rn=1),
e_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='exp' AND vi.real_time>0) x WHERE rn=1),
b_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='beg' AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
i_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='int' AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
e_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='exp' AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
calc AS (
  SELECT u.uid, b_t.rt beg_time, b_t.vid beg_time_video, b_t.ct beg_time_date,
         b_b.bvs beg_3bvs, b_b.vid beg_3bvs_video, b_b.ct beg_3bvs_date,
         i_t.rt int_time, i_t.vid int_time_video, i_t.ct int_time_date,
         i_b.bvs int_3bvs, i_b.vid int_3bvs_video, i_b.ct int_3bvs_date,
         e_t.rt exp_time, e_t.vid exp_time_video, e_t.ct exp_time_date,
         e_b.bvs exp_3bvs, e_b.vid exp_3bvs_video, e_b.ct exp_3bvs_date,
         IF(b_t.rt>0 AND i_t.rt>0 AND e_t.rt>0, b_t.rt+i_t.rt+e_t.rt, 0) sum_time,
         IF(b_b.bvs>0 AND i_b.bvs>0 AND e_b.bvs>0, b_b.bvs+i_b.bvs+e_b.bvs, 0) sum_3bvs
  FROM (SELECT DISTINCT user uid FROM video WHERE status=20) u
  LEFT JOIN b_t ON b_t.uid=u.uid LEFT JOIN b_b ON b_b.uid=u.uid
  LEFT JOIN i_t ON i_t.uid=u.uid LEFT JOIN i_b ON i_b.uid=u.uid
  LEFT JOIN e_t ON e_t.uid=u.uid LEFT JOIN e_b ON e_b.uid=u.uid)
SELECT 'user_scores' tbl,
  COUNT(*) calc_rows,
  SUM(us.id IS NULL) missing_row,
  SUM(us.id IS NOT NULL AND (c.beg_time<=>us.beg_time) AND (c.beg_3bvs<=>us.beg_3bvs)
    AND (c.int_time<=>us.int_time) AND (c.int_3bvs<=>us.int_3bvs)
    AND (c.exp_time<=>us.exp_time) AND (c.exp_3bvs<=>us.exp_3bvs)
    AND (c.sum_time<=>us.sum_time) AND (c.sum_3bvs<=>us.sum_3bvs)
    AND (c.beg_time_video<=>us.beg_time_video) AND (c.beg_3bvs_video<=>us.beg_3bvs_video)
    AND (c.int_time_video<=>us.int_time_video) AND (c.int_3bvs_video<=>us.int_3bvs_video)
    AND (c.exp_time_video<=>us.exp_time_video) AND (c.exp_3bvs_video<=>us.exp_3bvs_video)
    AND (c.beg_time_date<=>us.beg_time_date) AND (c.beg_3bvs_date<=>us.beg_3bvs_date)
    AND (c.int_time_date<=>us.int_time_date) AND (c.int_3bvs_date<=>us.int_3bvs_date)
    AND (c.exp_time_date<=>us.exp_time_date) AND (c.exp_3bvs_date<=>us.exp_3bvs_date)) full_match,
  SUM(us.id IS NOT NULL AND ((c.beg_time<>us.beg_time) OR (c.int_time<>us.int_time) OR (c.exp_time<>us.exp_time)
    OR (c.beg_time IS NULL)<>(us.beg_time IS NULL) OR (c.int_time IS NULL)<>(us.int_time IS NULL)
    OR (c.exp_time IS NULL)<>(us.exp_time IS NULL))) time_diff,
  SUM(us.id IS NOT NULL AND ((c.beg_3bvs<>us.beg_3bvs) OR (c.int_3bvs<>us.int_3bvs) OR (c.exp_3bvs<>us.exp_3bvs)
    OR (c.beg_3bvs IS NULL)<>(us.beg_3bvs IS NULL) OR (c.int_3bvs IS NULL)<>(us.int_3bvs IS NULL)
    OR (c.exp_3bvs IS NULL)<>(us.exp_3bvs IS NULL))) bvs_diff
FROM calc c LEFT JOIN user_scores us ON us.id=c.uid
UNION ALL
SELECT CONCAT('user_scores orphan zero: ',
  (SELECT COUNT(*) FROM user_scores us WHERE us.id NOT IN (SELECT DISTINCT user FROM video WHERE status=20)
     AND (COALESCE(us.sum_time,0)>0 OR COALESCE(us.beg_time,0)>0 OR COALESCE(us.int_time,0)>0 OR COALESCE(us.exp_time,0)>0)),
  ' rows to clear') tbl, NULL, NULL, NULL, NULL, NULL;

-- ---------- 语句 B：user_scores_nf（仅 noflag=1） ----------
WITH
b_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='beg' AND vi.noflag=1 AND vi.real_time>0) x WHERE rn=1),
i_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='int' AND vi.noflag=1 AND vi.real_time>0) x WHERE rn=1),
e_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='exp' AND vi.noflag=1 AND vi.real_time>0) x WHERE rn=1),
b_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='beg' AND vi.noflag=1 AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
i_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='int' AND vi.noflag=1 AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
e_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='exp' AND vi.noflag=1 AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
calc AS (
  SELECT u.uid, b_t.rt beg_time, b_t.vid beg_time_video, b_t.ct beg_time_date,
         b_b.bvs beg_3bvs, b_b.vid beg_3bvs_video, b_b.ct beg_3bvs_date,
         i_t.rt int_time, i_t.vid int_time_video, i_t.ct int_time_date,
         i_b.bvs int_3bvs, i_b.vid int_3bvs_video, i_b.ct int_3bvs_date,
         e_t.rt exp_time, e_t.vid exp_time_video, e_t.ct exp_time_date,
         e_b.bvs exp_3bvs, e_b.vid exp_3bvs_video, e_b.ct exp_3bvs_date,
         IF(b_t.rt>0 AND i_t.rt>0 AND e_t.rt>0, b_t.rt+i_t.rt+e_t.rt, 0) sum_time,
         IF(b_b.bvs>0 AND i_b.bvs>0 AND e_b.bvs>0, b_b.bvs+i_b.bvs+e_b.bvs, 0) sum_3bvs
  FROM (SELECT DISTINCT user uid FROM video WHERE status=20 AND level='beg' AND EXISTS(SELECT 1 FROM video_info vi2 WHERE vi2.id=video.id AND vi2.noflag=1)
        UNION
        SELECT DISTINCT user uid FROM video WHERE status=20 AND level='int' AND EXISTS(SELECT 1 FROM video_info vi2 WHERE vi2.id=video.id AND vi2.noflag=1)
        UNION
        SELECT DISTINCT user uid FROM video WHERE status=20 AND level='exp' AND EXISTS(SELECT 1 FROM video_info vi2 WHERE vi2.id=video.id AND vi2.noflag=1)) u
  LEFT JOIN b_t ON b_t.uid=u.uid LEFT JOIN b_b ON b_b.uid=u.uid
  LEFT JOIN i_t ON i_t.uid=u.uid LEFT JOIN i_b ON i_b.uid=u.uid
  LEFT JOIN e_t ON e_t.uid=u.uid LEFT JOIN e_b ON e_b.uid=u.uid)
SELECT 'user_scores_nf' tbl,
  COUNT(*) calc_rows,
  SUM(us.id IS NULL) missing_row,
  SUM(us.id IS NOT NULL AND (c.beg_time<=>us.beg_time) AND (c.beg_3bvs<=>us.beg_3bvs)
    AND (c.int_time<=>us.int_time) AND (c.int_3bvs<=>us.int_3bvs)
    AND (c.exp_time<=>us.exp_time) AND (c.exp_3bvs<=>us.exp_3bvs)
    AND (c.sum_time<=>us.sum_time) AND (c.sum_3bvs<=>us.sum_3bvs)
    AND (c.beg_time_video<=>us.beg_time_video) AND (c.beg_3bvs_video<=>us.beg_3bvs_video)
    AND (c.int_time_video<=>us.int_time_video) AND (c.int_3bvs_video<=>us.int_3bvs_video)
    AND (c.exp_time_video<=>us.exp_time_video) AND (c.exp_3bvs_video<=>us.exp_3bvs_video)
    AND (c.beg_time_date<=>us.beg_time_date) AND (c.beg_3bvs_date<=>us.beg_3bvs_date)
    AND (c.int_time_date<=>us.int_time_date) AND (c.int_3bvs_date<=>us.int_3bvs_date)
    AND (c.exp_time_date<=>us.exp_time_date) AND (c.exp_3bvs_date<=>us.exp_3bvs_date)) full_match,
  SUM(us.id IS NOT NULL AND ((c.beg_time<>us.beg_time) OR (c.int_time<>us.int_time) OR (c.exp_time<>us.exp_time)
    OR (c.beg_time IS NULL)<>(us.beg_time IS NULL) OR (c.int_time IS NULL)<>(us.int_time IS NULL)
    OR (c.exp_time IS NULL)<>(us.exp_time IS NULL))) time_diff,
  SUM(us.id IS NOT NULL AND ((c.beg_3bvs<>us.beg_3bvs) OR (c.int_3bvs<>us.int_3bvs) OR (c.exp_3bvs<>us.exp_3bvs)
    OR (c.beg_3bvs IS NULL)<>(us.beg_3bvs IS NULL) OR (c.int_3bvs IS NULL)<>(us.int_3bvs IS NULL)
    OR (c.exp_3bvs IS NULL)<>(us.exp_3bvs IS NULL))) bvs_diff
FROM calc c LEFT JOIN user_scores_nf us ON us.id=c.uid
UNION ALL
SELECT CONCAT('user_scores_nf orphan zero: ',
  (SELECT COUNT(*) FROM user_scores_nf us WHERE us.id NOT IN (
     SELECT DISTINCT v.user FROM video v JOIN video_info vi ON vi.id=v.id
     WHERE v.status=20 AND vi.noflag=1)
     AND (COALESCE(us.sum_time,0)>0 OR COALESCE(us.beg_time,0)>0 OR COALESCE(us.int_time,0)>0 OR COALESCE(us.exp_time,0)>0)),
  ' rows to clear') tbl, NULL, NULL, NULL, NULL, NULL;
