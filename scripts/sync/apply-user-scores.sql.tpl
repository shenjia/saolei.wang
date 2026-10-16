-- apply 模板（勿直接执行）：:TBL=目标表（user_scores / user_scores_nf），:NF=0（主表，不筛 NF）或 1（NF 表，仅 noflag=1）
-- 由 scripts/sync/apply-user-scores.sh 用 sed 替换后经 mysql 执行（调用方负责 BEGIN/COMMIT 与备份）
USE :DB;

-- 1) 有通过录像的用户：补缺行 + 全字段覆盖
INSERT INTO :TBL
  (id, beg_time, beg_3bvs, int_time, int_3bvs, exp_time, exp_3bvs, sum_time, sum_3bvs,
   beg_time_video, beg_3bvs_video, int_time_video, int_3bvs_video, exp_time_video, exp_3bvs_video,
   beg_time_date, beg_3bvs_date, int_time_date, int_3bvs_date, exp_time_date, exp_3bvs_date,
   create_time, update_time)
WITH
b_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='beg' AND (:NF=0 OR vi.noflag=1) AND vi.real_time>0) x WHERE rn=1),
i_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='int' AND (:NF=0 OR vi.noflag=1) AND vi.real_time>0) x WHERE rn=1),
e_t AS (SELECT uid, vid, rt, ct FROM (SELECT v.user uid, v.id vid, vi.real_time rt, v.create_time ct,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY vi.real_time ASC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='exp' AND (:NF=0 OR vi.noflag=1) AND vi.real_time>0) x WHERE rn=1),
b_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='beg' AND (:NF=0 OR vi.noflag=1) AND vi.real_time>0 AND vi.board_3bv>=11) x WHERE rn=1),
i_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='int' AND (:NF=0 OR vi.noflag=1) AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
e_b AS (SELECT uid, vid, bvs, ct FROM (SELECT v.user uid, v.id vid, v.create_time ct,
           ROUND(vi.board_3bv*1000000/vi.real_time) bvs,
           ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY ROUND(vi.board_3bv*1000000/vi.real_time) DESC, v.id ASC) rn
         FROM video v JOIN video_info vi ON vi.id=v.id
         WHERE v.status=20 AND v.level='exp' AND (:NF=0 OR vi.noflag=1) AND vi.real_time>0 AND vi.board_3bv>=4) x WHERE rn=1),
calc AS (
  SELECT u.uid, b_t.rt beg_time, b_t.vid beg_time_video, b_t.ct beg_time_date,
         b_b.bvs beg_3bvs, b_b.vid beg_3bvs_video, b_b.ct beg_3bvs_date,
         i_t.rt int_time, i_t.vid int_time_video, i_t.ct int_time_date,
         i_b.bvs int_3bvs, i_b.vid int_3bvs_video, i_b.ct int_3bvs_date,
         e_t.rt exp_time, e_t.vid exp_time_video, e_t.ct exp_time_date,
         e_b.bvs exp_3bvs, e_b.vid exp_3bvs_video, e_b.ct exp_3bvs_date,
         IF(b_t.rt>0 AND i_t.rt>0 AND e_t.rt>0, b_t.rt+i_t.rt+e_t.rt, 0) sum_time,
         IF(b_b.bvs>0 AND i_b.bvs>0 AND e_b.bvs>0, b_b.bvs+i_b.bvs+e_b.bvs, 0) sum_3bvs
  FROM (SELECT DISTINCT v.user uid FROM video v
        WHERE v.status=20 AND (:NF=0 OR EXISTS(SELECT 1 FROM video_info vi3 WHERE vi3.id=v.id AND vi3.noflag=1))) u
  LEFT JOIN b_t ON b_t.uid=u.uid LEFT JOIN b_b ON b_b.uid=u.uid
  LEFT JOIN i_t ON i_t.uid=u.uid LEFT JOIN i_b ON i_b.uid=u.uid
  LEFT JOIN e_t ON e_t.uid=u.uid LEFT JOIN e_b ON e_b.uid=u.uid)
SELECT uid, beg_time, beg_3bvs, int_time, int_3bvs, exp_time, exp_3bvs, sum_time, sum_3bvs,
       beg_time_video, beg_3bvs_video, int_time_video, int_3bvs_video, exp_time_video, exp_3bvs_video,
       beg_time_date, beg_3bvs_date, int_time_date, int_3bvs_date, exp_time_date, exp_3bvs_date,
       UNIX_TIMESTAMP(), UNIX_TIMESTAMP()
FROM calc
ON DUPLICATE KEY UPDATE
  beg_time=VALUES(beg_time), beg_3bvs=VALUES(beg_3bvs),
  int_time=VALUES(int_time), int_3bvs=VALUES(int_3bvs),
  exp_time=VALUES(exp_time), exp_3bvs=VALUES(exp_3bvs),
  sum_time=VALUES(sum_time), sum_3bvs=VALUES(sum_3bvs),
  beg_time_video=VALUES(beg_time_video), beg_3bvs_video=VALUES(beg_3bvs_video),
  int_time_video=VALUES(int_time_video), int_3bvs_video=VALUES(int_3bvs_video),
  exp_time_video=VALUES(exp_time_video), exp_3bvs_video=VALUES(exp_3bvs_video),
  beg_time_date=VALUES(beg_time_date), beg_3bvs_date=VALUES(beg_3bvs_date),
  int_time_date=VALUES(int_time_date), int_3bvs_date=VALUES(int_3bvs_date),
  exp_time_date=VALUES(exp_time_date), exp_3bvs_date=VALUES(exp_3bvs_date),
  update_time=UNIX_TIMESTAMP();

-- 2) 无任何通过录像的存量行：清零（全屏蔽/老站遗留，2026-10-15 口径）
UPDATE :TBL us
LEFT JOIN (SELECT DISTINCT v.user uid FROM video v
           WHERE v.status=20 AND (:NF=0 OR EXISTS(SELECT 1 FROM video_info vi3 WHERE vi3.id=v.id AND vi3.noflag=1))) c
  ON c.uid = us.id
SET us.beg_time=NULL, us.beg_3bvs=NULL, us.int_time=NULL, us.int_3bvs=NULL,
    us.exp_time=NULL, us.exp_3bvs=NULL, us.sum_time=0, us.sum_3bvs=0,
    us.beg_time_video=NULL, us.beg_3bvs_video=NULL, us.int_time_video=NULL, us.int_3bvs_video=NULL,
    us.exp_time_video=NULL, us.exp_3bvs_video=NULL,
    us.beg_time_date=NULL, us.beg_3bvs_date=NULL, us.int_time_date=NULL, us.int_3bvs_date=NULL,
    us.exp_time_date=NULL, us.exp_3bvs_date=NULL,
    us.update_time=UNIX_TIMESTAMP()
WHERE c.uid IS NULL
  AND (COALESCE(us.sum_time,0)>0 OR COALESCE(us.beg_time,0)>0 OR COALESCE(us.int_time,0)>0
    OR COALESCE(us.exp_time,0)>0 OR COALESCE(us.beg_3bvs,0)>0 OR COALESCE(us.int_3bvs,0)>0
    OR COALESCE(us.exp_3bvs,0)>0 OR COALESCE(us.sum_3bvs,0)>0);
