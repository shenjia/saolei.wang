"use client";

// 今日地区明细表（2026-10-31 张老师需求）：练习数据页地图右侧，每列表头
// 可点击双向排序，默认按盘数降序。视觉/交互照 ServerStatusPanel 的
// .sv_sort + .sa 双三角（样式在 admin.css 的 .region_today 作用域段）。
// 数据由 RSC 页面传入（getRegionToday），纯客户端排序不回源。
// 2026-11-01 双向联动：hoverArea/onHover 由 PracticeRegionBoard 统一持有，
// 悬停行上报 area（地图省份高亮），地图悬停省份时本表对应行加 .hl 高亮。
// 2026-11-02 五次（张老师）：行点击展开该地区今日玩家明细（展示样式同左侧
// 负载面板玩家列表：亮灰名 + 性别小标记 + 军衔徽章），列＝盘数/胜率/平均
// 延迟/延迟范围；数据随 RSC 一次传入（getRegionToday.detail），再点行收起。

import { Fragment, useState } from "react";
import { rttColor, RTT_LEGEND } from "./rttColor";
import { TitleBadge } from "../Cells";
import { SUB_TH, SUB_TD } from "./ServerStatusPanel";

export interface RegionTodayRow {
  area: string;
  plays: number;
  players: number;
  winRate: number;
  avgRtt: number | null;
  minRtt: number | null;
  maxRtt: number | null;
  /** 行展开玩家明细（getRegionToday 补齐，盘数多在前） */
  detail: {
    uid: number;
    name: string;
    sex: number;
    rank: string;
    plays: number;
    winRate: number;
    avgRtt: number | null;
    minRtt: number | null;
    maxRtt: number | null;
  }[];
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

export function RegionTodayTable({
  rows,
  hoverArea,
  onHover,
}: {
  rows: RegionTodayRow[];
  hoverArea: string | null;
  onHover: (area: string | null) => void;
}) {
  const [sort, setSort] = useState<SortSpec>({ key: "plays", dir: "desc" });
  /* 展开的地区集合（2026-11-02 五次：点击行展开玩家明细，再点收起） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (area: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(area)) next.delete(area);
      else next.add(area);
      return next;
    });

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
            {th("players", "人数", "按人数排列（多在前）")}
            {th("plays", "盘数", "按盘数排列（多在前）")}
            {th("winRate", "胜率", "按胜率排列（高在前）")}
            {th("avgRtt", "平均延迟", "按平均延迟排列（快在前）")}
            {th("range", "延迟范围", "按延迟范围排列（快在前）")}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Fragment key={r.area}>
              <tr
                className={`${hoverArea === r.area ? "hl" : ""}${expanded.has(r.area) ? " sv_open" : ""}`}
                style={{ cursor: "pointer" }}
                title="点击展开/收起该地区今日玩家明细"
                onMouseEnter={() => onHover(r.area)}
                onMouseLeave={() => onHover(null)}
                onClick={() => toggleExpand(r.area)}
              >
                <td className="strong">{r.area}</td>
                <td className="num">{r.players}</td>
                <td className="num">{r.plays.toLocaleString("zh-CN")}</td>
                <td className="num">{r.plays ? `${r.winRate}%` : "—"}</td>
                <td className="num" title={RTT_LEGEND}>
                  {r.avgRtt !== null ? <span style={{ color: rttColor(r.avgRtt) }}>{r.avgRtt}ms</span> : "—"}
                </td>
                <td className="num">{r.minRtt !== null ? `${r.minRtt}~${r.maxRtt}ms` : "—"}</td>
              </tr>
              {/* 玩家明细（2026-11-02 五次）：样式同负载面板玩家列表，盘数多在前 */}
              {expanded.has(r.area) && (
                <tr>
                  <td colSpan={6} style={{ background: "#1e1f1a", padding: "6px 10px 8px 12px" }}>
                    {r.detail.length === 0 ? (
                      <span style={{ color: "#75715e", fontSize: 12 }}>该地区今日无玩家明细</span>
                    ) : (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, lineHeight: 1.7 }}>
                        <thead>
                          <tr style={{ color: "#75715e", textAlign: "left" }}>
                            {/* 首列空（2026-11-02 六次）：与主表「地区」列对位，玩家对齐「人数」列 */}
                            <th style={SUB_TH} aria-hidden="true" />
                            <th style={SUB_TH}>玩家</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }}>盘数</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }}>胜率</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }} title={`今日排行局采样平均延迟 · ${RTT_LEGEND}`}>平均延迟</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }}>延迟范围</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.detail.map((p) => (
                            <tr key={p.uid}>
                              <td />
                              <td style={SUB_TD}>
                                <a
                                  href={`/user/${p.uid}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: "#f8f8f2", textDecoration: "none" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {p.name}
                                </a>
                                <span
                                  className={`gender ${p.sex ? "male" : "female"} small`}
                                  style={{ margin: "0 4px 0 5px" }}
                                  title={p.sex ? "男" : "女"}
                                />
                                <TitleBadge title={p.rank} badgeSize={13} />
                              </td>
                              <td style={{ ...SUB_TD, textAlign: "right" }} className="num">{p.plays.toLocaleString("zh-CN")}</td>
                              <td style={{ ...SUB_TD, textAlign: "right" }} className="num">{p.plays ? `${p.winRate}%` : "—"}</td>
                              <td style={{ ...SUB_TD, textAlign: "right" }} className="num" title={RTT_LEGEND}>
                                {p.avgRtt !== null ? <span style={{ color: rttColor(p.avgRtt) }}>{p.avgRtt}ms</span> : "—"}
                              </td>
                              <td style={{ ...SUB_TD, textAlign: "right" }} className="num">
                                {p.minRtt !== null ? `${p.minRtt}~${p.maxRtt}ms` : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
