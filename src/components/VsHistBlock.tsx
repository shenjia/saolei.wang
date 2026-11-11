"use client";

// 「历史对决」板块容器（2026-11-11 17:23 张老师：单 id 竞技场入口也要显示历史对决，
// 未跑分前常显）——标题（vs_lv_head + h1.gray，同纪录板块口径）+ VsHistFeed。
// 对决页（VsScoreBoard）与竞技场（VsPickArena）两处共用；换人跟随由 VsHistFeed
// 内部 effect 处理（uids 变化重拉）。

import { VsHistFeed } from "./VsHistFeed";
import type { VsHistRow } from "@/lib/vs";

export function VsHistBlock({
  uid1,
  uid2,
  initial,
  total,
  pageSize,
}: {
  /** 当前左/右玩家 id（0=空位；全 0 时父级负责摘除板块） */
  uid1: number;
  uid2: number;
  /** RSC 首屏第 1 页（对应初始 uid 组合） */
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
      <VsHistFeed uid1={uid1} uid2={uid2} initial={initial} total={total} pageSize={pageSize} />
    </div>
  );
}
