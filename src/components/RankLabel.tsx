"use client";

// 用户主页大徽章区（Phase 5 双体系）
// 军衔制：大号盾形徽章 + 军衔名（原样）；旧版称号：大号彩字（无徽章）。

import Link from "next/link";
import { RankBadge } from "./RankBadge";
import { useTitleSystem } from "./TitleSystemProvider";

export function RankLabel({
  militaryTitle,
  militaryColor,
  classic,
}: {
  /** 军衔制称号名与其配色（TITLE_COLORS） */
  militaryTitle: string;
  militaryColor: string;
  /** 旧版称号备选（null 回退军衔制） */
  classic: { name: string; color: string } | null;
}) {
  const { system } = useTitleSystem();
  return (
    <Link href="/titles" title="称号体系">
      {system === "c" && classic ? (
        // 2026-10-18 张老师要求：旧称号字号至少 1.5 倍（26→40px），与 72px 大徽章视觉平衡
        <span
          className="rank_name rank_classic_name"
          style={{ color: classic.color, fontSize: 40, fontWeight: "bold", lineHeight: 1.2, display: "block" }}
        >
          {classic.name}
        </span>
      ) : (
        <>
          <RankBadge title={militaryTitle} size={72} />
          <span className="rank_name" style={{ color: militaryColor }}>
            {militaryTitle}
          </span>
        </>
      )}
    </Link>
  );
}
