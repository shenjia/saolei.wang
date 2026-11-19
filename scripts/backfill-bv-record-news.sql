-- BV 收集动态补发（2026-11-19 张老师需求，type=57）
--
-- 背景：BV 收集动态（type=57）2026-11-19 上线，发布点在 review.ts REVIEWED 分支
-- （过审时发布）。上线前的历史 first_bv/pb_bv 标记无动态，按张老师口径补发
-- 2026-10-01 起的标记行（更早的历史不补，动态无链语义不补不断链，
-- 历史信息在录像列表角标/收集墙/收集格里本来就有）。
--
-- 落库口径（与 src/lib/review.ts BV 发布分支严格同源）：
--   范围   = video.first_bv=1 OR pb_bv=1，status<>0（屏蔽 0 不发），
--            video_info.no_record=0（运气盘不进收集体系），
--            create_time >= UNIX_TIMESTAMP('2026-10-01')
--   kind   = first_bv=1 → "first"；否则 pb_bv=1 → "pb"
--   or     = pb 行：按上传序 (create_time,id) 池内前序 MIN(real_time)
--            （池=同 user+level+board_3bv，status<>0）——与 review.ts 重算口径一致
--   cr     = video_info.real_time
--   bv     = board_3bv
--   lv     = video.level
--   exp_time / ranked 快照 = user_scores.exp_time 当前值 / user.status=0（当下值，
--            同 backfill-enlist-records.py「历史快照不可重建取当下值」惯例）
--   create_time = 录像上传时间（同 PERSON_RECORD 口径）
--
-- 幂等：NOT EXISTS 同 (reference, type=57) 行——重审翻案补发/重复执行天然跳过。
-- 排除：video 已物理删除的不存在（reference 悬空不可能产生）。
--
-- 用法：mysql saolei < scripts/backfill-bv-record-news.sql
--       （生产先跑 SELECT 段核对条数，再执行 INSERT 段）

-- ===== 预览（执行前核对：预期 275 条上下，first/pb 构成 130/145）=====
SELECT COUNT(*) AS to_insert,
       SUM(w.fb = 1) AS first_rows,
       SUM(w.pb = 1) AS pb_rows
FROM video v
JOIN video_info vi ON vi.id = v.id
JOIN (
  SELECT id,
    CASE WHEN rn = 1 THEN 1 ELSE 0 END AS fb,
    CASE WHEN rn > 1 THEN 1 ELSE 0 END AS pb,
    LAG(real_time) OVER (
      PARTITION BY uid, lvl, b3bv
      ORDER BY ct, id) AS prev_best
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
LEFT JOIN news n ON n.reference = v.id AND n.type = 57
WHERE (v.first_bv = 1 OR v.pb_bv = 1)
  AND vi.no_record = 0
  AND v.create_time >= UNIX_TIMESTAMP('2026-10-01')
  AND n.id IS NULL;

-- ===== 补发 INSERT（INSERT ... SELECT 幂等）=====
INSERT INTO news (type, `user`, reference, details_data, exp_time, ranked, create_time)
SELECT
  57,
  v.`user`,
  v.id,
  CONCAT(
    '{"lv":"', v.level, '","kind":"', IF(v.first_bv = 1, 'first', 'pb'),
    '","or":', IF(v.first_bv = 1, 0,
      IFNULL((SELECT MIN(vi2.real_time)
              FROM video v2
              JOIN video_info vi2 ON vi2.id = v2.id
              WHERE v2.`user` = v.`user` AND v2.level = v.level
                AND vi2.board_3bv = vi.board_3bv
                AND v2.status <> 0
                AND (v2.create_time < v.create_time
                  OR (v2.create_time = v.create_time AND v2.id < v.id))), 0)),
    ',"cr":', vi.real_time,
    ',"bv":', vi.board_3bv, '}'
  ),
  IFNULL(us.exp_time, 0),
  IF(u.status = 0, 1, 0),
  v.create_time
FROM video v
JOIN video_info vi ON vi.id = v.id
JOIN `user` u ON u.id = v.`user`
LEFT JOIN user_scores us ON us.id = v.`user`
WHERE (v.first_bv = 1 OR v.pb_bv = 1)
  AND v.status <> 0
  AND vi.no_record = 0
  AND v.create_time >= UNIX_TIMESTAMP('2026-10-01')
  AND NOT EXISTS (
    SELECT 1 FROM news n WHERE n.reference = v.id AND n.type = 57
  );

-- ===== 核对（执行后：首收绿✓/破PB金提升构成 + 抽样行）=====
SELECT SUM(JSON_EXTRACT(details_data, '$.kind') = 'first') AS first_rows,
       SUM(JSON_EXTRACT(details_data, '$.kind') = 'pb') AS pb_rows,
       COUNT(*) AS total
FROM news WHERE type = 57;

SELECT n.id, n.user, n.reference, n.details_data, n.create_time
FROM news n WHERE n.type = 57 ORDER BY n.id DESC LIMIT 10;
