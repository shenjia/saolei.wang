"use client";

// 称号徽章（双体系渲染，2026-10-17 Phase 5）
// 军衔制（默认）：盾形徽章 + 分级色文字（RankBadge），hover 气泡条件文案；
// 旧版称号（观看者偏好 'c' 且调用方传入 classic 备选时）：2008 版配色纯文字（无徽章），
//   hover 气泡显示旧版条件文案。
// 调用方（服务端）只需在原有 title（军衔）之外补算 classicTitle 传入 alt；
// 未传 alt 时（如后台页面）任何体系下都回退军衔制渲染。

import Link from "next/link";
import { TITLE_CLASSES, titleConditionText } from "@/lib/config";
import { OLD_TITLES } from "@/lib/config";
import { RankBadge } from "./RankBadge";
import { useTitleSystem } from "./TitleSystemProvider";

const CLASSIC_CONDITION: Record<string, string> = Object.fromEntries(
  OLD_TITLES.map((t) => [t.name, t.condition])
);

export function TitleBadge({
  title,
  link = false,
  badgeSize,
  classic,
}: {
  /** 军衔制称号（主渲染；空串=不显示） */
  title: string;
  link?: boolean;
  badgeSize?: number;
  /** 旧版称号备选（{name, color}）——观看者偏好旧体系时改渲染此套；null/未传回退军衔制 */
  classic?: { name: string; color: string } | null;
}) {
  const { system } = useTitleSystem();
  // 旧体系优先：有备选且非「布衣/雷帝」时直接彩字；布衣也显示（灰），只是无徽章
  if (system === "c" && classic) {
    const tip = CLASSIC_CONDITION[classic.name] ?? "";
    const inner = <em style={{ color: classic.color }}>{classic.name}</em>;
    return link ? (
      <Link href="/page/titles" className="title title_classic" target="_blank" prefetch={false} data-tip={tip || undefined}>
        {inner}
      </Link>
    ) : (
      <span className="title title_classic" data-tip={tip || undefined}>
        {inner}
      </span>
    );
  }
  // 军衔制（默认/未提供备选/后台）
  if (!title) return <span className="title"></span>;
  const cls = TITLE_CLASSES[title] ?? "";
  const tip = titleConditionText(title);
  const inner = (
    <>
      <RankBadge title={title} size={badgeSize} />
      <em className={cls}>{title}</em>
    </>
  );
  return link ? (
    <Link href="/page/titles" className="title" target="_blank" prefetch={false} data-tip={tip || undefined}>
      {inner}
    </Link>
  ) : (
    <span className="title" data-tip={tip || undefined}>
      {inner}
    </span>
  );
}
