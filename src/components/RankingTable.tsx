// 全级别排行表（移植 2008 版 Ranking_All 的表格编排，2026-09-23 张老师要求）：
// 排名 | 姓名 | 军衔 | 初级 3BV/s | 中级 3BV/s | 高级 3BV/s | 总计 3BV/s | 升降
// 列头点击切换排序列；称号列为 18 级军衔（按总计时间评定，2026-09-23 晚张老师要求改回军衔）；
// 升降列仅按总计时间排序时显示

import Link from "next/link";
import type { RankingRow } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { scoreTime } from "@/lib/format";
import type { RankingBy } from "@/lib/config";
import { TitleBadge } from "./Cells";
import { buildUrl } from "./Pager";

const COLS: { by: RankingBy; label: string; cls: string }[] = [
  { by: "beg_time", label: "初级", cls: "c_beg" },
  { by: "beg_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "int_time", label: "中级", cls: "c_int" },
  { by: "int_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "exp_time", label: "高级", cls: "c_exp" },
  { by: "exp_3bvs", label: "3BV/s", cls: "c_3bvs" },
  { by: "sum_time", label: "总计", cls: "c_sum" },
  { by: "sum_3bvs", label: "3BV/s", cls: "c_3bvs" },
];

function ScoreCell({
  row,
  col,
  current,
}: {
  row: RankingRow;
  col: (typeof COLS)[number];
  current: boolean;
}) {
  const v = row.scores[col.by];
  const isTime = col.by.endsWith("_time");
  const cls = `${col.cls}${current ? " current" : ""}`;
  if (!v) return <td className={cls}>-</td>;
  // 3BV/s 负值 = 3BV 太小不被承认（删除线，对齐 Score3bvs 语义）
  // 排行表内 3BV/s 按 2008 版 FormatNumber(...,2) 显示两位小数
  const neg = !isTime && v < 0;
  const text = isTime ? scoreTime(v) : ((neg ? -v : v) / 1000).toFixed(2);
  const videoId = row.videos[col.by];
  const inner = neg ? <del title="因为3BV太小，运气成分过高，该3BV/s成绩不被承认">{text}</del> : text;
  return (
    <td className={cls}>
      {videoId ? (
        <Link href={`/video/${videoId}`} target="_blank" title="点击查看录像">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </td>
  );
}

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
      <thead>
        <tr>
          <th>排名</th>
          <th>姓名</th>
          <th>军衔</th>
          {COLS.map((c) => (
            <th key={c.by}>
              <Link
                href={buildUrl(base, {
                  ...params,
                  by: c.by === "sum_time" ? undefined : c.by,
                  page: undefined,
                })}
                className={c.by === by ? "current" : ""}
                title={`按${c.label === "3BV/s" ? "3BV/s" : c.label + "时间"}排列`}
              >
                {c.label}
              </Link>
            </th>
          ))}
          {showDelta && <th>升降</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((u, i) => {
          const delta = deltas?.get(u.id);
          return (
            <tr key={u.id} id={`id_${u.id}`}>
              <td className="rank">
                第&nbsp;<em>{u.rank}</em>&nbsp;位
              </td>
              <td className="name">
                <Link href={`/user/${u.id}`} target="_blank" title="点击查看个人信息">
                  {u.chineseName}
                </Link>
                <span className={`gender ${u.sex ? "male" : "female"} small`}></span>
              </td>
              <td className="miltitle">
                <TitleBadge title={titles[i]} link />
              </td>
              {COLS.map((c) => (
                <ScoreCell key={c.by} row={u} col={c} current={c.by === by} />
              ))}
              {showDelta && (
                <td className="delta">
                  {delta === null || delta === undefined ? (
                    <span className="up" title="昨日新上榜">↑新</span>
                  ) : delta === 0 ? (
                    <span className="flat" title="与昨日持平">→</span>
                  ) : delta > 0 ? (
                    <span className="up" title={`比昨日进步${delta}位`}>↑{delta}</span>
                  ) : (
                    <span className="down" title={`比昨日下降${-delta}位`}>↓{-delta}</span>
                  )}
                </td>
              )}
            </tr>
          );
        })}
        {rows.length === 0 && (
          <tr>
            <td colSpan={showDelta ? 12 : 11} style={{ textAlign: "center" }}>
              暂无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
