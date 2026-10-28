-- 本BV标记回填（2026-10-28 张老师需求）：video.first_bv / video.pb_bv
-- 口径（与上传时判定完全同源）：
--   池 = 同 user + 同 level + 同 board_3bv，只计 status<>0（待审10/通过20，屏蔽0不计）
--   时间序 = (create_time, id)——与个人纪录/收集语义一致
--   first_bv=1：池内首盘（本玩家首次完成本 BV）
--   pb_bv=1：非首盘且 real_time 严格小于池内此前所有盘的最小 real_time（打破本BV最好成绩）
-- 幂等：可重复执行（全量重算这两列）。生产执行：mysql saolei < 本文件
UPDATE video v
JOIN (
  SELECT id,
    CASE WHEN rn = 1 THEN 1 ELSE 0 END AS fb,
    CASE WHEN rn > 1 AND real_time > 0
          AND real_time < MIN(real_time) OVER (
                PARTITION BY uid, lvl, b3bv
                ORDER BY ct, id
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
         THEN 1 ELSE 0 END AS pb
  FROM (
    SELECT v.id, v.`user` uid, v.level lvl, vi.board_3bv b3bv, vi.real_time real_time,
           v.create_time ct,
           ROW_NUMBER() OVER (
             PARTITION BY v.`user`, v.level, vi.board_3bv
             ORDER BY v.create_time, v.id) AS rn
    FROM video v
    JOIN video_info vi ON vi.id = v.id
    WHERE v.status <> 0
  ) t
) w ON w.id = v.id
SET v.first_bv = w.fb,
    v.pb_bv = w.pb;
