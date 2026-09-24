"use client";

// 全局登录浮窗（2026-09-24 张老师要求）：登录不再跳页改 URL，
// 半透明遮罩 + 居中浮窗，点遮罩 / 右上角 × / ESC 关闭。
// 挂在 layout，仅未登录时渲染；打开方式 dispatchEvent(new CustomEvent("app:login"))

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import LoginPanel from "./LoginPanel";

export function LoginModal() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("app:login", onOpen);
    return () => window.removeEventListener("app:login", onOpen);
  }, []);

  // 打开时锁页面滚动 + ESC 关闭
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSuccess = useCallback(
    (needBind: boolean) => {
      if (needBind) {
        router.push("/account/bind"); // 老用户未绑定 → 强制绑定页
        return;
      }
      setOpen(false);
      router.refresh(); // 导航条「登录」换成用户名
    },
    [router]
  );

  if (!open) return null;

  return (
    <div className="login_overlay" onClick={() => setOpen(false)}>
      <div id="account_login" className="login_modal box" onClick={(e) => e.stopPropagation()}>
        <a
          className="login_close"
          href="#"
          aria-label="关闭"
          onClick={(e) => (e.preventDefault(), setOpen(false))}
        >
          ×
        </a>
        <LoginPanel onSuccess={handleSuccess} />
      </div>
    </div>
  );
}
