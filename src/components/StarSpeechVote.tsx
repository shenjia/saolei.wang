// 每日一星感言「赞/踩」小链接（2026-10-27 张老师定；二轮定稿）：
// 仅登录用户可投（未登录点按弹全局登录浮窗，不走请求）；
// 服务端 star_vote 明细按人硬去重（一天一票、赞/踩二选一，SSR 带 myVote 跨设备一致）；
// 视觉（张老师二轮口径）：
//   默认：空心图标 + 深灰数字；领先一方（计数超过对方）实心图标 + 亮灰数字；
//   我投过：赞=绿（图标+数字）、踩=红（图标+数字）。

"use client";

import { useState } from "react";
import { toast } from "./Toast";

function ThumbIcon({ down, filled }: { down?: boolean; filled?: boolean }) {
  // 手势图标（down 翻转成「踩」）；filled 切换实心/空心
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
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

export function StarSpeechVote({
  up,
  down,
  myVote,
  loggedIn,
}: {
  up: number;
  down: number;
  myVote: "up" | "down" | null;
  loggedIn: boolean;
}) {
  const [counts, setCounts] = useState({ up, down });
  const [voted, setVoted] = useState<"up" | "down" | null>(myVote);
  const [busy, setBusy] = useState(false);

  async function vote(dir: "up" | "down") {
    if (voted || busy) return;
    // 未登录：弹全局登录浮窗（LoginModal 监听 app:login）
    if (!loggedIn) {
      window.dispatchEvent(new CustomEvent("app:login"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/star", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "vote", dir }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        up?: number;
        down?: number;
        myVote?: "up" | "down";
      };
      if (!res.ok) {
        toast(data.error ?? "投票失败", "error", 2500);
        return;
      }
      if (typeof data.up === "number" && typeof data.down === "number") {
        setCounts({ up: data.up, down: data.down });
      }
      setVoted(data.myVote ?? dir);
    } finally {
      setBusy(false);
    }
  }

  const done = voted !== null;
  // 领先方（严格大于才实心；0:0 都空心）
  const upLeading = counts.up > counts.down;
  const downLeading = counts.down > counts.up;
  // 我投的方位
  const iVotedUp = done && voted === "up";
  const iVotedDown = done && voted === "down";

  const cls = (dir: "up" | "down") => {
    const leading = dir === "up" ? upLeading : downLeading;
    const mine = dir === "up" ? iVotedUp : iVotedDown;
    if (mine) return `star_vote_link ${dir} mine-${dir}`; // 我投的：绿（赞）/红（踩）
    if (done) return `star_vote_link ${dir} dim`; // 已投后另一侧置灰
    return `star_vote_link ${dir}${leading ? " lead" : ""}`; // 默认：领先实心+亮灰
  };

  return (
    <span className="star_vote">
      <a
        href="#"
        className={cls("up")}
        onClick={(e) => {
          e.preventDefault();
          vote("up");
        }}
        aria-disabled={done || busy}
        title={!loggedIn ? "登录后投票" : iVotedUp ? "我投的赞" : done ? "今天已投过票" : "赞"}
      >
        <ThumbIcon filled={iVotedUp || upLeading} /> {counts.up}
      </a>
      <a
        href="#"
        className={cls("down")}
        onClick={(e) => {
          e.preventDefault();
          vote("down");
        }}
        aria-disabled={done || busy}
        title={!loggedIn ? "登录后投票" : iVotedDown ? "我投的踩" : done ? "今天已投过票" : "踩"}
      >
        <ThumbIcon down filled={iVotedDown || downLeading} /> {counts.down}
      </a>
    </span>
  );
}
