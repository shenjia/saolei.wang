"use client";

// 用户主页侧栏「个人资料」→「标识」列表（2026-10-22 张老师要求）
// 数据源 user_sig（录像标识文字，上传录像时注册、按此核对归属）。
// 一个标识一行；默认最多 3 条，超出显示「···」三圆点卡片按钮（与首页新闻滑条 .ps_more 同款），
// 点击后就地展开全部，展开后按钮变「收起」，点击恢复只显示 3 条。
// 标识整体用小字号 12px（2026-10-22 张老师要求：字体小一些，尽量避免换行）。

import { useState } from "react";

const PREVIEW = 3;

export function UserSigs({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const show = expanded || items.length <= PREVIEW ? items : items.slice(0, PREVIEW);
  const rest = items.length - show.length;
  return (
    <ul className="sig_list">
      {show.map((s) => (
        <li key={s}>{s}</li>
      ))}
      {rest > 0 && !expanded && (
        <li>
          <button
            type="button"
            className="dots_more"
            title="加载更多"
            onClick={() => setExpanded(true)}
          >
            <i />
            <i />
            <i />
          </button>
        </li>
      )}
      {expanded && (
        <li>
          <button
            type="button"
            className="dots_more"
            title="收起"
            onClick={() => setExpanded(false)}
          >
            收起
          </button>
        </li>
      )}
    </ul>
  );
}
