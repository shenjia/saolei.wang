"use client";

// 称号体系跟随文案（2026-10-18 张老师要求）：同一处文案随观看者体系切换——
// 军衔制 → m 文案、旧版称号 → c 文案。用于导航「军衔/称号」、排行表头、
// 首页「入伍新兵/新人报到」等；默认 m="军衔" c="称号"。
// 复用 TitleSystemProvider 上下文，切换偏好后即时变化，无需刷新。

import { useTitleSystem } from "./TitleSystemProvider";

export function SystemText({ m = "军衔", c = "称号" }: { m?: string; c?: string }) {
  const { system } = useTitleSystem();
  return <>{system === "c" ? c : m}</>;
}
