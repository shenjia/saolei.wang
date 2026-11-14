"use client";

// 对决页换人 X（16:36 张老师：换人不清屏——就地切回竞技场形态，历史对决板块
// 保留、画面不跳）。点击拦截导航，广播「vs_swap」事件由 VsScoreBoard 监听处理；
// href 仅作无 JS/中键新标签降级（行为与竞技场 URL 一致）。
// 2026-11-14：点击同时写「换人引导已完成」标记（markSwapHintDone）——竞技场
// 首次引导与对决页 X 共用同一份 localStorage 记忆，点过任一处永不再提示。

import Link from "next/link";
import { markSwapHintDone } from "./VsPick";

export function VsSwapX({ side, href }: { side: "l" | "r"; href: string }) {
  return (
    <Link
      className="vs_swap"
      href={href}
      prefetch={false}
      aria-label="换人"
      title="换人"
      onClick={(e) => {
        e.preventDefault();
        markSwapHintDone();
        window.dispatchEvent(new CustomEvent("vs_swap", { detail: { side } }));
      }}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </Link>
  );
}
