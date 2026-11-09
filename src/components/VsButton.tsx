// 「和TA比拼一下」对战入口按钮（2026-11-09 张老师需求）：
// 用户主页性别图标 + 对话气泡右侧、侧栏玩家卡片对话气泡正下方各一处。
// 20px 交叉双剑图标（色随 currentColor，hover 金色），点击进 /vs/[id] PK 页。
// 与 SendMessageButton 同族：未登录/看自己灰置 + data-tip 说明原因。
// 纯服务端组件（无状态无事件，禁用态直接渲染 span 防导航）。

import Link from "next/link";

/** 对战图标：交叉双剑，色随 currentColor（20px 与性别 big 图标/对话气泡等高） */
export function SwordsIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
    >
      <path d="M4 3.5 L14.5 14 M16 3.5 L5.5 14" strokeLinecap="round" />
      <path d="M12.6 13.1 L15.5 16 M7.4 13.1 L4.5 16" strokeLinecap="round" />
      <path d="M3 16.2 L5.2 14 M17 16.2 L14.8 14" strokeLinecap="round" />
    </svg>
  );
}

export function VsButton({
  to,
  viewerId,
}: {
  /** 被挑战玩家 id */
  to: number;
  /** 当前登录用户 id（0=未登录：灰置；等于 to=看自己：灰置） */
  viewerId: number;
}) {
  const disabled = viewerId <= 0 || viewerId === to;
  const tip =
    viewerId <= 0 ? "登录后可和TA比拼一下" : viewerId === to ? "不能和自己比拼" : undefined;
  if (disabled) {
    return (
      <span
        className="vs_btn vs_btn--disabled"
        data-tip={tip}
        aria-label="和TA比拼一下（不可用）"
        aria-disabled={true}
      >
        <SwordsIcon />
      </span>
    );
  }
  return (
    <Link
      className="vs_btn"
      href={`/vs/${to}`}
      prefetch={false}
      title="和TA比拼一下"
      aria-label="和TA比拼一下"
    >
      <SwordsIcon />
    </Link>
  );
}
