"use client";

// 「收集墙」模式同步器（2026-10-27）：极小的客户端挂载件，只干四件事——
//   ① 挂载时定 box 的 data-mode：URL ?bbv= 优先（显式动作，写入并记住），
//      否则按 localStorage（**每次软导航重挂载都会跑**，这是内联脚本做不到的：
//      RSC 软导航更新时 React 不会执行重新插入的 <script>）；
//   ② 委托拦截两个筛选链接的点击（2026-10-27 张老师要求筛选器用链接不用按钮）：
//      preventDefault 不导航，切 data-mode + 写 localStorage + replaceState 把
//      ?bbv= 同步进 URL（链接语义成立：可中键/右键新开、F5 后服务端直接渲对该配色）；
//   ③ 不渲染任何节点（null）。
// 配色与链接高亮全是 CSS 跟着 `#user_3bv[data-mode]` 走，本件不碰任何子节点。
// 首屏防闪由 BbvCollection 里那段内联脚本负责（解析时立即设 attribute，早于首帧绘制）。

import { useEffect } from "react";

/** localStorage 键：全站共用一份（看任何人的主页都用自己的选择） */
const MODE_KEY = "bbv_mode";

/** 把 ?bbv= 同步进地址栏（3bv 是默认值，摘掉参数保持 URL 干净）。
 *  ⚠️ Next 16 下 replaceState 必须原样传回 window.history.state，否则 app-router
 *  patch 会挎截并异步滚顶（2026-10-16 项目铁律）。 */
function syncUrl(mode: string) {
  try {
    const url = new URL(window.location.href);
    if (mode === "pb") url.searchParams.set("bbv", "pb");
    else url.searchParams.delete("bbv");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash
    );
  } catch {
    /* URL 不可写（如 sandbox）时忽略：切换仍生效，只是地址栏不带参数 */
  }
}

export function BbvModeSync() {
  useEffect(() => {
    const box = document.getElementById("user_3bv");
    if (!box) return;

    let fromUrl = "";
    try {
      fromUrl = new URLSearchParams(window.location.search).get("bbv") || "";
    } catch {
      fromUrl = "";
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MODE_KEY);
    } catch {
      saved = null;
    }
    // URL 显式带 bbv= 时以 URL 为准（并回写 localStorage，保持两处一致）
    if (fromUrl === "3bv" || fromUrl === "pb") {
      box.setAttribute("data-mode", fromUrl);
      try {
        localStorage.setItem(MODE_KEY, fromUrl);
      } catch {
        /* 忽略 */
      }
    } else {
      box.setAttribute("data-mode", saved === "pb" ? "pb" : "3bv");
    }

    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.(".bbv_tab");
      if (!el || el.tagName !== "A") return;
      const mode = el.getAttribute("data-mode");
      if (mode !== "3bv" && mode !== "pb") return;
      e.preventDefault();
      box.setAttribute("data-mode", mode);
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* 隐私模式禁用 storage 时忽略：本次点击仍生效，只是不记忆 */
      }
      syncUrl(mode);
    };
    box.addEventListener("click", onClick);
    return () => box.removeEventListener("click", onClick);
  }, []);

  return null;
}
