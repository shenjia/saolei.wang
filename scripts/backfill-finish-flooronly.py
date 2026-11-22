#!/usr/bin/env python3
"""完赛动态（type=59）存量回填（2026-11-22 张老师定首页口径改造）：

背景：完赛动态写入点原逻辑是「有成绩落 details={score}、无成绩落 details={}」，
且总分不含「是否纯保底」标记。首页新闻流 2026-11-22 扩入 type=59 后暴露两类脏行：
  ① details={} 的空行（窗口内一盘有效录像都没有，如杨鼎 1266620 / 邱富城 1266621 /
     闻璐 1266617；陆行健 1267291 是补写时指标未就绪，后补了录像）——「已完赛！」
     空行没有信息量，直接删除（比赛侧 type=6 事件保留，详情页动态不受影响）；
  ② 总分全是保底凑的（实盘 0 局，score 全靠 floor 补足）——按新写入点口径补
     floorOnly:true 标记，首页按标记过滤；已有实盘成绩的不动。

写入点新口径（同 commit）：有成绩落 details={score, floorOnly}，无成绩不发动态。
本脚本幂等：空 details 行删到没有为止；floorOnly 标记已存在则跳过。

用法：
  python3 scripts/backfill-finish-flooronly.py --dry-run   # 只打印将做的事
  python3 scripts/backfill-finish-flooronly.py             # 真正执行
"""
import argparse
import json
import os
import sys

import pymysql


def connect():
    """连接约定同 scripts/sync/*.py：SAOLEI_DB_HOST/PORT/USER/PASSWORD/NAME env
    （本地默认 root@localhost 免密；生产走 SAOLEI_DB_PASSWORD）。"""
    host = os.environ.get("SAOLEI_DB_HOST", "localhost")
    user = os.environ.get("SAOLEI_DB_USER", "root")
    password = os.environ.get("SAOLEI_DB_PASSWORD", "")
    name = os.environ.get("SAOLEI_DB_NAME", "saolei")
    port = int(os.environ.get("SAOLEI_DB_PORT", "3306"))
    return pymysql.connect(
        host=host, port=port, user=user, password=password, database=name,
        charset="utf8mb4", autocommit=False,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印将做的事，不写库")
    args = ap.parse_args()

    db = connect()
    cur = db.cursor()

    # 1) 空 details 行：直接删
    cur.execute(
        "SELECT id, user, reference, FROM_UNIXTIME(create_time) FROM news "
        "WHERE type=59 AND (details_data='{}' OR details_data='')"
    )
    empty_rows = cur.fetchall()
    for nid, uid, ref, t in empty_rows:
        print(f"[删除空行] id={nid} user={uid} tour={ref} time={t}")

    # 2) 有 score 的行：重算窗口总分判定纯保底，补 floorOnly:true
    #    判定口径与写入点 computeWindowScore 一致：calc 各级别 real=0 且 fill>0 → 纯保底
    cur.execute(
        "SELECT n.id, n.user, n.reference, n.details_data FROM news n "
        "JOIN tournament t ON t.id = n.reference "
        "WHERE n.type=59 AND n.details_data LIKE '%\"score\"%' "
        "AND n.details_data NOT LIKE '%floorOnly%'"
    )
    scored_rows = cur.fetchall()

    def window_floor_only(cid: int, uid: int, score: int) -> bool:
        """按比赛口径重算该玩家窗口总分：实盘部分 real==0 即纯保底。
        简化判定：不重放完整 computePlayerScores，只看窗口内有无**计入总分**的有效实盘——
        各收录级别 topn>0 且录像指标有效（value>0 且非 noRecord）。有任何一盘即非纯保底。
        （topn=0 的级别不收实盘，盘数再多也不影响，不需要查。）"""
        cur.execute(
            "SELECT score_mode, score_config, include_levels, window_hours "
            "FROM tournament WHERE id=%s",
            (cid,),
        )
        row = cur.fetchone()
        if not row or not row[3]:
            return False  # 非窗口赛（不应出现，防御）
        mode, cfg, levels = row[0], row[1], row[2]
        try:
            conf = json.loads(cfg) if cfg else {}
        except json.JSONDecodeError:
            return False
        metric = conf.get("metric", "time")
        topn = {k: int(conf.get(k, 0) or 0) for k in ("beg", "int", "exp")}
        inc = [s.strip() for s in (levels or "beg,int,exp").split(",") if s.strip()]
        # 各收录级别取最好 N 局所需的录像数（全部有效实盘）
        cond_lv = ",".join("'%s'" % lv for lv in inc if topn.get(lv, 0) > 0)
        if not cond_lv:
            return True  # 没有任何级别计分 → 总分只能是保底（防御）
        if metric == "time":
            val_expr = "IF(vi.no_record=1, 0, vi.real_time)"
        elif metric == "3bv":
            val_expr = "IF(vi.no_record=1, 0, vi.board_3bv*1000)"
        else:
            col = {"3bvs": "bvs", "ioe": "ioe", "thrp": "thrp", "cp": "cp"}.get(metric)
            if not col:
                return False
            val_expr = f"IF(vi.no_record=1, 0, IF(vm.{col}>0, vm.{col}*1000, 0))"
        cur.execute(
            "SELECT COUNT(*) FROM video v "
            f"LEFT JOIN video_info vi ON vi.id=v.id LEFT JOIN video_metrics vm ON vm.id=v.id "
            f"WHERE v.competition_id=%s AND v.user=%s AND v.status<>0 AND v.level IN ({cond_lv}) "
            f"AND {val_expr} > 0",
            (cid, uid),
        )
        real_count = cur.fetchone()[0]
        return real_count == 0

    changed = 0
    for nid, uid, ref, details in scored_rows:
        try:
            d = json.loads(details)
        except json.JSONDecodeError:
            continue
        score = d.get("score")
        if not isinstance(score, (int, float)):
            continue
        if window_floor_only(int(ref), int(uid), int(score)):
            d["floorOnly"] = True
            new_details = json.dumps(d, separators=(",", ":"))
            print(f"[补floorOnly] id={nid} user={uid} tour={ref} score={score} → {new_details}")
            if not args.dry_run:
                cur.execute("UPDATE news SET details_data=%s WHERE id=%s", (new_details, nid))
            changed += 1
        else:
            print(f"[不动] id={nid} user={uid} tour={ref} score={score}（有实盘成绩）")

    if args.dry_run:
        print(f"--- dry-run：将删 {len(empty_rows)} 行空动态、改 {changed} 行补标记 ---")
    else:
        if empty_rows:
            ids = ",".join(str(r[0]) for r in empty_rows)
            cur.execute(f"DELETE FROM news WHERE id IN ({ids})")
        db.commit()
        print(f"--- 完成：删 {cur.rowcount and len(empty_rows) or 0} 行、补标记 {changed} 行 ---")
    db.close()


if __name__ == "__main__":
    main()
