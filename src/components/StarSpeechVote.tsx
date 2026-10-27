// 每日一星感言「赞/踩」小链接（2026-10-27 张老师定）：链接形态非按钮；
// 亮灰小字 + 小字计数，感言尾部；游客可投（不要求登录）；
// 同一天只能投一次（赞/踩二选一）——localStorage 按日期键去重（纯客户端闸门）；
// 点击后 POST /api/star action=vote，用返回的最新计数就地刷新，不重载页面。

"use client";

import { useEffect, useState } from "react";

/** localStorage 键：star_vote_<日期>，值 "up" / "down"（跨设备/清存储可再投，符合轻量口径） */
function lsKey(date: string) {
  return `star_vote_${date}`;
}

function ThumbIcon({ down }: { down?: boolean }) {
  // 手势图标（down 时整体翻转即成「踩」），描边风格与站内小 ICON 一致
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: "-2px", ...(down ? { transform: "rotate(180deg)" } : {}) }}
    >
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  );
}

export function StarSpeechVote({ date, up, down }: { date: string; up: number; down: number }) {
  const [counts, setCounts] = useState({ up, down });
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const [busy, setBusy] = useState(false);

  // 挂载时读 localStorage：已投则锁定（按钮置灰、所投一侧高亮）
  useEffect(() => {
    try {
      const v = localStorage.getItem(lsKey(date));
      if (v === "up" || v === "down") setVoted(v);
    } catch {}
  }, [date]);

  async function vote(dir: "up" | "down") {
    if (voted || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/star", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "vote", dir }),
      });
      if (!res.ok) return; // 感言已被删等情况静默失败，不打扰
      const data = (await res.json().catch(() => ({}))) as { up?: number; down?: number };
      if (typeof data.up === "number" && typeof data.down === "number") {
        setCounts({ up: data.up, down: data.down });
      }
      setVoted(dir);
      try {
        localStorage.setItem(lsKey(date), dir);
      } catch {}
    } finally {
      setBusy(false);
    }
  }

  const done = voted !== null;
  return (
    <span className="star_vote">
      <a
        href="#"
        className={`star_vote_link${voted === "up" ? " voted" : ""}`}
        onClick={(e) => {
          e.preventDefault();
          vote("up");
        }}
        aria-disabled={done || busy}
        title={done ? "今天已投过票" : "赞"}
      >
        <ThumbIcon /> {counts.up}
      </a>
      <a
        href="#"
        className={`star_vote_link${voted === "down" ? " voted" : ""}`}
        onClick={(e) => {
          e.preventDefault();
          vote("down");
        }}
        aria-disabled={done || busy}
        title={done ? "今天已投过票" : "踩"}
      >
        <ThumbIcon down /> {counts.down}
      </a>
    </span>
  );
}
