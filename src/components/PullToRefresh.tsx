// 2026-11-10 张老师报：iOS「添加到主屏幕」后以 standalone 打开，系统不再提供
// Safari 的下拉刷新——顶部只剩橡皮筋回弹（截图里拉出一大块黑底），拉多远都不会重载。
// 本组件在 standalone + 触屏下用前端手势模拟原生 PTR；普通 Safari 保持系统原生
// 下拉刷新，不重复接管。样式见 globals.css 末尾「standalone 模拟下拉刷新」段。
//
// 实现要点（都是 iOS 上的坑，改动前请先读完）：
// ① iOS 从第一个 touchmove 就决定这次手势是否允许脚本取消滚动，之后再
//    preventDefault 会被忽略 → 必须在「第一个 touchmove」内判定方向并阻止默认行为；
//    判定为向上滚 / 横向滑时直接放行，不吞正常滚动。
// ② 不接管原生橡皮筋的位移（各版本阻尼不一致、不可测），而是自己用
//    body 的 translate3d 整页下移；指示器是 fixed 且 top 为负值，body 带
//    transform 后 fixed 的包含块变成 body，它便跟着整页一起滑入露出的顶部黑区，
//    观感与系统原生 PTR 一致。手势结束立刻撤掉 transform，fixed 顶栏零副作用。
// ③ 每帧只改 DOM style / class，不触发 React 重渲染；touchmove 用 rAF 合并。
// ④ 游戏与浮层一律让路：练习页棋盘、全屏录像回放、伪全屏、后台固定壳、
//    任何覆盖全屏的 fixed 遮罩、内部可滚动容器、输入控件都不接管。
// ⑤ 刷新动作取 location.reload()（等价原生 PTR 的整页重载，SSR 动态数据重取）；
//    router.refresh() 只换 RSC 片段，客户端状态与静态资源不会重置，语义不等价。
// ⑥ ?ptr=1 是调试开关，可在普通浏览器 / 无头浏览器强制启用做真机前验证；
//    正常用户不会带这个参数，零影响。

"use client";

import { useEffect } from "react";

/** 松手触发刷新所需的「页面下移量」px（阻尼后的视觉位移，非手指位移） */
const TRIGGER = 72;
/** 页面最多被拉下多少 px */
const MAX_PULL = 104;
/** 手指位移 → 页面位移的阻尼系数（约下拉 120px 触发） */
const DAMPING = 0.6;
/** 松手后指示器停留时长 ms，与原生 PTR「转一圈再重载」的节奏对齐 */
const RELOAD_DELAY = 380;
/** 指示器高度，与 globals.css #ptr_indicator 的 height / top 保持一致 */
const INDICATOR_H = 72;

/** 整页禁用：练习页棋盘 / 全屏录像回放 / iOS 伪全屏引导 / 后台固定壳 */
const PAGE_BLOCKED = "#online_play, .vprfs, #fs_tip, .admin_shell";
/** 触点落在这些元素上不接管：输入控件、可编辑区、显式忽略区 */
const TARGET_BLOCKED = "input, textarea, select, [contenteditable], [data-ptr-ignore]";

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches
  );
}

/** 文档是否在顶部（iOS 橡皮筋时 scrollY 可能为负，同样算顶部） */
function atTop(): boolean {
  return (window.scrollY || document.documentElement.scrollTop || 0) <= 1;
}

/** 触点上方是否存在「还能继续往上滚」的内部滚动容器 */
function insideScrolledContainer(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body && el !== document.documentElement) {
    const s = getComputedStyle(el);
    if (
      /(auto|scroll|overlay)/.test(s.overflowY) &&
      el.scrollTop > 0 &&
      el.scrollHeight > el.clientHeight + 1
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/** 是否有覆盖全屏的 fixed 浮层（登录/确认/灯箱/全屏菜单等）：有则整次手势让路 */
function hasFullscreenOverlay(): boolean {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const el of Array.from(document.body.children)) {
    if (!(el instanceof HTMLElement)) continue;
    const s = getComputedStyle(el);
    if (
      s.display === "none" ||
      s.visibility === "hidden" ||
      s.position !== "fixed" ||
      (s.opacity !== "" && Number(s.opacity) === 0)
    ) {
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width >= w * 0.8 && r.height >= h * 0.8 && r.top <= 0 && r.left <= 0) {
      return true;
    }
  }
  return false;
}

export function PullToRefresh() {
  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).has("ptr");
    if (!forced && !isStandalone()) return;
    if (!("ontouchstart" in window) && navigator.maxTouchPoints === 0) return;

    // 指示器挂 body 直属：不进 #page 的 zoom 子树，尺寸不受整页缩放影响。
    // 纯静态模板，无外部输入，innerHTML 无注入面。
    const host = document.createElement("div");
    host.id = "ptr_indicator";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML =
      '<div class="ptr_chip">' +
      '<span class="ptr_arrow"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v14"/><path d="M6 11l6 6 6-6"/></svg></span>' +
      '<span class="ptr_spinner"></span>' +
      '<span class="ptr_text">下拉刷新</span>' +
      "</div>";
    // top/height 以 JS 常量为单一来源（内联优先于 globals.css 的同名规则）
    host.style.top = `${-INDICATOR_H}px`;
    host.style.height = `${INDICATOR_H}px`;
    document.body.appendChild(host);
    document.documentElement.classList.add("ptr_standalone");

    const arrow = host.querySelector<HTMLElement>(".ptr_arrow");
    const text = host.querySelector<HTMLElement>(".ptr_text");
    const body = document.body;

    const st = {
      armed: false,
      decided: false,
      refreshing: false,
      startX: 0,
      startY: 0,
      pull: 0,
    };
    let raf = 0;
    let pending = 0;
    let reloadTimer = 0;
    let settleTimer = 0;

    const apply = (d: number) => {
      const p = Math.min(1, d / TRIGGER);
      // 整个手势期间保持 translate3d（哪怕 0），fixed 的包含块才不会中途切换
      body.style.transform = `translate3d(0, ${d}px, 0)`;
      host.style.opacity = String(Math.min(1, d / 24));
      if (arrow) arrow.style.transform = `rotate(${Math.round(p * 180)}deg)`;
      const ready = d >= TRIGGER;
      host.classList.toggle("is_ready", ready);
      if (text && !st.refreshing) text.textContent = ready ? "松开刷新" : "下拉刷新";
    };

    const schedule = (d: number) => {
      st.pull = d;
      pending = d;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          apply(pending);
        });
      }
    };

    const clearTransitions = () => {
      body.style.transition = "";
      host.style.transition = "";
    };

    const reset = (animate: boolean) => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      st.armed = false;
      st.decided = false;
      st.pull = 0;
      host.classList.remove("is_ready", "is_refreshing");
      if (arrow) arrow.style.transform = "rotate(0deg)";
      if (text) text.textContent = "下拉刷新";
      if (animate) {
        body.style.transition = "transform .24s cubic-bezier(.22,.61,.36,1)";
        host.style.transition = "opacity .18s ease";
      } else {
        clearTransitions();
      }
      body.style.transform = "";
      host.style.opacity = "0";
      if (animate) {
        settleTimer = window.setTimeout(clearTransitions, 260);
      }
    };

    const startRefresh = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      st.refreshing = true;
      body.style.transition = "transform .18s ease-out";
      body.style.transform = `translate3d(0, ${TRIGGER}px, 0)`;
      host.style.opacity = "1";
      host.classList.remove("is_ready");
      host.classList.add("is_refreshing");
      if (text) text.textContent = "正在刷新…";
      // 停留一瞬让 spinner 可见，再整页重载；reload 后 DOM 重建，transform 自然复位
      reloadTimer = window.setTimeout(() => window.location.reload(), RELOAD_DELAY);
    };

    const onStart = (e: TouchEvent) => {
      if (st.refreshing) return;
      if (e.touches.length !== 1) {
        if (st.armed) reset(true);
        return;
      }
      if (!atTop()) return;
      // 每次手势实时判定：Next 软导航后 root layout 不重挂载，页面可能换成游戏页
      if (document.documentElement.classList.contains("op-fakefs")) return;
      if (document.querySelector(PAGE_BLOCKED) || hasFullscreenOverlay()) return;
      const t = e.target;
      if (
        t instanceof Element &&
        (t.closest(TARGET_BLOCKED) || insideScrolledContainer(t))
      ) {
        return;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      clearTransitions();
      st.armed = true;
      st.decided = false;
      st.pull = 0;
      st.startX = e.touches[0].clientX;
      st.startY = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!st.armed || st.refreshing || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - st.startY;
      const dx = e.touches[0].clientX - st.startX;
      if (!st.decided) {
        // 关键：在第一个 touchmove 就决定，向上 / 横向一律放行，绝不能吞掉滚动
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          st.armed = false;
          return;
        }
        st.decided = true;
      }
      if (e.cancelable) e.preventDefault();
      schedule(Math.min(MAX_PULL, Math.max(0, dy) * DAMPING));
    };

    const onEnd = () => {
      if (!st.armed) return;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        apply(pending);
      }
      const { pull, decided } = st;
      st.armed = false;
      st.decided = false;
      if (decided && pull >= TRIGGER) startRefresh();
      else reset(true);
    };

    const onCancel = () => {
      if (st.armed && !st.refreshing) reset(true);
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onCancel, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
      if (raf) cancelAnimationFrame(raf);
      if (reloadTimer) clearTimeout(reloadTimer);
      if (settleTimer) clearTimeout(settleTimer);
      body.style.transform = "";
      body.style.transition = "";
      document.documentElement.classList.remove("ptr_standalone");
      host.remove();
    };
  }, []);

  // 纯 DOM 插件式实现：SSR 不输出节点，软导航不重挂载，React 零重渲染
  return null;
}
