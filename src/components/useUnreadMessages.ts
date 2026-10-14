// 未读消息数共享轮询（2026-10-13）：桌面 MessageBadge 与移动版 MobileNav 消息按钮共用。
// 两个组件常年同时挂载（另一端仅被 CSS 按断点隐藏），各自轮询会对 /api/message 双倍请求，
// 故传入模块级 shouldPoll 谓词按断点互斥：桌面端只在 >960 轮询，移动端只在 ≤960 轮询
// （2026-10-15 随汉堡导航断点 768→960 同步：769~960 半移动带顶栏也是 MobileNav）。
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

export function useUnreadMessages(shouldPoll: () => boolean): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    async function poll() {
      if (!shouldPoll()) return; // CSS 隐藏侧不轮询，避免双倍请求
      try {
        const res = await fetch("/api/message?action=unread");
        if (res.ok) {
          const data = await res.json();
          setUnread(data.unread ?? 0);
        }
      } catch {
        // 网络异常时静默
      }
    }
    poll();
    const timer = setInterval(poll, 30_000);
    // 「全部已读」/读信后立即刷新角标（读信页跳转回来 30s 轮询太慢）
    const refresh = () => poll();
    window.addEventListener("message:changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("message:changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [shouldPoll]);

  return unread;
}
