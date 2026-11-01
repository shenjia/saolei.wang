"use client";

// 练习数据页「延迟地图 + 负载 + 今日地区明细」大板块（2026-11-01 张老师需求）：
// 地图与地区明细双向联动——hover 状态统一在此持有，地图悬停省份时右表对应行
// 高亮（tr.hl），表格悬停行时地图省份高亮（.prov.hovering）。地图与表共用
// 同一份今日数据（RSC 传入 getRegionToday），无额外请求。
// 2026-11-02 改版（张老师需求）：服务器负载轮询从 ServerStatusPanel 提升到此
// （地图 PIN 钉与负载面板共用同一份 3s 数据），另持 hoverServer 三方联动——
// hover 负载行 / hover 地图钉互相高亮，钉 hover 出数据气泡。

import { useEffect, useRef, useState } from "react";
import { LatencyMap } from "./LatencyMap";
import { RegionTodayTable, type RegionTodayRow } from "./RegionTodayTable";
import { ServerStatusPanel, type ServerRow } from "./ServerStatusPanel";

export function PracticeRegionBoard({ rows }: { rows: RegionTodayRow[] }) {
  const [hoverArea, setHoverArea] = useState<string | null>(null);
  const [hoverServer, setHoverServer] = useState<string | null>(null);
  /* 钉气泡目标（2026-11-02 张老师需求拆分）：hover 负载行只放大钉，hover 钉才出气泡 */
  const [srvTip, setSrvTip] = useState<string | null>(null);
  /* 服务器负载数据（2026-11-02 提升自 ServerStatusPanel）：3s 轮询，地图钉与
     负载面板共用；拉取失败保留上一次数据（行内 ok=false 已表达不可用） */
  const [servers, setServers] = useState<ServerRow[] | null>(null);
  const [at, setAt] = useState(0);
  const alive = useRef(true);
  const hadData = useRef(false);

  useEffect(() => {
    alive.current = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/authority-status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { servers: ServerRow[] };
        if (!alive.current) return;
        hadData.current = true;
        setServers(j.servers);
        setAt(Date.now());
      } catch {
        /* 首次失败置空数组让面板显示「全部不可用」而不是永远转圈 */
        if (alive.current && !hadData.current) setServers([]);
      }
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, []);

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
            {/* 地图永远渲染（2026-11-02 张老师）：空数据时省份灰底 + 钉照常显示，
                内部对空 data 健壮（.nodata 分支） */}
            <LatencyMap
              data={rows}
              hoverArea={hoverArea}
              onHover={setHoverArea}
              servers={servers ?? []}
              hoverServer={hoverServer}
              onHoverServer={setHoverServer}
              srvTip={srvTip}
              onSrvTip={setSrvTip}
            />
          </div>
        </div>
        <div>
          <ServerStatusPanel
            servers={servers}
            at={at}
            hoverServer={hoverServer}
            onHoverServer={setHoverServer}
          />
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
