"use client";

// 今日地区明细表（2026-10-31 张老师需求）：练习数据页地图右侧，每列表头
// 可点击双向排序，默认按盘数降序。视觉/交互照 ServerStatusPanel 的
// .sv_sort + .sa 双三角（样式在 admin.css 的 .region_today 作用域段）。
// 数据由 RSC 页面传入（getRegionToday），纯客户端排序不回源。

import { useState } from "react";

export interface RegionTodayRow {
  area: string;
  plays: number;
  players: number;
  winRate: number;
  avgRtt: number | null;
  minRtt: number | null;
  maxRtt: number | null;
}

type SortKey = "area" | "plays" | "players" | "winRate" | "avgRtt" | "range";
interface SortSpec {
  key: SortKey;
  dir: "asc" | "desc";
}
/** 各列默认方向：计数/占比列降序（多在前），延迟列升序（快在前），地区升序 */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  area: "asc",
  plays: "desc",
  players: "desc",
  winRate: "desc",
  avgRtt: "asc",
  range: "asc",
};

function SortArrows({ dir }: { dir: "asc" | "desc" }) {
  return (
    <span className="sa" aria-hidden="true">
      <i className={`up${dir === "asc" ? " on" : ""}`} />
      <i className={`down${dir === "desc" ? " on" : ""}`} />
    </span>
  );
}

export function RegionTodayTable({ rows }: { rows: RegionTodayRow[] }) {
  const [sort, setSort] = useState<SortSpec>({ key: "plays", dir: "desc" });

  const clickSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  // 延迟两列无数据的省（null）恒沉底，不参与方向翻转
  const sorted = [...rows].sort((a, b) => {
    if (sort.key === "area") {
      return sort.dir === "asc" ? a.area.localeCompare(b.area, "zh") : b.area.localeCompare(a.area, "zh");
    }
    const val = (r: RegionTodayRow): number | null =>
      sort.key === "plays"
        ? r.plays
        : sort.key === "players"
          ? r.players
          : sort.key === "winRate"
            ? r.winRate
            : sort.key === "avgRtt"
              ? r.avgRtt
              : r.minRtt === null || r.maxRtt === null
                ? null
                : r.minRtt * 1e6 + r.maxRtt; /* 范围列按下限、上限破平 */
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const d = va - vb;
    return sort.dir === "asc" ? d : -d;
  });

  const th = (key: SortKey, label: string, tip: string) => (
    <th className="num">
      <button
        type="button"
        className={`sv_sort${sort.key === key ? " on" : ""}`}
        onClick={() => clickSort(key)}
        title={tip}
      >
        {label}
        {sort.key === key && <SortArrows dir={sort.dir} />}
      </button>
    </th>
  );

  return (
    <div className="admin_scroll region_today" style={{ marginTop: 6 }}>
      <table className="admin_table">
        <thead>
          <tr>
            {th("area", "地区", "按地区名排列")}
            {th("plays", "盘数", "按盘数排列（多在前）")}
            {th("players", "人数", "按人数排列（多在前）")}
            {th("winRate", "胜率", "按胜率排列（高在前）")}
            {th("avgRtt", "平均延迟", "按平均延迟排列（快在前）")}
            {th("range", "延迟范围", "按延迟范围排列（快在前）")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.area}>
              <td className="strong">{r.area}</td>
              <td className="num">{r.plays.toLocaleString("zh-CN")}</td>
              <td className="num">{r.players}</td>
              <td className="num">{r.plays ? `${r.winRate}%` : "—"}</td>
              <td className="num">{r.avgRtt !== null ? `${r.avgRtt}ms` : "—"}</td>
              <td className="num">{r.minRtt !== null ? `${r.minRtt}~${r.maxRtt}ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
