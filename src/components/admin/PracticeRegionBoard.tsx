"use client";

// 练习数据页「延迟地图 + 负载 + 今日地区明细」大板块（2026-11-01 张老师需求）：
// 地图与地区明细双向联动——hover 状态统一在此持有，地图悬停省份时右表对应行
// 高亮（tr.hl），表格悬停行时地图省份高亮（.prov.hovering）。地图与表共用
// 同一份今日数据（RSC 传入 getRegionToday），无额外请求。

import { useState } from "react";
import { LatencyMap } from "./LatencyMap";
import { RegionTodayTable, type RegionTodayRow } from "./RegionTodayTable";
import { ServerStatusPanel } from "./ServerStatusPanel";

export function PracticeRegionBoard({ rows }: { rows: RegionTodayRow[] }) {
  const [hoverArea, setHoverArea] = useState<string | null>(null);
  const totalPlays = rows.reduce((a, d) => a + d.plays, 0);

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
      <div style={{ flex: "2 1 0", minWidth: 300, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <b style={{ fontSize: 14 }}>
            排行延迟地图（今日）
            <span style={{ color: "#75715e", fontSize: 12, marginLeft: 8 }}>
              {rows.length
                ? `${rows.length} 个地区有数据 · 共 ${totalPlays.toLocaleString("zh-CN")} 盘`
                : "数据自今日起记"}
            </span>
          </b>
          <div style={{ marginTop: 6 }}>
            {rows.length ? (
              <LatencyMap data={rows} hoverArea={hoverArea} onHover={setHoverArea} />
            ) : (
              <div className="admin_empty">今日暂无延迟数据（排行局结算后自动记入）</div>
            )}
          </div>
        </div>
        <div>
          <ServerStatusPanel />
        </div>
      </div>
      {/* 右列：明细撑满大板块高度（pc_big 作用域放开 max-height，表头吸顶） */}
      <div style={{ flex: "3 1 0", minWidth: 300, display: "flex", flexDirection: "column" }}>
        <b style={{ fontSize: 14 }}>今日地区明细</b>
        <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          {rows.length ? (
            <RegionTodayTable rows={rows} hoverArea={hoverArea} onHover={setHoverArea} />
          ) : (
            <div className="admin_empty">今日暂无地区数据</div>
          )}
        </div>
      </div>
    </div>
  );
}
