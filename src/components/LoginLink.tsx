"use client";

// 登录入口链接：点击弹出全局登录浮窗（不改 URL，2026-09-24 张老师要求）
// 中键 / Ctrl / Shift 等修饰点击不拦截，走独立登录页，保持「新标签打开」可用

import type { MouseEvent } from "react";

export function LoginLink({ children }: { children: React.ReactNode }) {
  function open(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("app:login"));
  }

  return (
    <a href="/account/login" onClick={open}>
      {children}
    </a>
  );
}
