// 全局居中醒目气泡消息（2026-09-24 张老师要求）：替代页面顶部不起眼的 loader_hint。
// 用法：dispatchEvent(new CustomEvent("app:toast", { detail: { message } }))
// 或组件内 import { toast } 后直接 toast("文本")。3 秒自动消失，同屏单条。

"use client";

import { useEffect, useState } from "react";

let emit: ((msg: string) => void) | null = null;

/** 命令式调用：任意客户端组件（含事件回调）直接 toast("文本") */
export function toast(message: string) {
  emit?.(message);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    emit = setMsg; // 注册命令式入口
    function onToast(e: Event) {
      setMsg((e as CustomEvent<{ message: string }>).detail.message);
    }
    window.addEventListener("app:toast", onToast);
    return () => {
      emit = null;
      window.removeEventListener("app:toast", onToast);
    };
  }, []);

  // 3 秒自动消失（msg 变化即重置计时）
  useEffect(() => {
    if (msg === null) return;
    const timer = setTimeout(() => setMsg(null), 3000);
    return () => clearTimeout(timer);
  }, [msg]);

  if (msg === null) return null;

  return (
    <div className="toast_bubble" role="status" aria-live="polite">
      {msg}
    </div>
  );
}
