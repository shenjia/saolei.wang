// 导航未读角标（移植 2008 版 Include/Message.asp 的 30 秒轮询）
// 轮询逻辑与移动版 MobileNav 消息按钮共享 useUnreadMessages（桌面端只在 >768px 轮询）。
"use client";

import Link from "next/link";
import { pollWhenDesktop, useUnreadMessages } from "./useUnreadMessages";

export function MessageBadge() {
  const unread = useUnreadMessages(pollWhenDesktop);

  return (
    <Link href="/message">
      消息{unread > 0 && <sup className="msg_badge">{unread}</sup>}
    </Link>
  );
}
