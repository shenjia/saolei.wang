-- 元扫雷 software/version 拆分回填（2026-10-30 张老师）
-- 背景：evf 自报「元3.3.4」曾整体写入 video_info.software（后展示归一为「元扫雷3.3.4」），
--       软件名与版本号混存。拆分后对齐旧站语义：software=纯软件名「元扫雷」、
--       version=软件版本（3.3.4）——原 version 列的「0.x」是 EVF 格式版本，属错位数据，直接覆盖。
-- 幂等：只命中「元(扫雷)?+数字」的混合行；已拆分行（software='元扫雷'）不再命中。
-- 生产 2026-10-30 查证：video_info 无「元%」行（元扫雷尚未有真实上传），本脚本为保险兜底。

-- ⚠️ MySQL 的 SET 从左到右求值、后面的赋值会读到前面已更新的列——version 必须写在
-- software 之前（先从原 software 抠出版本号，再覆写 software），顺序颠倒会得到空 version。
UPDATE video_info
SET version  = REGEXP_REPLACE(software, '^元(扫雷)?', ''),
    software = '元扫雷'
WHERE software REGEXP '^元(扫雷)?[0-9]';
