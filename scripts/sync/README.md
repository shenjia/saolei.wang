# 旧站 MSSQL → MySQL 同步管线

从线上 2008 ASP 版（SaoleiNet 库）同步数据到本地 `saolei` 库。
2026-09-23 首次全量同步完成（基线：2013-10-23 的 2019 dump + 此后 13 年增量）。

## 用法

```bash
export SAOLEI_MSSQL_HOST=<旧站库地址>   # 必填（原默认值已移除，凭据不入库）
export SAOLEI_MSSQL_USER=<只读账号>     # 必填
export SAOLEI_MSSQL_PASS=<密码>         # 必填,只读账号
PY=/Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python
$PY extract.py     # MSSQL → staging 库 saolei_mssql(全量,断点续传,重跑先 DROP 表)
$PY transform.py   # staging → saolei(幂等 upsert;news 段有守卫,已插则跳过)
$PY fixup.py       # 修复:补 video_info、删孤儿录像、清 video_scores 残留
$PY validate.py    # 行数对账 + 抽样字段比对 + 排行对照
$PY backfill-banned-users.py --dry-run   # 只统计不写库
$PY backfill-banned-users.py             # 补导旧站「停用」账号(见下)
```

`backfill-banned-users.py` 是补丁脚本，只在需要时跑：把旧站 `Player_IsLive=0` 的账号
补进新站用户域（`user.status=-1`）。**唯一权威口径是旧站停用状态**，幂等，可反复跑；
它只做单向「封禁」，不会把新站的解封刷回去。

依赖：`pip install python-tds pymysql`（已装入 managed venv `envs/default`）。

## 关键映射规则（与 2013 版迁移逐字段验证一致）

- **用户全量导入**（2026-10-14 起，原为 `WHERE Player_IsLive=1`）：`Player_IsLive=0` 是旧站
  **「停用」开关**（`Player/Action/Live_Action.asp` 可逆切换，≠删号），这些账号必须导——
  否则其录像/评论/帖子在新站成无主引用（曾致 2844 条录像详情页显示不出上传者）。
  新站映射为 `user.status = -1`（封禁语义＝仅禁止登录，成绩/录像/名字全保留）。
  **已存在行的 status 不被 transform 覆盖**——免得旧站 `IsLive=1` 把新站后台手动封禁的账号刷回正常；
  旧站新停用的老账号靠重跑 `backfill-banned-users.py` 回填
- **时间成绩 = (MSSQL 秒值 - 1) × 1000**（mvf/avf 均如此，计时器从 1 起跳）；3BVS = 值 × 1000
- 成绩 `999.99` 为无成绩哨兵 → NULL，sum 由三级别加总（缺一级 = 0）
- 录像状态：`IsLive=0 → 0 屏蔽`；`Check=0 → 10 待审`；否则 `20 通过`

- 时间戳：MSSQL datetime 视为 +08:00 转 Unix 秒
- `_nf` 表归属以**文件解析的 `video_info.noflag` 为准**（老录像 MSSQL `IsNoFrag` 位不可靠，差 ~1.9k 条）
- news 插入必须保持 **id 序 = create_time 序**（前端游标分页按 id）；非幂等，重插需先删 `create_time > 1382487826`
- MySQL 保留字坑：`year_month`（INTERVAL 关键字）必须加反引号；MSSQL varchar 有非法 GBK 字节，须服务端 `CAST(... AS NVARCHAR(4000))` 抽取
- 密码：`md5(Player_Password明文 + salt)`，仅对新用户生成，不动已有账号

## 待办（Phase B）

- 从旧站 HTTP 下载 ~25 万个新录像实体文件（`/Video/Mvf/{uid}/{name}.{mvf,avf}`，平均 ~1KB）
  → 按 `videos/YYYY/MM/DD/<md5>.<ext>` 落盘，回填 `video.hash`、`video_info.filepath/board/software/version/signature`、`user_sig`
- `click` 表 819 万行历史人气明细**确认不补**（2026-10-14 方案 B 定案）：旧站 `Click` 明细最早仅到 2017-02-07（表曾重建），早期历史只存在于 `Player.Player_Click` 累计值里，补明细也拼不出完整历史；且旧站 9-23 新站上线后仍在记（+9.5 万条，绝大多数是 Googlebot/百度蜘蛛）。故人气**总量**以 `user_stat.clicks` 为准（由本管线第 202 行从 `Player_Click` 刷入），`click` 明细表在新站仅承担「今日人气」与「同 IP 同日去重」职责。`Player_Click` 是 float 且带脏小数尾巴（小数恰为 `Player_Id×1e-9`），取整即可
- `star` 每日一星无历史（MSSQL 仅存当日）
