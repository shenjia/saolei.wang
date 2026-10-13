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
  // 军衔 SUB 制按高级时间评定（2026-10-13）；NF 榜行数据本身来自 NF 表，exp_time 同样是 NF 口径，
  // 但军衔应按主榜评定——getRankingTable 已把主榜成绩回填进 overall（NF 时），此处优先主榜值
  const titles = await Promise.all(rows.map((u) => assessTitle(u.overallExpTime ?? u.scores.exp_time)));
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
