// 后台待审计数的客户端校准（2026-10-27）
//
// 问题：侧栏 badge 与顶栏「待审录像 N 条」原先完全由 admin/layout.tsx 服务端算一次。
// App Router 在后台内点链接切页时共享 layout 不会重新执行（只换 page 段），
// 于是外壳一直停在「进入后台那一刻」的旧值，而子页面每次都是新查库 → 数字对不上。
// 线上实证：待审从 2 涨到 17，页面显示 17、badge 仍显 2，强刷才一致。
//
// 解法：layout 仍传首屏初值（无 JS / 首帧可用），客户端在
//   ① 挂载时 ② 每次后台内路由切换时 ③ 每 60s ④ 从别的标签页切回来时
// 拉 /api/admin/pending-count 校准，并通过 window 事件广播给所有消费方
// （侧栏 badge 与顶栏摘要共用同一份数据，只发一个请求）。

"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

export interface PendingCounts {
  /** 待审录像（video.status=10） */
  pending: number;
  /** 待审头像（avatar_review.status=10） */
  avatar: number;
  /** 论坛待审（主题 + 回复，status=5） */
  bbs: number;
  /** 反作弊待复核（cheat_report.resolved=0） */
  cheat: number;
}

/** 广播事件名（同 module 内的消费方都听它） */
const EVENT = "admin-pending-count";
/** 轮询间隔：后台数字够用就行，别给库添压力 */
const REFRESH_MS = 60_000;
/** 最小请求间隔：多个消费方同时挂载/切页时只发一次 */
const MIN_GAP_MS = 3_000;

let lastAt = 0;
let inflight: Promise<void> | null = null;

/** 拉一次计数并广播。force=轮询/回到前台时用，绕过最小间隔 */
export function refreshPendingCounts(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - lastAt < MIN_GAP_MS) return Promise.resolve();
  inflight = (async () => {
    try {
      const res = await fetch("/api/admin/pending-count", { cache: "no-store" });
      if (!res.ok) return; // 401/403/5xx：保持上次的值，不闪归零
      const d = (await res.json()) as Partial<PendingCounts>;
      lastAt = Date.now();
      const next: PendingCounts = {
        pending: Number(d.pending ?? 0),
        avatar: Number(d.avatar ?? 0),
        bbs: Number(d.bbs ?? 0),
        cheat: Number(d.cheat ?? 0),
      };
      window.dispatchEvent(new CustomEvent<PendingCounts>(EVENT, { detail: next }));
    } catch {
      /* 离线 / 网关抖动：静默保留旧值 */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 全局只挂一份定时器与可见性监听（后台壳全程存活，不需要引用计数） */
let polling = false;
function ensurePolling() {
  if (polling) return;
  polling = true;
  window.setInterval(() => void refreshPendingCounts(true), REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshPendingCounts();
  });
}

/** 服务端初值 → 客户端实时值。initial 首帧用；之后服务端若有新初值（router.refresh
 *  会重渲 layout，例如审核完调用 refresh）以新初值为准，否则保持接口拉到的实时值 */
export function usePendingCounts(initial: PendingCounts): PendingCounts {
  const pathname = usePathname();
  const [counts, setCounts] = useState<PendingCounts>(initial);
  const { pending, avatar, bbs, cheat } = initial;

  useEffect(() => {
    const onSync = (e: Event) => setCounts((e as CustomEvent<PendingCounts>).detail);
    window.addEventListener(EVENT, onSync);
    ensurePolling();
    return () => window.removeEventListener(EVENT, onSync);
  }, []);

  // 服务端重渲带来新初值（router.refresh → 审核动作后 layout 重跑）→ 立刻生效，不必等下一次拉取。
  // 走事件而不是直接 setState：同一个值也要经过同一套分发路径，避免两处各自维护状态。
  const lastKey = useRef(`${pending}|${avatar}|${bbs}|${cheat}`);
  useEffect(() => {
    const key = `${pending}|${avatar}|${bbs}|${cheat}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    window.dispatchEvent(new CustomEvent<PendingCounts>(EVENT, { detail: { pending, avatar, bbs, cheat } }));
  }, [pending, avatar, bbs, cheat]);

  // 核心：后台内每次切页都校准一次（子页面已是新数据，外壳跟上）
  useEffect(() => {
    void refreshPendingCounts();
  }, [pathname]);

  return counts;
}

/** 顶栏摘要（与侧栏 badge 同源，避免两处数字再打架） */
export function AdminTopSummary({ initial }: { initial: PendingCounts }) {
  const c = usePendingCounts(initial);
  return (
    <span className="sub">
      {c.pending > 0 ? `待审录像 ${c.pending} 条` : "待审录像已清空"}
      {c.avatar > 0 ? ` · 待审头像 ${c.avatar} 张` : ""}
      {c.bbs > 0 ? ` · 论坛待审 ${c.bbs} 条` : ""}
    </span>
  );
}
