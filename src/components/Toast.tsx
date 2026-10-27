// 全局居中气泡消息（2026-09-24 张老师要求）：替代页面顶部不起眼的 loader_hint。
// 用法：toast("文本") / toast("文本", "success") / toast("文本", "success", 2000)，
// 或 dispatchEvent(new CustomEvent("app:toast", { detail: { message, type } }))
// 类型分色：success 绿 / error 红 / info 黄（默认），同屏单条。
// 时长：success 1 秒后开始渐变淡出（默认，调用方可传第 3 参覆盖），info/error 留 2.8 秒供阅读。
// 2026-10-13 张老师要求：成功气泡文字前统一加「✓」标记（改这一处，全站成功提示全覆盖）。
// 2026-10-27 张老师要求：搜索跳转等待态——toastLoading() 绿色气泡「搜索中」+ 文字后 CSS 转圈，
// 跳转完成（URL 变化）自动渐隐，或调用方 toastLoadingDone() 显式关闭；详见下方注释。

"use client";

import { useEffect, useRef, useState } from "react";

export type ToastType = "success" | "error" | "info" | "loading";


/** 默认停留时长（ms）；toast(msg, type, holdMs) 可覆盖 */
const HOLD: Record<ToastType, number> = { success: 1000, error: 2800, info: 2800, loading: 0 };
/** 淡出时长，需与 globals.css 的 toast_out 动画时长一致 */
const FADE = 360;
/** 搜索中气泡最短可见时长（ms）：跳转极快时也走完这一拍再渐隐，避免闪一下像故障 */
const LOADING_MIN = 320;
/** 搜索中气泡兜底时长（ms）：URL 始终没变（如点击了已筛选的同款条件）也不至于永远转圈 */
const LOADING_MAX = 8000;

type Item = {
  id: number;
  message: string;
  type: ToastType;
  hold: number;
  /** loading 专用：弹出时刻的 URL（变化即视为「跳转完毕」）与弹出时间戳 */
  href?: string;
  shownAt?: number;
};

let emit: ((message: string, type: ToastType, hold?: number) => void) | null = null;
/** loading 专属入口：开始（替换当前气泡）/ 关闭（渐隐） */
let emitLoading: ((message: string) => void) | null = null;
let emitLoadingDone: (() => void) | null = null;


/* G12 反作弊自家节点注册表（2026-10-27 红队 B11）：ToastHost 渲染的气泡元素在
   ref 回调里入册，OnlinePlay 的 isOwnNode 用对象身份判别——气泡 class/样式
   会被攻击者模仿，WeakSet 闭包外的元素塞不进来 */
const toastNodes = new WeakSet<Element>();

/** 该元素是否为本模块渲染的真实气泡（含历史元素，元素卸载由 WeakSet 自动回收） */
export function isRegisteredToast(el: Element): boolean {
  return toastNodes.has(el);
}

/** 命令式调用：任意客户端组件（含事件回调）直接 toast("文本", "success") */
export function toast(message: string, type: ToastType = "info", hold?: number) {
  emit?.(message, type, hold);
}

/**
 * 搜索跳转等待气泡（2026-10-27 张老师要求，全站前台搜索框统一复用）：
 *   绿色气泡「搜索中」+ 文字后 CSS 转圈，出现在屏幕正中；跳转完成（URL 变化）后自动渐隐。
 * 用法：发起跳转前 toastLoading()，之后不必管——URL 一变即渐隐；
 *   若本次流程并不跳转（如排行榜内已加载行直接滚动定位），调用 toastLoadingDone() 主动关闭。
 */
export function toastLoading(message = "搜索中") {
  emitLoading?.(message);
}

/** 关闭当前的「搜索中」气泡（渐隐后卸载；无 loading 气泡时为空操作） */
export function toastLoadingDone() {
  emitLoadingDone?.();
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
  /** 当前 loading 气泡的关闭器（toastLoadingDone 用；非 loading 态为 null） */
  const closeLoading = useRef<(() => void) | null>(null);
  /** 在屏 loading 气泡的 id（普通 toast 顶替后置 0，防止迟到的 toastLoadingDone 误关新气泡） */
  const loadingId = useRef(0);

  useEffect(() => {
    const push = (message: string, type: ToastType, hold?: number) => {
      seq.current += 1;
      loadingId.current = 0; // 普通气泡顶替 loading：此后再调 toastLoadingDone 一律无效
      setLeaving(false); // 新消息进来时取消上一条的淡出
      setItem({ id: seq.current, message, type, hold: hold ?? HOLD[type] });
    };
    const pushLoading = (message: string) => {
      seq.current += 1;
      loadingId.current = seq.current;
      setLeaving(false);
      setItem({
        id: seq.current,
        message,
        type: "loading",
        hold: 0,
        href: window.location.href,
        shownAt: Date.now(),
      });
    };
    emit = push; // 注册命令式入口
    emitLoading = pushLoading;
    emitLoadingDone = () => closeLoading.current?.();
    function onToast(e: Event) {
      const d = (e as CustomEvent<{ message: string; type?: ToastType; hold?: number }>).detail;
      push(d.message, d.type ?? "info", d.hold);
    }
    window.addEventListener("app:toast", onToast);
    return () => {
      emit = null;
      emitLoading = null;
      emitLoadingDone = null;
      window.removeEventListener("app:toast", onToast);
    };
  }, []);

  // 停留 → 淡出 → 卸载（msg 变化即重置计时）
  // loading 分支不按 hold 计时：等「URL 变化」（跳转完成）或兜底超时，且至少可见 LOADING_MIN
  useEffect(() => {
    if (item === null) return;
    if (item.type === "loading") {
      let closed = false;
      let fire: ReturnType<typeof setTimeout> | undefined;
      let remove: ReturnType<typeof setTimeout> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        setLeaving(true);
        remove = setTimeout(() => {
          setItem(null);
          setLeaving(false);
        }, FADE);
      };
      closeLoading.current = () => {
        if (loadingId.current !== item.id) return; // 已被普通气泡顶替 / 已关闭：空操作
        loadingId.current = 0;
        close();
      };
      // 最短可见时长：把「已过时间」从 LOADING_MIN 里扣掉
      const minWait = Math.max(0, LOADING_MIN - (Date.now() - (item.shownAt ?? Date.now())));
      let scheduled = false;
      const startHref = item.href ?? window.location.href;
      const poll = setInterval(() => {
        if (window.location.href !== startHref) schedule();
      }, 100);
      const guard = setTimeout(() => schedule(), LOADING_MAX);
      // 声明提升：上面两个定时器回调可安全引用
      function schedule() {
        if (scheduled) return;
        scheduled = true;
        clearInterval(poll);
        clearTimeout(guard);
        fire = setTimeout(close, minWait);
      }
      return () => {
        closeLoading.current = null;
        if (poll) clearInterval(poll);
        if (guard) clearTimeout(guard);
        if (fire) clearTimeout(fire);
        if (remove) clearTimeout(remove);
      };
    }
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
      ref={(el) => { if (el) toastNodes.add(el); }}
      className={`toast_bubble toast_${item.type}${leaving ? " toast_leave" : ""}`}
      role="status"
      aria-live="polite"
    >
      {item.type === "success" && <CheckIcon />}
      <span>{item.message}</span>
      {item.type === "loading" && <span className="toast_spin" aria-hidden="true" />}
    </div>
  );
}
