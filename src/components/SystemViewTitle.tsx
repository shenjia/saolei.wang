"use client";

// 称号页板块标题（2026-10-18 张老师要求）：按观看者当前体系高亮——
// 选中体系的标题金色 #fdc61a，未选体系亮灰（h1/h2 默认色）。
// 复用 TitleSystemProvider，切换偏好即时变色。

import { useTitleSystem } from "./TitleSystemProvider";
import type { TitleSystem } from "@/lib/title-system";

export function SystemViewTitle({
  as,
  system,
  text,
  era,
}: {
  as: "h1" | "h2";
  /** 本板块所属体系 */
  system: TitleSystem;
  text: string;
  era: string;
}) {
  const { system: current } = useTitleSystem();
  const active = current === system;
  const Tag = as;
  // 未选态显式亮灰：legacy h1 默认即金色（#fdc61a），不显式覆盖会误以为选中
  return (
    <Tag style={{ color: active ? "#fdc61a" : "#b1b1a4" }}>
      {text} <span className="era">{era}</span>
    </Tag>
  );
}
