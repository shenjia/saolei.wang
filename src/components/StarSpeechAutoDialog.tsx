// 消息页感言自动弹窗（八轮 2026-10-25）：/message?speech=1 进入时挂载即弹一次。
// 用 sessionStorage 标记已弹过——刷新/后退不再重复弹（用户主动点首页入口仍可再开）。
// 预写制（2026-11-11）：已写过感言（user.star_speech 非空）不再自动弹——
// 服务端已写态短路，路由只对未写者挂载本组件。

"use client";

import { useEffect, useState } from "react";
import { StarSpeechDialog } from "./StarSpeechDialog";

const SEEN_KEY = "star_speech_seen";

export function StarSpeechAutoDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!sessionStorage.getItem(SEEN_KEY)) {
        sessionStorage.setItem(SEEN_KEY, "1");
        setOpen(true);
      }
    } catch {
      // 隐私模式等 storage 不可用：直接弹
      setOpen(true);
    }
  }, []);

  return <StarSpeechDialog open={open} onClose={() => setOpen(false)} />;
}
