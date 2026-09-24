// 「加载更多」保持滚动位置（2026-09-24 二轮改版）：
// 根因（实测 /user/4843 深滚场景稳定复现，scrollY 883→17）：列表底部按钮贴近视口顶时，
// Chrome 对鼠标点击 focus 的滚动修正会把视口滚到「按钮不被吸顶 header(45px) 遮挡」的
// 位置。修正发生在 mousedown 默认行为（异步，约点击后 30ms），scroll 拦截器无法抢在
// 前面（save 时拿到的已是修正后的 17）。
// 修复：导出 noFocusJump —— 挂在按钮 onMouseDown 上 preventDefault，阻止 mousedown
// 默认聚焦，从根上不让修正发生（按钮仍正常响应 click；键盘 Tab 聚焦不受影响）。
// 新行向下追加不动视口，无需滚动补偿。

"use client";

import type { MouseEventHandler } from "react";

/** 挂在「加载更多」按钮 onMouseDown：阻止 mousedown 默认 focus 引发的视口滚动修正 */
export const noFocusJump: MouseEventHandler<HTMLButtonElement> = (e) => {
  e.preventDefault();
};
