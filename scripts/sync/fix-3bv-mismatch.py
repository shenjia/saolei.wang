#!/usr/bin/env python3
# 3BV 口径修正（2026-10-23 张老师批准）：71 条 video_info.board_3bv 库值 ≠ 文件头自报真值
# 来源：docs/3bv-mismatch-71.csv（scripts/check-3bv-one.ts 全库扫描产物，308778 条对文件核对）
#
# 本脚本只做第一步：UPDATE video_info.board_3bv（以及联动 level_3bv_range 收缩）。
# 后续派生表重算走既有工具链（按顺序）：
#   1. scripts/sync/apply-user-video-scores.sh   —— video_scores_* 6 表全量重算（模板含事务）
#   2. scripts/sync/apply-user-scores.sh          —— user_scores(_nf) 全量重算
#   3. scripts/rank-snapshot-refresh.ts --force   —— rank_snapshot/user_rank 对齐（rebuildUserRanks）
#   4. scripts/video-metrics.ts --ids-file=...    —— 71 条 video_metrics 定点重算（含分位/综合/排名/stnb 榜）
#      注：video-metrics 定点模式会顺带 rebuildUserStnbBest 全量重建 + rank 重排
#
# 用法：
#   本地（演练/执行）：python3 scripts/sync/fix-3bv-mismatch.py [--dry]
#   生产：ssh 后同样命令（先备份 video_info 相关列）
#
# 幂等：UPDATE 带 WHERE board_3bv=旧值 条件，重跑安全；已是新值时 0 rows affected。

import csv
import subprocess
import sys
import os

DB = "saolei"
HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "..", "..", "docs", "3bv-mismatch-71.csv")

DRY = "--dry" in sys.argv


def mysql_exec(sql: str) -> str:
    """执行 SQL 返回 stdout（--dry 时只打印）"""
    if DRY:
        print(f"[dry] {sql[:120]}...")
        return ""
    r = subprocess.run(
        ["mysql", "-uroot", DB, "-N", "-e", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise SystemExit(f"SQL 失败: {sql[:200]}\n{r.stderr}")
    return r.stdout


def main():
    rows = []
    with open(CSV, newline="") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            rows.append(row)
    print(f"清单载入：{len(rows)} 条（来源 {os.path.relpath(CSV, HERE)}）")

    # 逐条校验后 UPDATE（WHERE 带旧值防二次跑偏移）
    ok = skip = gone = 0
    for row in rows:
        vid = int(row["id"])
        old = int(row["db_3bv"])
        new = int(row["header_3bv"])  # 文件头自报 = 八连通真值
        # 先核对库内现值仍等于扫描时的旧值（防期间被别的操作改过）
        cur = mysql_exec(f"SELECT board_3bv FROM video_info WHERE id={vid}").strip()
        if cur == "":
            print(f"  ✗ id={vid} 不存在，跳过")
            gone += 1
            continue
        if int(cur) == new:
            skip += 1  # 已是新值（重跑）
            continue
        if int(cur) != old:
            print(f"  ✗ id={vid} 库值 {cur} ≠ 扫描旧值 {old}，期间被改动，跳过并人工核查")
            gone += 1
            continue
        mysql_exec(f"UPDATE video_info SET board_3bv={new} WHERE id={vid} AND board_3bv={old}")
        ok += 1

    print(f"\nboard_3bv 修正：{ok} 条更新，{skip} 条已是新值，{gone} 条异常跳过")

    # level_3bv_range 联动（只扩不缩语义是审核路径的；这里是数据修正，反向收缩一次）：
    # 修正后的真实区间 = status=20 的 board_3bv MIN/MAX（下限仍按 LEVEL_MIN_3BV 钳制：
    # 初 2 / 中 30 / 高 100 —— 与 review.ts 的写入语义一致）
    print("\n收缩 level_3bv_range（按修正后真实区间 + LEVEL_MIN_3BV 下限钳制）：")
    q = """
SELECT v.level,
       GREATEST(MIN(vi.board_3bv), CASE v.level WHEN 'beg' THEN 2 WHEN 'int' THEN 30 ELSE 100 END) mn,
       MAX(vi.board_3bv) mx
FROM video v JOIN video_info vi ON vi.id = v.id
WHERE v.status = 20
GROUP BY v.level
"""
    out = mysql_exec(q)
    for line in out.strip().splitlines():
        if not line.strip():
            continue
        level, mn, mx = line.split("\t")
        # 只缩不扩（GREATEST 防回抬、LEAST 防扩边）——与既有行比较
        cur = mysql_exec(f"SELECT min_3bv, max_3bv FROM level_3bv_range WHERE level='{level}'").strip()
        if not cur:
            print(f"  {level}: 无行，跳过（页面会自愈播种）")
            continue
        cur_mn, cur_mx = (int(x) for x in cur.split("\t"))
        new_mn, new_mx = max(mn, cur_mn) if cur_mn > int(mn) else int(mn), min(int(mx), cur_mx) if cur_mx < int(mx) else int(mx)
        # 语义：收缩 = min 取大者、max 取小者（相对旧值），但不越过真实区间
        final_mn = max(cur_mn, int(mn))
        final_mx = min(cur_mx, int(mx))
        if (final_mn, final_mx) != (cur_mn, cur_mx):
            mysql_exec(
                f"UPDATE level_3bv_range SET min_3bv={final_mn}, max_3bv={final_mx}, "
                f"update_time=UNIX_TIMESTAMP() WHERE level='{level}'"
            )
            print(f"  {level}: ({cur_mn},{cur_mx}) → ({final_mn},{final_mx})")
        else:
            print(f"  {level}: ({cur_mn},{cur_mx}) 无需收缩")

    # 抽查报告
    print("\n抽查（应全部 等于 header）：")
    for vid in (85419, 106039, 110987, 80026, 327251):
        out = mysql_exec(
            f"SELECT vi.board_3bv FROM video_info vi WHERE vi.id={vid}"
        ).strip()
        print(f"  id={vid} → {out}")


if __name__ == "__main__":
    main()
