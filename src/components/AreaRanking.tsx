"use client";

// 地区榜主体（地区排行表 + 交互式中国地图，双向联动）
// 2026-10-13 张老师需求：①地图随榜单一并展示；②把「平均排行」列换成「活跃人数」（近 30 天登录人数）；
// 2026-10-15 张老师要求：地图、规则各自成为独立板块；同日二轮——地图升到顶部与
//   主卡片并排（.area_top 双栏，表格卡居左收窄、地图居右顶部对齐，连续切换排序不跳动），
//   表格撤下排行人数 / 活跃人数两列（悬停地图气泡仍可查看）。
//   表格与地图共用 hover 态（双向联动），二者必须留在同一 client 组件里，故由本组件
//   直接渲染「双栏顶部区 + 规则插槽」；页头与规则是服务端内容，以 props 传入
//   （RSC 序列化，正规用法）。
// 2026-10-15 三轮（张老师要求）：左侧地区表改 20 条/页 + 底部标准翻页组件。
// 2026-11-02 张老师要求：「综合排行指数」列改称「战力指数」，新增「活跃指数」列
//   （落盘表 area_activity，每小时重算），且活跃指数为默认排序；地图气泡 title 随
//   当前排序列在「战力排行第x位 / 活跃排行第x位」间切换（见 AreaMap）。
// 2026-11-02 二轮（张老师要求）：全量一共就 2 页——撤下翻页组件完整显示所有地区。
// 2026-11-09 张老师定：领军人物口径随排序切换（战力=历史第一，其余=活跃最高名次/「无」）；
//   无人活跃时领军人物列渲染纯文本「无」（noActiveLeader，不带链接/气泡/徽章）；
//   hover 表格行时右侧地图同步弹气泡（气泡钉在地图右上角，见 AreaMap tipFromRow）
// 军衔（title）由服务端按高级时间评好，与 rows 同序传入。

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AreaMap, rowHoverLink, type AreaMapDatum } from "./AreaMap";
import { PlayerTip, TitleBadge } from "./Cells";
import { buildUrl } from "./Pager";
import { AREA_ORDERS, areaDisplay, type AreaOrder } from "@/lib/config";
import { areaActivity, areaPower } from "@/lib/format";
import type { AreaRow } from "@/lib/queries";

export function AreaRanking({
  rows,
  titles,
  classics,
  order,
  head,
  rules,
}: {
  rows: AreaRow[];
  /** 领军人物的军衔，与 rows 同序 */
  titles: string[];
  /** Phase 5：旧版称号备选（与 titles 同序） */
  classics?: ({ name: string; color: string } | null)[];
  order: AreaOrder;
  /** 页头（.page_head，服务端渲染，插在主卡片顶部） */
  head?: ReactNode;
  /** 规则板块（.box.rank_rules，服务端渲染，插在右列地图下方） */
  rules?: ReactNode;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const mapData: AreaMapDatum[] = rows.map((r, i) => ({
    area: r.area,
    rank: i + 1,
    players: r.players,
    active: r.active,
    power: r.power,
    activity: r.activity,
    wins7d: r.wins7d,
    videos7d: r.videos7d,
    bestName: r.bestName,
    noLeader: r.noActiveLeader,
    title: titles[i] ?? "",
  }));

  return (
    <>
      {/* 双栏顶部区（2026-10-15 张老师要求）：表格卡居左收窄、地图居右顶部对齐——
          连续切换排序时地图位置稳定不跳；排行人数 / 活跃人数两列撤下（悬停地图
          气泡中仍可查看），规则板块移入右列地图下方（2026-10-15 三轮，左右高度齐平）。
          2026-10-15 四轮（张老师要求）：三块平铺为 .area_top 直接子节点（表格 / 地图 /
          规则），双栏与「地图置顶降级」全由 CSS Grid 模板切换——769~1187 视口右列
          装不下地图+规则（规则换行长度会超出表格高度）时降级为地图置顶通栏、
          规则移到排行板块下方 */}
      <div className="area_top">
        <div className="box ranking_box">
          {head}
          {/* rank_scroll：窄屏盒内横滑容器（与 RankingFeed 等同款） */}
          <div className="rank_scroll">
            <table cellPadding={0} cellSpacing={0} className="ranking_table area_table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>地区</th>
                  {AREA_ORDERS.filter((o) => o.key === "best" || o.key === "power" || o.key === "activity").map((o) => (
                    <th key={o.key}>
                      <Link
                        href={buildUrl("/ranking", { view: "area", order: o.key === "activity" ? undefined : o.key })}
                        className={o.key === order ? (o.key === "activity" ? "current act_cur" : "current") : ""}
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
                    onMouseEnter={() => {
                      setHover(r.area);
                      // 行 hover 视为同时 hover 地图（2026-11-09 张老师要求）：
                      // 高亮省份 + 地图右上角弹气泡；移出行时收起
                      rowHoverLink(r.area);
                    }}
                    onMouseLeave={() => {
                      setHover(null);
                      rowHoverLink(null);
                    }}
                  >
                    <td className="rank">
                      第&nbsp;<em>{i + 1}</em>&nbsp;位
                    </td>
                    <td className="name">
                      <Link href={buildUrl("/ranking", { view: "area", name: r.area })} title={`查看${areaDisplay(r.area)}雷友排行`}>
                        {areaDisplay(r.area)}
                      </Link>
                    </td>
                    <td className="best">
                      {r.noActiveLeader ? (
                        // 领军人物缺位（无人活跃，2026-11-09 张老师定）：纯文本「无」
                        <span className="best_none">无</span>
                      ) : (
                        <>
                          <Link href={`/user/${r.bestId}`} className="avatar_link" target="_blank" prefetch={false}>
                            {r.bestName}
                            <span className="pt_bubble">
                              <PlayerTip id={r.bestId} name={r.bestName} englishName={r.bestEnglishName} />
                            </span>
                          </Link>
                          <TitleBadge title={titles[i] ?? ""} classic={classics?.[i]} link />
                        </>
                      )}
                    </td>
                    <td className={order === "activity" ? "num current act_cur" : "num"}>{areaActivity(r.activity)}</td>
                    <td className={order === "power" ? "num current" : "num"}>{areaPower(r.power)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center" }}>
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {/* 右列（2026-10-15 六轮）：DOM 顺序＝规则在前、地图在后；双栏由 CSS
            flex column-reverse 呈现为「地图上、规则下」（间隔恒 16，不受左表
            行数/跨行分布影响）；单列形态该包装 display:contents 展开为 DOM 顺序
            「表 → 规则 → 地图」（五轮要求：排行板块第一位）。hover 联动不变 */}
        <div className="area_side">
          {rules}
          <AreaMap data={mapData} order={order} hover={hover} onHover={setHover} />
        </div>
      </div>
    </>
  );
}
