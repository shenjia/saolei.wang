// 导航未读角标（移植 2008 版 Include/Message.asp 的 30 秒轮询）
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function MessageBadge() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    async function poll() {
      try {
        const res = await fetch("/api/message?action=unread");
        if (res.ok) {
          const data = await res.json();
          setUnread(data.unread ?? 0);
        }
      } catch {
        // 网络异常时静默
      }
    }
    poll();
    timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Link href="/message">
      短消息{unread > 0 && <sup className="msg_badge">{unread}</sup>}
    </Link>
  );
}
