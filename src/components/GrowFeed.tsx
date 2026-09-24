// 进步榜「加载更多」交互（2026-09-24 张老师要求：玩家展示样式与雷界排行一致）：
// 表格复用 RankingRows 行渲染（排名=今日总计时间名次、姓名+军衔+8 列成绩、尾列=日升降），
// 底部 more_loader「加载更多」（替代翻页）；无搜索框/「我在哪里」（榜序按升降幅度，不走定位）。

"use client";

import { useState } from "react";
import type { GrowRow } from "@/lib/ranksnap";
import { totalLabel } from "@/lib/format";
import { noFocusJump } from "./useKeepScroll";
import { RANKING_COLS, RankingRowLine, type TitledRow } from "./RankingRows";

export function GrowFeed({
  initial,
  total,
  pageSize,
}: {
  initial: (GrowRow & { title: string })[];
  total: number;
  pageSize: number;
}) {
  const [rows, setRows] = useState(initial);
  const [nextPage, setNextPage] = useState(2);
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState("");

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    setHint("");
    try {
      const res = await fetch(`/api/grow/more?page=${nextPage}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: TitledRow[] };
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      setRows((prev) => [...prev, ...(data.rows as (GrowRow & { title: string })[])]);
      setNextPage((p) => p + 1);
      if (rows.length + data.rows.length >= total) setLoadedAll(true);
    } catch {
      setHint("加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <table cellPadding={0} cellSpacing={0} className="ranking_table">
        <thead>
          <tr>
            <th>排名</th>
            <th>姓名</th>
            <th>军衔</th>
            {RANKING_COLS.map((c) => (
              <th key={c.by}>{c.label}</th>
            ))}
            {/* 榜序按日升降幅度（非成绩列排序），升降表头黄标 */}
            <th className="current">升降</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            /* by 传 null：进步榜不按成绩列排序，任何成绩列都不做排序高亮 */
            <RankingRowLine key={u.id} row={u} by={null} delta={u.delta} showDelta />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} style={{ textAlign: "center" }}>
                快照数据积累两天后开始有进步榜。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="more_loader ranking_loader">
        {loadedAll ? (
          <span className="all_loaded">已加载全部</span>
        ) : (
          <button
            type="button"
            className="button small"
            disabled={loading}
            onMouseDown={noFocusJump}
            onClick={loadMore}
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        )}
        <span className="total_count">{totalLabel(total, "位")}</span>
        {hint && <span className="loader_hint">{hint}</span>}
      </div>
    </>
  );
}
