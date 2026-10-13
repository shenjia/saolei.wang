// 全局居中气泡消息（2026-09-24 张老师要求）：替代页面顶部不起眼的 loader_hint。
// 用法：toast("文本") / toast("文本", "success") / toast("文本", "success", 2000)，
// 或 dispatchEvent(new CustomEvent("app:toast", { detail: { message, type } }))
// 类型分色：success 绿 / error 红 / info 黄（默认），同屏单条。
// 时长：success 1 秒后开始渐变淡出（默认，调用方可传第 3 参覆盖），info/error 留 2.8 秒供阅读。
// 2026-10-13 张老师要求：成功气泡文字前统一加「✓」标记（改这一处，全站成功提示全覆盖）。

"use client";

import { useEffect, useRef, useState } from "react";

export type ToastType = "success" | "error" | "info";

/** 默认停留时长（ms）；toast(msg, type, holdMs) 可覆盖 */
const HOLD: Record<ToastType, number> = { success: 1000, error: 2800, info: 2800 };
/** 淡出时长，需与 globals.css 的 toast_out 动画时长一致 */
const FADE = 360;

type Item = { id: number; message: string; type: ToastType; hold: number };

let emit: ((message: string, type: ToastType, hold?: number) => void) | null = null;

/** 命令式调用：任意客户端组件（含事件回调）直接 toast("文本", "success") */
export function toast(message: string, type: ToastType = "info", hold?: number) {
  emit?.(message, type, hold);
}

/** 成功气泡的对号标记（粗细/圆头与站点字体重量匹配，色随气泡文字） */
function CheckIcon() {
  return (
    <svg
      className="toast_icon"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.2 10.6l4 4.1L15.8 5.6" />
    </svg>
  );
}

export function ToastHost() {
  const [item, setItem] = useState<Item | null>(null);
  const [leaving, setLeaving] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const push = (message: string, type: ToastType, hold?: number) => {
      seq.current += 1;
      setLeaving(false); // 新消息进来时取消上一条的淡出
      setItem({ id: seq.current, message, type, hold: hold ?? HOLD[type] });
    };
    emit = push; // 注册命令式入口
    function onToast(e: Event) {
      const d = (e as CustomEvent<{ message: string; type?: ToastType; hold?: number }>).detail;
      push(d.message, d.type ?? "info", d.hold);
    }
    window.addEventListener("app:toast", onToast);
    return () => {
      emit = null;
      window.removeEventListener("app:toast", onToast);
    };
  }, []);

  // 停留 → 淡出 → 卸载（msg 变化即重置计时）
  useEffect(() => {
    if (item === null) return;
    const t1 = setTimeout(() => setLeaving(true), item.hold);
    const t2 = setTimeout(() => {
      setItem(null);
      setLeaving(false);
    }, item.hold + FADE);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [item]);

  if (item === null) return null;

  return (
    <div
      key={item.id}
      className={`toast_bubble toast_${item.type}${leaving ? " toast_leave" : ""}`}
      role="status"
      aria-live="polite"
    >
      {item.type === "success" && <CheckIcon />}
      <span>{item.message}</span>
    </div>
  );
}
