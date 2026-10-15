"use client";

// 世界榜主体（TOP100 表卡 + 规则 + 交互式世界地图，单列堆叠）
// 2026-10-15 张老师需求：世界排行加世界地图——悬停国家显示参与排行人数 /
// 领军人物，数据从世界排行全量抓取（一天一次）。
// 版式当日两定：先试地区榜同款双栏（地图右列），张老师反馈「地图太宽放右栏
// 压缩后看不清」，终版改「地图放排行规则下面」——三块按 DOM 顺序平级堆叠
// （表卡 → 规则 → 地图）。#world_top 必须是 #page 直接子元素（globals.css 的
// #page.ranking_old.main > #world_top 窄版字号/列宽样式全是直接子选择器，
// 中间不能有包装层），页宽走 ranking_old 窄版口径（不挂 two_columns）。
// 表格与地图共用 hover 态（双向联动），二者必须留在同一 client 组件里，
// 故由本组件渲染三块；页头与规则是服务端内容，以 props 传入（RSC 序列化，
// 正规用法）。地图数据抓取失败（stats=null）时整块隐藏，页面回落到纯 TOP100 形态。

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
  /** 规则板块（.box.rank_rules，服务端渲染，规则下方接地图） */
  rules?: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);
  // 地图点击国家 → TOP100 表内定位领军人物（表组件挂 locate 实现到 ref）
  const locateRef = useRef<((iso: string) => void) | null>(null);

  return (
    <>
      {/* id 保留：globals.css #world_top 列内距等选择器仍挂此卡片；
          平级结构＝#page 直接子元素，窄版 > 直接子选择器样式全部恢复生效 */}
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
      {rules}
      {stats && stats.length > 0 && (
        <WorldMap data={stats} hover={hover} onHover={setHover} onLocate={(iso) => locateRef.current?.(iso)} />
      )}
    </>
  );
}
