// 全级别排行表（服务端渲染形态，移植 2008 版 Ranking_All 的表格编排）：
// 排名 | 姓名 | 军衔 | 初级 3BV/s | 中级 3BV/s | 高级 3BV/s | 总计 3BV/s | 升降
// 2026-09-24「加载更多」改造：行/列渲染抽到 RankingRows 与客户端 RankingFeed 共享，
// 本组件保留给 /area 等服务端分页场景；列头点击切换排序列；升降列仅 sum_time 显示。

import type { RankingRow } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import type { RankingBy } from "@/lib/config";
import { RankingHead, RankingRowLine, RankingEmpty } from "./RankingRows";

export async function RankingTable({
  rows,
  by,
  base,
  params,
  deltas,
}: {
  rows: RankingRow[];
  by: RankingBy;
  /** 列头排序链接的 base 与固定参数（view/nf、area 等） */
  base: string;
  params: Record<string, string | number | undefined>;
  /** 日升降（仅 by=sum_time 时传入并显示升降列） */
  deltas?: Map<number, number | null>;
}) {
  const showDelta = by === "sum_time" && deltas !== undefined;
  // 军衔按主榜总计时间评定（NF 榜用 overallSumTime 回填；distribution 阈值首次调用后缓存）
  const titles = await Promise.all(rows.map((u) => assessTitle(u.overallSumTime ?? u.scores.sum_time)));
  return (
    <table cellPadding={0} cellSpacing={0} className="ranking_table">
      <RankingHead by={by} base={base} params={params} showDelta={showDelta} />
      <tbody>
        {rows.map((u, i) => (
          <RankingRowLine
            key={u.id}
            row={{ ...u, title: titles[i] }}
            by={by}
            delta={deltas?.get(u.id)}
            showDelta={showDelta}
          />
        ))}
        {rows.length === 0 && <RankingEmpty showDelta={showDelta} />}
      </tbody>
    </table>
  );
}
