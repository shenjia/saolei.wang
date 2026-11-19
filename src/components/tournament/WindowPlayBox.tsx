"use client";

// 窗口赛开赛盒（2026-11-19 张老师定，详情页右栏）：
// · windowHours>0 且比赛进行中：
//   - 未开赛 → 单按钮「开始比赛（总计 X 小时）」→ confirmDialog「确定要开始计时出吗？
//     / 中途不可停表，到时间自动结束比赛」→ POST /api/tournament/start →
//     生成个人标识显示 + 复制剪贴板 + 绿气泡「个人比赛标识：xxx （已复制到剪贴板）」
//   - 已开赛 → 显示个人标识 + 「进入比赛」「传录像」双钮 + 倒计时
//     「比赛剩余时间：xx天xx小时xx分钟」——>1h 绿 / ≤30min 黄 / ≤10min 玫瑰红
// · 集体赛（windowHours=0）走原 #play_row 双钮（页面自身渲染，本组件不渲染）

import { useEffect, useState } from "react";
import { confirmDialog } from "@/components/Confirm";
import { toast } from "@/components/Toast";

export function WindowPlayBox({
  compId,
  windowHours,
  compEnd,
  session0,
}: {
  compId: number;
  windowHours: number;
  /** 比赛结束时刻（窗口钳制上界） */
  compEnd: number;
  /** 初始会话（SSR 已开赛时服务端带出；null=未开赛） */
  session0: { race: string; start: number; end: number } | null;
}) {
  const [sess, setSess] = useState(session0);
  const [starting, setStarting] = useState(false);
  // 倒计时每 30s 刷新（色阶切换粒度分钟级足够；SSR 水合差用 suppressHydrationWarning 规避）
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (windowHours <= 0) return null;

  async function start() {
    const ok = await confirmDialog({
      title: "开始比赛",
      message: "确定要开始计时出吗？\n中途不可停表，到时间自动结束比赛",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await fetch("/api/tournament/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: compId }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        race?: string;
        start?: number;
        end?: number;
        error?: string;
      };
      if (!data.ok || !data.race) {
        toast(data.error ?? "开赛失败", "error");
        return;
      }
      const s = { race: data.race, start: data.start ?? 0, end: data.end ?? 0 };
      setSess(s);
      // 标识复制到剪贴板（非安全上下文降级：只显示不复制）
      let copied = false;
      try {
        await navigator.clipboard.writeText(s.race);
        copied = true;
      } catch {
        /* http 或权限拒绝 → 不复制，气泡不带「已复制」 */
      }
      toast(`个人比赛标识：${s.race}${copied ? " （已复制到剪贴板）" : ""}`, "success", 5000);
    } catch {
      toast("网络异常，请重试", "error");
    } finally {
      setStarting(false);
    }
  }

  // 倒计时文案与色阶
  const now = Math.floor(Date.now() / 1000);
  const remain = sess ? Math.max(sess.end - now, 0) : 0;
  const d = Math.floor(remain / 86400);
  const h = Math.floor((remain % 86400) / 3600);
  const m = Math.floor((remain % 3600) / 60);
  // 色阶（张老师定）：>1h 绿 / ≤30min 黄 / ≤10min 玫瑰红；之间保持上一档（>30min 绿）
  const remainMin = remain / 60;
  const color = remainMin <= 10 ? "#f92672" : remainMin <= 30 ? "#e6c07b" : "#a6e22e";

  if (!sess) {
    return (
      <div className="win_play_box">
        <button className="win_start_btn" onClick={start} disabled={starting}>
          开始比赛（总计 {windowHours} 小时）
        </button>
      </div>
    );
  }
  return (
    <div className="win_play_box">
      <div className="win_race_row">
        <span className="win_race_label">个人比赛标识</span>
        <b className="win_race" title="上传录像时此标识自动挂接本比赛；窗口结束标识失效">
          {sess.race}
        </b>
      </div>
      <div id="play_row">
        <a id="play_entry" href={`/online?race=${sess.race}`} target="_blank" rel="noreferrer">
          <span>进入比赛</span>
        </a>
        <a id="upload_entry" href="/video/upload" target="_blank" rel="noreferrer">
          <span>传录像</span>
        </a>
      </div>
      <p className="win_countdown" style={{ color }}>
        比赛剩余时间：
        <span suppressHydrationWarning>
          {d > 0 ? `${d}天` : ""}
          {h}小时{m}分钟
        </span>
      </p>
    </div>
  );
}
