// 未读消息共享推送（2026-10-29 SSE 改造）：桌面 MessageBadge 与移动版 MobileNav 共用。
// 两个组件常年同时挂载（另一端仅被 CSS 按断点隐藏），沿用 shouldPoll 谓词按断点互斥
// （桌面 >960 轮询，移动 ≤960；769~960 半移动带顶栏也是 MobileNav）。
//
// 多窗口去重（2026-10-29，原每窗口独立 30s 轮询、N 窗口 N 倍请求）：
//   · Web Locks 选主：全局唯一 leader 窗口连 SSE /api/message/stream（服务端写点
//     实时推送），其余窗口为 follower，只听 BroadcastChannel 广播；
//   · leader 每 60s 本地心跳广播证明存活（零请求），follower 广播停滞 >130s 才
//     自查一次（SSE 服务端心跳是注释行，不触发 onmessage，不能作为存活证据）；
//   · 故障转移：follower 每 30s 用 ifAvailable 试抢锁（leader 标签页关闭锁自动
//     释放），抢到即无缝升级 leader；
//   · 降级链：SSE 断开（readyState CLOSED）→ 30s 轮询（与旧版同频）；浏览器无
//     Web Locks（Safari <16.4）→ 直接 30s 轮询（与旧版完全一致，不劣化）；
//   · 未登录（401）：全部停止（旧版会永远每 30s 打一发 401，纯浪费）。
"use client";

import { useEffect, useState } from "react";

/** 桌面端轮询谓词（>960px 桌面横向导航可见时；模块级定义保证引用稳定、effect 不重跑） */
export function pollWhenDesktop() {
  return window.innerWidth > 960;
}

/** 移动端轮询谓词（≤960px MobileNav 可见时） */
export function pollWhenMobile() {
  return window.innerWidth <= 960;
}

const LOCK_NAME = "saolei-unread-leader";
const CHANNEL_NAME = "saolei-unread";
const POLL_MS = 30_000; // 降级轮询间隔（与旧版一致）
const ACQUIRE_MS = 30_000; // follower 抢锁/故障转移尝试间隔
const LEADER_BROADCAST_MS = 60_000; // leader 存活心跳广播
const STALE_MS = 130_000; // 广播停滞阈值（> 心跳间隔 + 余量才兜底自查）

export function useUnreadMessages(shouldPoll: () => boolean): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const locks = navigator.locks;
    const chan = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
    let stopped = false;
    let latest = 0; // useState 的镜像，供定时器闭包读最新值（避开 stale closure）
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let guardTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let es: EventSource | undefined;
    let releaseLock: (() => void) | undefined;
    let lastBroadcastAt = Date.now();

    const apply = (n: number) => {
      latest = n;
      setUnread(n);
    };

    type PollOutcome = "unauth" | "ok" | "fail" | "skip";

    async function poll(): Promise<PollOutcome> {
      if (stopped) return "skip";
      // 隐藏侧不发请求（tick 时求值，resize 跨断点自动切换，与旧版同语义）
      if (!shouldPoll()) return "skip";
      try {
        const res = await fetch("/api/message?action=unread");
        if (res.status === 401) return "unauth"; // 未登录：角标无意义，全停
        if (!res.ok) return "fail";
        const data = (await res.json()) as { unread?: number };
        apply(Number(data.unread ?? 0));
        chan?.postMessage(latest);
        lastBroadcastAt = Date.now();
        return "ok";
      } catch {
        return "fail"; // 网络异常静默，等下一轮
      }
    }

    const onActivity = () => {
      void poll().then((r) => {
        if (r === "unauth") stopAll();
      });
    };

    function stopTimers() {
      if (pollTimer) clearInterval(pollTimer);
      if (guardTimer) clearInterval(guardTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      pollTimer = guardTimer = heartbeatTimer = undefined;
    }

    function stopAll() {
      stopped = true;
      stopTimers();
      es?.close();
      es = undefined;
      releaseLock?.(); // 释放 Web Lock，同窗口另一实例可在下个周期接棒
      releaseLock = undefined;
    }

    function startFallbackPolling() {
      if (pollTimer || stopped) return;
      onActivity(); // 立即刷一次
      pollTimer = setInterval(onActivity, POLL_MS);
    }

    function startLeader() {
      if (stopped || es || pollTimer) return;
      if (guardTimer) clearInterval(guardTimer);
      guardTimer = undefined;
      es = new EventSource("/api/message/stream");
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as { unread?: number };
          if (typeof data.unread === "number") {
            apply(data.unread);
            chan?.postMessage(latest);
            lastBroadcastAt = Date.now();
          }
        } catch {
          // 非 JSON 帧忽略（服务端心跳是 ":" 注释行，本就不进 onmessage）
        }
      };
      es.onerror = () => {
        // CONNECTING=浏览器自动重连中，不动作；CLOSED=服务端不可用或 401，降级轮询
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          es = undefined;
          startFallbackPolling();
        }
      };
      // 存活心跳广播：leader 即使无消息事件也定期广播，follower 据此免兜底轮询
      heartbeatTimer = setInterval(() => {
        if (chan) {
          chan.postMessage(latest);
          lastBroadcastAt = Date.now();
        }
      }, LEADER_BROADCAST_MS);
    }

    function tryAcquire() {
      if (stopped || !locks) return;
      locks
        .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock || stopped) return; // 未抢到：保持 follower
          let release = () => {};
          releaseLock = () => release();
          startLeader();
          await new Promise<void>((r) => {
            release = r; // 挂起以持锁；stopAll resolve 释放，页面关闭浏览器自动释放
          });
        })
        .catch(() => {
          // 锁 API 异常：保持现状，guard 周期会重试
        });
    }

    function startFollower() {
      if (guardTimer || stopped) return;
      guardTimer = setInterval(() => {
        if (stopped) return;
        tryAcquire(); // leader 消失（锁自动释放）→ 本窗口无缝接棒
        if (Date.now() - lastBroadcastAt > STALE_MS) onActivity(); // 广播链断了才自查
      }, ACQUIRE_MS);
    }

    if (chan) {
      chan.onmessage = (ev) => {
        if (typeof ev.data === "number") {
          apply(ev.data);
          lastBroadcastAt = Date.now();
        }
      };
    }
    window.addEventListener("focus", onActivity);
    window.addEventListener("message:changed", onActivity);

    if (!locks) {
      startFallbackPolling(); // 无 Web Locks（Safari <16.4）：与旧版行为一致
    } else {
      tryAcquire();
      startFollower();
    }

    return () => {
      stopAll();
      window.removeEventListener("focus", onActivity);
      window.removeEventListener("message:changed", onActivity);
      if (chan) {
        chan.onmessage = null;
        chan.close();
      }
    };
  }, [shouldPoll]);

  return unread;
}
