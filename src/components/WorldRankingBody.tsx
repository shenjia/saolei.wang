"use client";

// 世界榜主体（TOP100 表卡 + 交互式世界地图 + 规则，三块 Grid 落位）
// 2026-10-15 张老师需求：世界排行像地区排行一样在右侧加世界地图——悬停国家显示
// 参与排行人数 / 领军人物，数据从世界排行全量抓取（一天一次）。
// 版式与地区榜五轮一致：.area_top 三块平铺（表 → 规则 → 地图 DOM 顺序），CSS Grid
// areas 落位右列（地图上、规则下）；769~1187 单列降级自然保证表第一位、规则紧随、
// 地图殿后。表格与地图共用 hover 态（双向联动），二者必须留在同一 client 组件里，
// 故由本组件渲染三块；页头与规则是服务端内容，以 props 传入（RSC 序列化，正规用法）。
// 地图数据抓取失败（stats=null）时整块隐藏，页面回落到纯 TOP100 形态。

import { useRef, useState, type ReactNode } from "react";
import { WorldTop100Table } from "./WorldTop100Table";
import { WorldMap } from "./WorldMap";
import { FlopPlayer } from "./FlopPlayer";
import type { WorldCountryDatum, WorldRow } from "@/lib/worldtop";

export function WorldRankingBody({
  rows,
  stats,
  head,
  rules,
}: {
  rows: WorldRow[];
  /** 全量国家聚合（null = 抓取失败，隐藏地图） */
  stats: WorldCountryDatum[] | null;
  /** 页头（.page_head，服务端渲染，插在主卡片顶部） */
  head?: ReactNode;
  /** 规则板块（.box.rank_rules，服务端渲染，插在右列地图下方） */
  rules?: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);
  // 地图点击国家 → TOP100 表内定位领军人物（表组件挂 locate 实现到 ref）
  const locateRef = useRef<((iso: string) => void) | null>(null);

  return (
    <div className="area_top">
      {/* id 保留：globals.css #world_top 列内距等选择器仍挂此卡片 */}
      <div id="world_top" className="box ranking_box">
        {head}
        {rows.length > 0 ? (
          <>
            <WorldTop100Table
              rows={rows}
              hoverIso={stats ? hover : undefined}
              onHoverIso={stats ? setHover : undefined}
              locateRef={locateRef}
            />
            {/* 纪录点击播放（原站 avf 经 /api/world/video 代理，站内 flop 播放器渲染） */}
            <FlopPlayer />
          </>
        ) : (
          <p className="world_fail">暂时无法获取世界排行，请稍后再试。</p>
        )}
      </div>
      <div className="area_side">
        {rules}
        {stats && stats.length > 0 && (
          <WorldMap data={stats} hover={hover} onHover={setHover} onLocate={(iso) => locateRef.current?.(iso)} />
        )}
      </div>
    </div>
  );
}
