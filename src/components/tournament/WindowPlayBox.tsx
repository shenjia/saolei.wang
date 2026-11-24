"use client";

// 窗口赛开赛盒（2026-11-19 张老师定，详情页右栏）：
// · 未开赛（upcoming）→ 复用集体赛「报名参赛」盒 SignupEntryBox（2026-11-21
//   张老师定：未开赛不该露「开始比赛」——开始按钮样式同首页开始练习银灰凸起），
//   报名态/倒计时/报名接口与集体赛完全同口径（join 只认未开始，窗口赛通用）
// · 已开赛（active）：
//   - 未开个人窗口 → 单按钮「开始比赛（总计 X 小时）」（样式同首页开始练习）→
//     confirmDialog「确定要开始计时吗？/ 中途不可停表，到时间自动结束比赛」
//     （确认键「开始计时」，双钮居中、确认居左，2026-11-22 张老师定）→
//     POST /api/tournament/start → 生成个人标识显示 + 复制剪贴板 +
//     绿气泡「个人比赛标识：xxx （已复制到剪贴板）」
//   - 已开窗口 → 显示个人标识 + 「进入比赛」「传录像」双钮 + 倒计时
//     「比赛剩余时间：xx天xx小时xx分钟」——>1h 绿 / ≤30min 黄 / ≤10min 玫瑰红
//   - 个人窗口已结束（finished，2026-11-22 张老师定 18875 事故）→ 银灰状态按钮
//     不可点击；一人一赛只能开一次（服务端同步防御）
//   2026-11-24 张老师需求：窗口结束后的按钮按完赛动态文案四态——未报名/已完赛/
//   未完赛/已弃赛（由页面按 joined+videos+calc 判定传入）；下方不再写死
//   「比赛时间已结束」，比赛尚未正式结束时改显比赛结束倒计时；比赛正式结束
//   （status=ended 或倒计时归零）后按钮下方不再显示任何时间
// · 集体赛（windowHours=0）走原 #play_row 双钮（页面自身渲染，本组件不渲染）

import { useEffect, useState } from "react";
import { confirmDialog } from "@/components/Confirm";
import { toast } from "@/components/Toast";
import { SignupEntryBox } from "./SignupEntryBox";

export function WindowPlayBox({
  compId,
  windowHours,
  compEnd,
  session0,
  status,
  joined,
  start,
  end,
  finishState,
}: {
  compId: number;
  windowHours: number;
  /** 比赛结束时刻（窗口钳制上界） */
  compEnd: number;
  /** 初始会话（SSR 已开赛时服务端带出；null=未开赛）。
   *  finished=true=个人窗口已结束（「已完赛」态，2026-11-22） */
  session0: { race: string; start: number; end: number; finished: boolean } | null;
  /** 比赛状态（2026-11-21 张老师定：未开赛显示「报名参赛」而非「开始比赛」） */
  status: "upcoming" | "active" | "ended";
  /** 是否已报名（未开赛时报名盒初始态） */
  joined: boolean;
  /** 比赛开始时刻（报名盒倒计时用） */
  start: number;
  /** 比赛结束时刻（报名盒倒计时用） */
  end: number;
  /** 窗口结束后的按钮文案（与完赛动态同口径，页面按 joined/videos/calc 判定） */
  finishState: "unjoined" | "abandoned" | "incomplete" | "finished";
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

  // 未开赛：报名参赛盒（2026-11-21 张老师定——「开始比赛」只有已开赛才有意义，
  // 且按钮样式同首页开始练习银灰凸起 #play_entry 口径）
  if (status === "upcoming") {
    return (
      <SignupEntryBox
        compId={compId}
        status="upcoming"
        joined={joined}
        start={start}
        end={end}
      />
    );
  }

  async function startRace() {
    const ok = await confirmDialog({
      title: "开始比赛",
      message: "确定要开始计时吗？\n中途不可停表，到时间自动结束比赛",
      // 确认键改「开始计时」居左、双钮整体居中（2026-11-22 张老师定）
      confirmText: "开始计时",
      centerActions: true,
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
        reused?: boolean;
        error?: string;
      };
      if (!data.ok || !data.race) {
        toast(data.error ?? "开赛失败", "error");
        // 已完赛被服务端拒绝：本地置为已完赛态（按钮转「已完赛」）
        if (data.error?.includes("完赛")) setSess((s) => (s ? { ...s, finished: true } : s));
        return;
      }
      const s = { race: data.race, start: data.start ?? 0, end: data.end ?? 0, finished: false };
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
  // 完赛判定：SSR 快照 finished / 客户端倒计时归零 / 比赛整体已结束（无窗口者）
  const isFinished = sess ? sess.finished || sess.end <= now : status === "ended";
  const remain = sess && !isFinished ? Math.max(sess.end - now, 0) : 0;
  const d = Math.floor(remain / 86400);
  const h = Math.floor((remain % 86400) / 3600);
  const m = Math.floor((remain % 3600) / 60);
  // 色阶（张老师定）：>1h 绿 / ≤30min 黄 / ≤10min 玫瑰红；之间保持上一档（>30min 绿）
  const remainMin = remain / 60;
  const color = remainMin <= 10 ? "#f92672" : remainMin <= 30 ? "#e6c07b" : "#a6e22e";

  // 比赛结束倒计时（未开窗口/窗口已结束态共用；比赛正式结束后整行不渲染）
  const compRemain = Math.max(compEnd - now, 0);
  const cd = Math.floor(compRemain / 86400);
  const ch = Math.floor((compRemain % 86400) / 3600);
  const cm = Math.floor((compRemain % 3600) / 60);
  const compColor =
    compRemain / 60 <= 10 ? "#f92672" : compRemain / 60 <= 30 ? "#e6c07b" : "#a6e22e";
  const compCountdown =
    status === "ended" || compRemain === 0 ? null : (
      <p className="win_countdown" style={{ color: compColor }}>
        距离比赛结束还有：
        <span suppressHydrationWarning>
          {cd > 0 ? `${cd}天` : ""}
          {ch}小时{cm}分钟
        </span>
      </p>
    );

  if (!sess && !isFinished) {
    // 未开个人窗口：按钮下挂比赛结束倒计时（2026-11-22 张老师定）——
    // 提示还剩多久不能开赛；色阶同已开窗口态（>1h 绿 / ≤30min 黄 / ≤10min 玫瑰红）
    return (
      <div className="win_play_box">
        <button className="win_start_btn" onClick={startRace} disabled={starting}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/stopwatch-icon.png" alt="" width={28} height={28} />
          开始比赛<span className="win_hours_sub">（总计 {windowHours} 小时）</span>
        </button>
        {compCountdown}
      </div>
    );
  }
  // 个人窗口已结束（或比赛已结束且无窗口）：银灰状态按钮不可点，
  // 文案与完赛动态四态一致（未报名/已弃赛/未完赛/已完赛）
  if (isFinished) {
    const labels = {
      unjoined: "未报名",
      abandoned: "已弃赛",
      incomplete: "未完赛",
      finished: "已完赛",
    };
    return (
      <div className="win_play_box">
        <button className="win_start_btn win_finished_btn" disabled>
          <span>{labels[finishState]}</span>
        </button>
        {compCountdown}
      </div>
    );
  }
  // 上面两分支已覆盖无窗口（未结束→开始比赛、已结束→状态按钮），此处必有会话
  if (!sess) return null;
  return (
    <div className="win_play_box">
      <div className="win_race_row">
        <span className="win_race_label">个人比赛标识</span>
        <b className="win_race" title="上传录像时此标识自动挂接本比赛；窗口结束标识失效">
          {sess.race}
        </b>
      </div>
      <div id="play_row">
        {/* 图标同首页「开始练习/传录像」与集体赛双钮口径（2026-11-22 张老师要求）：
            笑脸用 FlopSprites #face-flat（详情页侧栏已挂 FlopSprites，symbol 可用） */}
        <a id="play_entry" href={`/online?race=${sess.race}`} target="_blank" rel="noreferrer">
          <svg viewBox="0 0 260 260" width="24" height="24" aria-hidden="true">
            <use href="#face-flat" />
          </svg>
          <span>进入比赛</span>
        </a>
        <a id="upload_entry" href="/video/upload" target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/upload-folder-icon.png" alt="" width={24} />
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
