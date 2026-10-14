// 翻页视口零跳动（2026-10-14 三轮，张老师要求：翻页后页面在原地不跳动）：
// 原理：内容替换前记录「表格顶边在视口中的 y 坐标」，flushSync 同步替换 DOM 后
// 用瞬时滚动（无动画）恢复同一 y——浏览器在同一帧内先布局新内容再滚动，
// 用户只看到最终状态，不存在滚动过程与视口漂移。
// 若表格顶已在视口上方（深读场景），退化为「表格顶对齐视口顶」（instant 对齐），
// 保证任何情况下视口内容起点可预期、无动画跳动。

"use client";

/** 内容替换前调用：记录表格顶的视口锚点 */
export function captureViewportAnchor(el: HTMLElement | null): number | null {
  if (!el) return null;
  return el.getBoundingClientRect().top;
}

/** flushSync 替换内容后调用：瞬时恢复锚点（无动画、无中间帧） */
export function restoreViewportAnchor(el: HTMLElement | null, anchorTop: number | null) {
  if (!el || anchorTop === null) return;
  const nowTop = el.getBoundingClientRect().top;
  const dy = nowTop - anchorTop;
  if (Math.abs(dy) < 1) return;
  // 瞬时滚动（behavior:"instant"）：与 flushSync 同帧完成，无动画无跳动
  window.scrollBy({ top: dy, behavior: "instant" as ScrollBehavior });
}

/** 翻页整表替换的完整流程：锚点捕获 → 同步 setState → 瞬时恢复。
 *  用法：replaceWithoutJump(el, () => setRows(nextRows)) */
export function replaceWithoutJump(el: HTMLElement | null, apply: () => void) {
  const anchor = captureViewportAnchor(el);
  apply();
  restoreViewportAnchor(el, anchor);
}
