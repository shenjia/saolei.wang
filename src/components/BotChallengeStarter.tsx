"use client";

import { useEffect } from "react";

export function BotChallengeStarter({ next }: { next: string }) {
  useEffect(() => {
    // layout 的全局 Gate 在 children 之后挂载；延后到本轮 effect 全部完成再发事件。
    const timer = setTimeout(() => {
      window.dispatchEvent(new CustomEvent("app:minesweeper-challenge", { detail: { next } }));
    }, 0);
    return () => clearTimeout(timer);
  }, [next]);
  return <p style={{ textAlign: "center", padding: 40, color: "#aaa99a" }}>正在准备扫雷验证局…</p>;
}
