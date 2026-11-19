-- VS 对决历史回填（2026-11-11）：page_view 里的 /vs/:id 访问导入 vs_duel。
-- · 仅部署前历史行（create_time < :cutoff）；部署后的新访问由 /vs 页服务端直接落库（带比分）
-- · 去重：同 (user_id, target_id) 10 分钟固定桶取首访（MIN(create_time)），防刷新虚高
-- · 回填行 s1/s2/result 为 NULL（比分未在当时落库，展示层亮灰 —）
-- · user_id>0（未登录被 redirect 不产生 /vs 访问）、剔管理员与爬虫
-- 用法：mysql <db> -e "SET @cutoff=<部署完成Unix秒>; SOURCE scripts/backfill-vs-duels.sql"
-- 或 sed 替换后整文件执行。

INSERT INTO vs_duel (user_id, target_id, s1, s2, result, create_time)
SELECT user_id,
       CAST(SUBSTRING(path, 5) AS UNSIGNED) AS target_id,
       NULL, NULL, NULL,
       MIN(create_time)
FROM page_view
WHERE path REGEXP '^/vs/[0-9]+$'
  AND user_id IS NOT NULL AND user_id > 0
  AND is_admin = 0
  AND ua_class <> 'bot'
  AND create_time < @cutoff
GROUP BY user_id, target_id, FLOOR(create_time / 600);
