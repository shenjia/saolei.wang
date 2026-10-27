"use client";

// 「收集墙」模式同步器（2026-10-27）：极小的客户端挂载件，只干三件事——
//   ① 挂载时按 localStorage 让 box 的 data-mode 与本地选择一致（**每次软导航重挂载都会跑**，
//      这是内联脚本做不到的：RSC 软导航更新时 React 不会执行重新插入的 <script>）；
//   ② 委托绑定两个 tab 的点击（切 data-mode + 写 localStorage）；
//   ③ 不渲染任何节点（null）。
// 配色与 tab 高亮全是 CSS 跟着 `#user_3bv[data-mode]` 走，本件不碰任何子节点。
// 首屏防闪由 BbvCollection 里那段内联脚本负责（解析时立即设 attribute，早于首帧绘制）。

import { useEffect } from "react";

/** localStorage 键：全站共用一份（看任何人的主页都用自己的选择） */
const MODE_KEY = "bbv_mode";

export function BbvModeSync() {
  useEffect(() => {
    const box = document.getElementById("user_3bv");
    if (!box) return;

    let saved: string | null = null;
    try {
      saved = localStorage.getItem(MODE_KEY);
    } catch {
      saved = null;
    }
    box.setAttribute("data-mode", saved === "pb" ? "pb" : "3bv");

    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest?.(".bbv_tab");
      if (!el) return;
      const mode = el.getAttribute("data-mode");
      if (mode !== "3bv" && mode !== "pb") return;
      box.setAttribute("data-mode", mode);
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* 隐私模式禁用 storage 时忽略：本次点击仍生效，只是不记忆 */
      }
    };
    box.addEventListener("click", onClick);
    return () => box.removeEventListener("click", onClick);
  }, []);

  return null;
}
