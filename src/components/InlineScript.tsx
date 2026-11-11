'use client';

// 内联阻塞脚本辅助组件（2026-10-29）：消除 React 19 dev 警告
// 「Encountered a script tag while rendering React component」。
// ⚠️ 本文件必须是 Client Component（'use client'）：只有客户端渲染时
// typeof window 才 !== undefined，才真正输出 type="text/plain"、让 React 19
// 不再报上面的警告。若缺此指令，组件是 Server Component，typeof window 永远
// undefined、永远输出 text/javascript，警告照旧触发（2026-11-11 复盘定位根因）。
// 根因：root layout <head> 里的 <script dangerouslySetInnerHTML> 在软导航/水合
// 重放的客户端渲染路径同样会产出——React 19 对「客户端渲染产出 script」报
// console error（脚本不会被浏览器执行，警示开发者）。
// 修法（Next 16 自带文档 preventing-flash-before-hydration.md 官方方案）：
// 服务端渲染输出 type="text/javascript"（首屏 HTML 解析期同步执行、首绘前生效），
// 客户端渲染输出 type="text/plain"（不再构成可执行脚本，警告消除），
// type 属性差异由 suppressHydrationWarning 吞掉。
// 硬导航（直访/刷新）：脚本在 HTML 解析期执行——这正是视口钉定等首绘前逻辑
// 需要的时机；软导航时 root layout 不重渲染、无执行需求。

export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
