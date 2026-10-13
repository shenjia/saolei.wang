// BV 收集榜表格 + 「加载更多」（2026-10-13 张老师需求，设计稿 design/ranking-bv.html v3）。
// 列：排名 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 总计——基础三列复刻 RankingRowLine 的真实渲染
// （第 N 位 / 白链+性别图标 / TitleBadge 徽章+气泡），成绩列为 pbar 进度条（级别色，
// 中心叠加 n/den，总计亮灰）。表头即排序切换（同雷界榜列头 Link 模式，当前列金黄）。
// 无搜索定位/升降列（BV 榜不接入 whereami 体系）；数据 1 小时缓存，页脚注明。

"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { BvRankingRow } from "@/lib/queries";
import { LEVEL_NAMES, type BvRankingBy, type VideoLevel } from "@/lib/config";
import { TitleBadge } from "./Cells";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

export type BvTitledRow = BvRankingRow & { title: string };

const SORT_COLS: { by: BvRankingBy; cls: string }[] = [
  { by: "beg", cls: "c_beg" },
  { by: "int", cls: "c_int" },
  { by: "exp", cls: "c_exp" },
  { by: "total", cls: "c_sum" },
];

/** 进度条单元格：暗底槽 + 级别色填充 + 中心叠加 n/den 文字 */
function BvBar({ n, den, cls }: { n: number; den: number; cls: string }) {
  const pct = den > 0 ? (n / den) * 100 : 0;
  return (
    <td>
      <span className={`pbar ${cls}`} title={`收集进度 ${n}/${den}`}>
        <span className="pfill" style={{ width: `${pct}%` }} />
        <span className="ptext">
          {n}/{den}
        </span>
      </span>
    </td>
  );
}

export function BvRankingFeed({
  initial,
  by,
  total,
  pageSize,
  den,
  totalDen,
  ranges,
}: {
  initial: BvTitledRow[];
  by: BvRankingBy;
  total: number;
  pageSize: number;
  den: Record<VideoLevel, number>;
  totalDen: number;
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
}) {
  const [rows, setRows] = useState(initial);
  const nextPage = useRef(2);
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState("");

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    setHint("");
    try {
      const res = await fetch(`/api/ranking/bv/more?by=${by}&page=${nextPage.current}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: BvTitledRow[] };
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      setRows((prev) => [...prev, ...data.rows]);
      nextPage.current += 1;
      const lastRank = data.rows.at(-1)!.rank;
      if (lastRank >= total) setLoadedAll(true);
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
            {SORT_COLS.map((c) => {
              const d = c.by === "total" ? totalDen : den[c.by];
              const r = c.by === "total" ? undefined : ranges[c.by];
              return (
                <th key={c.by}>
                  <Link
                    href={c.by === "total" ? "/ranking?view=bv" : `/ranking?view=bv&by=${c.by}`}
                    className={c.by === by ? "current" : ""}
                    title={`按${c.by === "total" ? "总计" : LEVEL_NAMES[c.by]}收集进度排列`}
                  >
                    {c.by === "total" ? "总计" : LEVEL_NAMES[c.by]}
                  </Link>
                  <small>{r ? `${r.min} – ${r.max}` : d}</small>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} id={`id_${u.id}`}>
              <td className="rank">
                第&nbsp;<em>{u.rank}</em>&nbsp;位
              </td>
              <td className="name">
                <Link href={`/user/${u.id}`} title="点击查看个人信息">
                  {u.chineseName}
                </Link>
                <span className={`gender ${u.sex ? "male" : "female"} small`}></span>
              </td>
              <td className="miltitle">
                <TitleBadge title={u.title} link />
              </td>
              <BvBar n={u.beg} den={den.beg} cls="c_beg" />
              <BvBar n={u.int} den={den.int} cls="c_int" />
              <BvBar n={u.exp} den={den.exp} cls="c_exp" />
              <BvBar n={u.total} den={totalDen} cls="c_sum" />
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: "center" }}>
                暂无数据
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
        <TotalCount total={total} loaded={rows.length} unit="位" />
        {hint && <span className="loader_hint">{hint}</span>}
      </div>
      <div className="footnote">
        统计每位玩家已通过审核的录像中收集到的不同 3BV 数量；分母为站内各难度 3BV
        的实际上下限（随新录像突破自动扩展）；数据每小时更新一次。
      </div>
    </>
  );
}
