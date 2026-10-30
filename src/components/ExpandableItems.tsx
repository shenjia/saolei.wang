"use client";

// 通用「最近 N 条 + 展开/收起」列表（2026-10-30 张老师：前台赞助/支出记录只显最近 5 条，
// 下方「…」按钮点击显示全部、按钮变「收起」；逻辑同个人主页标识列表 UserSigs）。
// items 由 RSC 以 JSX 数组传入（每项是完整的行元素，含 key），本组件只做裁剪与按钮。

import { useState } from "react";

export function ExpandableItems({
  items,
  preview = 5,
  mode,
  wrapClass,
}: {
  /** 全部条目（RSC 渲染的行元素数组） */
  items: React.ReactNode[];
  /** 收起态显示条数 */
  preview?: number;
  /** table = 外层 <table><tbody>；list = 外层 <div> */
  mode: "table" | "list";
  wrapClass: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = items.length > preview;
  const show = expanded || !hasMore ? items : items.slice(0, preview);
  return (
    <>
      {mode === "table" ? (
        <table cellPadding={0} cellSpacing={0} className={`table ${wrapClass}`}>
          <tbody>{show}</tbody>
        </table>
      ) : (
        <div className={wrapClass}>{show}</div>
      )}
      {hasMore && !expanded && (
        <button type="button" className="list_more" title="显示全部记录" onClick={() => setExpanded(true)}>
          …
        </button>
      )}
      {expanded && (
        <button type="button" className="list_more" title="收起" onClick={() => setExpanded(false)}>
          收起
        </button>
      )}
    </>
  );
}
