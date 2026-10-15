-- video_scores_* 重算模板（2026-10-15 口径统一：老站实证 = ROUND、全量不筛 board、正值）
-- 占位符：:DB 库名 | :TBL 表尾（beg/int/exp/beg_nf/...）| :LVL 级别 | :NFFLAG 0=主表 1=NF
-- 口径（MSSQL 浮点实证 + 老表 74730/74808 eq_round）：
--   范围 = status=20 AND level=:LVL（NF 表额外 noflag=1）AND real_time>0
--   score_time = real_time；score_3bvs = ROUND(board_3bv*1e6/real_time)（正，不筛 board_3bv）
--   create_time = video.create_time（实证老表与 video 全量一致）
--   全量 DELETE+INSERT 单事务重建（纯派生表；InnoDB MVCC 下读方无中间态）
START TRANSACTION;
DELETE FROM :DB.video_scores_:TBL;
INSERT INTO :DB.video_scores_:TBL (id, user, score_time, score_3bvs, create_time)
SELECT v.id, v.user, vi.real_time, ROUND(vi.board_3bv*1000000/vi.real_time), v.create_time
FROM :DB.video v JOIN :DB.video_info vi ON vi.id=v.id
WHERE v.status=20 AND v.level=':LVL' AND (:NFFLAG=0 OR vi.noflag=1) AND vi.real_time>0;
COMMIT;
