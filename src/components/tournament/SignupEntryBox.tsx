"use client";

// 报名参赛盒（2026-11-19 张老师定，集体赛详情页右栏）：
// · 未报名或未开始 → 「报名参赛」按钮（风格同首页开始练习 #play_entry 银灰凸起，
//   图标=_PERSON 旗标 symbol），下方倒计时「距离开赛还有…/距离比赛结束还有…」
// · 点击 → POST /api/tournament/join → 绿气泡「报名参赛成功」→ 已报名态
// · 已报名未开赛 → 绿色「已报名参赛」不可点（disabled 形态，无倒计时变化）
// 已报名+已开始 → 由页面直接渲染 #play_row 双钮（本组件不渲染）

import { useEffect, useState } from "react";
import { toast } from "@/components/Toast";

export function SignupEntryBox({
  compId,
  status,
  joined,
  start,
  end,
}: {
  compId: number;
  status: "upcoming" | "active" | "ended";
  joined: boolean;
  start: number;
  end: number;
}) {
  const [isJoined, setIsJoined] = useState(joined);
  const [submitting, setSubmitting] = useState(false);
  // 倒计时 30s 刷新（分钟粒度足够）
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  async function signup() {
    if (submitting || isJoined) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/tournament/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: compId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        toast(data.error ?? "报名失败", "error");
        return;
      }
      setIsJoined(true);
      toast("报名参赛成功", "success");
    } catch {
      toast("网络异常，请重试", "error");
    } finally {
      setSubmitting(false);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const target = status === "upcoming" ? start : end;
  const remain = Math.max(target - now, 0);
  const d = Math.floor(remain / 86400);
  const h = Math.floor((remain % 86400) / 3600);
  const m = Math.floor((remain % 3600) / 60);

  if (isJoined) {
    // 已报名未开赛：绿色不可点；已报名+已开始页面走 #play_row（不会进本分支）
    return (
      <div className="signup_entry_box">
        <button className="signup_entry_btn joined" disabled>
          <svg viewBox="40 40 180 180" width="24" height="24" aria-hidden="true">
            <use href="#face-flat" />
          </svg>
          已报名参赛
        </button>
        {status === "upcoming" && (
          <p className="signup_countdown">
            距离开赛还有：
            <span suppressHydrationWarning>
              {d > 0 ? `${d}天` : ""}
              {h}小时{m}分钟
            </span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="signup_entry_box">
      <button className="signup_entry_btn" onClick={signup} disabled={submitting}>
        <svg viewBox="40 40 180 180" width="24" height="24" aria-hidden="true">
          <use href="#face-flat" />
        </svg>
        报名参赛
      </button>
      <p className="signup_countdown">
        {status === "upcoming" ? "距离开赛还有：" : "距离比赛结束还有："}
        <span suppressHydrationWarning>
          {d > 0 ? `${d}天` : ""}
          {h}小时{m}分钟
        </span>
      </p>
    </div>
  );
}
