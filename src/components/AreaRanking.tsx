"use client";

// 地区榜主体（地区排行表 + 交互式中国地图，双向联动）
// 2026-10-13 张老师需求：①地图随榜单一并展示；②把「平均排行」列换成「活跃人数」（近 30 天登录人数）；
//                       ③地图放在排行最底部（表格 → 脚注 → 地图），故 children 插在表与图之间。
// 地图悬停高亮省份时表格对应行同步高亮，表格行悬停时地图对应省份也高亮（共用 hover 态）。
// 军衔（title）由服务端按高级时间评好，与 rows 同序传入。

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AreaMap, type AreaMapDatum } from "./AreaMap";
import { TitleBadge } from "./Cells";
import { buildUrl } from "./Pager";
import { AREA_ORDERS, areaDisplay, type AreaOrder } from "@/lib/config";
import { areaPower } from "@/lib/format";
import type { AreaRow } from "@/lib/queries";

export function AreaRanking({
  rows,
  titles,
  order,
  children,
}: {
  rows: AreaRow[];
  /** 领军人物的军衔，与 rows 同序 */
  titles: string[];
  order: AreaOrder;
  /** 表格与地图之间的内容（页面脚注 .area_note） */
  children?: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const mapData: AreaMapDatum[] = rows.map((r, i) => ({
    area: r.area,
    rank: i + 1,
    players: r.players,
    active: r.active,
    power: r.power,
    bestName: r.bestName,
    title: titles[i] ?? "",
  }));

  return (
    <>
      <table cellPadding={0} cellSpacing={0} className="ranking_table area_table">
        <thead>
          <tr>
            <th>排名</th>
            <th>地区</th>
            {AREA_ORDERS.map((o) => (
              <th key={o.key}>
                <Link
                  href={buildUrl("/area", { order: o.key === "power" ? undefined : o.key })}
                  className={o.key === order ? "current" : ""}
                >
                  {o.label}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.area}
              className={hover === r.area ? "hl" : ""}
              onMouseEnter={() => setHover(r.area)}
              onMouseLeave={() => setHover(null)}
            >
              <td className="rank">
                第&nbsp;<em>{i + 1}</em>&nbsp;位
              </td>
              <td className="name">
                <Link href={buildUrl("/area", { name: r.area })} title={`查看${areaDisplay(r.area)}雷友排行`}>
                  {areaDisplay(r.area)}
                </Link>
              </td>
              <td className="best">
                <Link href={`/user/${r.bestId}`} target="_blank" title="点击查看个人信息">
                  {r.bestName}
                </Link>
                <TitleBadge title={titles[i] ?? ""} link />
              </td>
              <td className={order === "players" ? "num current" : "num"}>
                {r.players}&nbsp;<span className="unit">人</span>
              </td>
              <td className={order === "active" ? "num current" : "num"}>
                {r.active}&nbsp;<span className="unit">人</span>
              </td>
              <td className={order === "power" ? "num current" : "num"}>{areaPower(r.power)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} style={{ textAlign: "center" }}>
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {children}
      <AreaMap data={mapData} hover={hover} onHover={setHover} />
    </>
  );
}
