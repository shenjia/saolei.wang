"use client";

// 地区榜主体（地区排行表 + 交互式中国地图，双向联动）
// 2026-10-13 张老师需求：①地图随榜单一并展示；②把「平均排行」列换成「活跃人数」（近 30 天登录人数）；
// 2026-10-15 张老师要求：地图、规则各自成为独立板块；同日二轮——地图升到顶部与
//   主卡片并排（.area_top 双栏，表格卡居左收窄、地图居右顶部对齐，连续切换排序不跳动），
//   表格撤下排行人数 / 活跃人数两列（悬停地图气泡仍可查看）。
//   表格与地图共用 hover 态（双向联动），二者必须留在同一 client 组件里，故由本组件
//   直接渲染「双栏顶部区 + 规则插槽」；页头与规则是服务端内容，以 props 传入
//   （RSC 序列化，正规用法）。
// 2026-10-15 三轮（张老师要求）：左侧地区表改 20 条/页 + 底部标准翻页组件（PageSlider，
//   窗口语义与 RankingFeed/WorldTop100Table 同款：··· 递增批量追加、窗口内滚动定位、
//   窗口外整页替换，数据本就全量在内存，全程零请求）——左表高度与右地图基本齐平。
//   地图配色/气泡仍用全量 34 地区数据（mapData 不随翻页窗口裁剪）。
// 军衔（title）由服务端按高级时间评好，与 rows 同序传入。

import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { AreaMap, type AreaMapDatum } from "./AreaMap";
import { TitleBadge } from "./Cells";
import { buildUrl } from "./Pager";
import { PageSlider, nextBatchSize } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { AREA_ORDERS, areaDisplay, type AreaOrder } from "@/lib/config";
import { areaPower } from "@/lib/format";
import type { AreaRow } from "@/lib/queries";

const PAGE = 18;

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

  // 窗口语义与 RankingFeed / WorldTop100Table 对齐（本地数据版，全程零请求）：
  // ··· 加载更多 = 窗口末尾按递增批量追加（20 → +30 → …，全量 34 地区两批内到顶）；
  // 滑条换页 = 窗口内滚动定位（不换表），窗口外严格一页整表替换（批量序列重置）
  const tableRef = useRef<HTMLTableElement>(null);
  const maxPage = Math.max(1, Math.ceil(rows.length / PAGE));
  const [winStart, setWinStart] = useState(1);
  const [winEnd, setWinEnd] = useState(1);
  const [curPage, setCurPage] = useState(1);
  const [batchStep, setBatchStep] = useState(0);

  const startRow = (winStart - 1) * PAGE;
  const endRow = Math.min(rows.length, winEnd * PAGE);

  function scrollToRowIdx(idx: number) {
    const tr = tableRef.current?.querySelectorAll("tbody tr")[idx];
    tr?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function loadMore() {
    const lastLoaded = Math.min(rows.length, winEnd * PAGE);
    const appended = Math.min(nextBatchSize(batchStep, PAGE), rows.length - lastLoaded);
    if (appended <= 0) return;
    setWinEnd(Math.min(maxPage, Math.ceil((lastLoaded + appended) / PAGE)));
    setBatchStep((s) => s + 1);
  }

  function gotoPage(p: number) {
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    // 窗口内：滚动定位（不换表）
    if (p >= winStart && p <= winEnd) {
      setCurPage(p);
      scrollToRowIdx(p - winStart);
      return;
    }
    // 窗口外：严格一页整表替换（flushSync 保视口锚点还原有效），批量序列重置
    const anchor = captureViewportAnchor(tableRef.current);
    flushSync(() => {
      setWinStart(p);
      setWinEnd(p);
      setCurPage(p);
    });
    restoreViewportAnchor(tableRef.current, anchor);
    setBatchStep(0);
  }

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
          {/* rank_scroll：表格与翻页页脚同宽容器（与 RankingFeed 等同款），窄屏盒内横滑一起滚 */}
          <div className="rank_scroll">
            <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table area_table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>地区</th>
                  {AREA_ORDERS.filter((o) => o.key === "best" || o.key === "power").map((o) => (
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
                {rows.slice(startRow, endRow).map((r, i) => (
                  <tr
                    key={r.area}
                    className={hover === r.area ? "hl" : ""}
                    onMouseEnter={() => setHover(r.area)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <td className="rank">
                      第&nbsp;<em>{startRow + i + 1}</em>&nbsp;位
                    </td>
                    <td className="name">
                      <Link href={buildUrl("/area", { name: r.area })} title={`查看${areaDisplay(r.area)}雷友排行`}>
                        {areaDisplay(r.area)}
                      </Link>
                    </td>
                    <td className="best">
                      <Link
                        href={`/user/${r.bestId}`}
                        className="avatar_link"
                        target="_blank"
                        data-tip={`${r.bestName}${r.bestEnglishName ? `（${r.bestEnglishName}）` : ""} #${r.bestId}`}
                      >
                        {r.bestName}
                      </Link>
                      <TitleBadge title={titles[startRow + i] ?? ""} classic={classics?.[startRow + i]} link />
                    </td>
                    <td className={order === "power" ? "num current" : "num"}>{areaPower(r.power)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center" }}>
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {/* 标准翻页页脚（2026-10-15 张老师要求）：滑条 + 左侧「···加载更多」，
                数据全量在内存，翻页/追加零请求 */}
            <div className="list_footer">
              <PageSlider
                page={curPage}
                pages={maxPage}
                loading={false}
                onGoto={gotoPage}
                hasMore={winEnd < maxPage}
                onMore={loadMore}
              />
            </div>
          </div>
        </div>
        {/* 右列（2026-10-15 六轮）：DOM 顺序＝规则在前、地图在后；双栏由 CSS
            flex column-reverse 呈现为「地图上、规则下」（间隔恒 16，不受左表
            行数/跨行分布影响）；单列形态该包装 display:contents 展开为 DOM 顺序
            「表 → 规则 → 地图」（五轮要求：排行板块第一位）。hover 联动不变 */}
        <div className="area_side">
          {rules}
          <AreaMap data={mapData} hover={hover} onHover={setHover} />
        </div>
      </div>
    </>
  );
}
