// 排行页右栏选项卡（2008 编排：每日一星 | 雷界统计 切换，右侧「如何评选?」链接）

"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

export function RankingSidebar({ star, stats }: { star: ReactNode; stats: ReactNode }) {
  const [tab, setTab] = useState<"star" | "stats">("star");
  return (
    <div className="ranking_side">
      <div className="ranking_tabs side">
        <span className={tab === "star" ? "current" : ""} onClick={() => setTab("star")}>
          每日一星
        </span>
        <span className={tab === "stats" ? "current" : ""} onClick={() => setTab("stats")}>
          雷界统计
        </span>
        <Link href="/page/help/star" target="_blank" className="how">
          如何评选?
        </Link>
      </div>
      {tab === "star" ? star : stats}
    </div>
  );
}
