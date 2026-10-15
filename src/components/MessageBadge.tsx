// 导航未读角标（移植 2008 版 Include/Message.asp 的 30 秒轮询）
// 轮询逻辑与移动版 MobileNav 消息按钮共享 useUnreadMessages（桌面端只在 >960px 轮询）。
// 2026-10-15 张老师定：PC 端桌面导航固定使用图标显示（与移动版同款 BubbleIcon
// 三点对话气泡），未读角标 absolute 钉在图标右上角（样式见 globals.css .msg_icon_btn）。
"use client";

import Link from "next/link";
import { BubbleIcon } from "./SendMessageButton";
import { pollWhenDesktop, useUnreadMessages } from "./useUnreadMessages";

export function MessageBadge() {
  const unread = useUnreadMessages(pollWhenDesktop);

  return (
    <Link href="/message" className="msg_icon_btn" aria-label="消息" title="消息">
      <BubbleIcon />
      {unread > 0 && <sup className="msg_badge">{unread}</sup>}
    </Link>
  );
}
