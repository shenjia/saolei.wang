"use client";

// 「历史对决」板块容器——标题（vs_lv_head + h1.gray，同纪录板块口径）+ VsHistFeed。
// 对决页（VsScoreBoard）与竞技场（VsPickArena）两处共用。
// 2026-11-13 张老师定口径：＝登录者发起的所有对决、与卡片上是谁无关——
// 原按卡片 uid 的跟随重拉逻辑整体摘除（换人清卡板块必须保留，数据不随卡片变）。

import { VsHistFeed } from "./VsHistFeed";
import type { VsHistRow } from "@/lib/vs";

export function VsHistBlock({
  initial,
  total,
  pageSize,
}: {
  /** RSC 首屏第 1 页 */
  initial: VsHistRow[];
  total: number;
  pageSize: number;
}) {
  return (
    <div className="vs_lvblk vs_hist">
      <div className="vs_lv_head">
        <span aria-hidden="true" />
        <h1 className="gray">历史对决</h1>
        <span aria-hidden="true" />
      </div>
      <VsHistFeed initial={initial} total={total} pageSize={pageSize} />
    </div>
  );
}
