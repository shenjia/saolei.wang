// flop 播放器接入（移植 2008 版 Models/Include/FlopPlayer.asp 的协议）
// 协议：
//   1. 页面嵌入全屏 iframe（初始 flop-player-display-none），src 指向 /play/index.html
//   2. 播放器加载后注入 parent.flop.playVideo(uri, options)，并回调 parent.flop.onload()
//   3. 播放/退出由播放器自己切换 iframe 的 flop-player-display-none 与 body 的
//      flop-player-overflow-hidden（self.frameElement，同源可操作）
//   4. 退出时回调 options.listener

"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    flop?: {
      playVideo?: (
        uri: string,
        options: {
          anonymous?: boolean;
          background?: string;
          share?: unknown;
          listener?: () => void;
        }
      ) => void;
      onload?: () => void;
    };
  }
}

/** 播放录像（播放器未就绪时静默忽略，与 2008 版 IsPlayerReady 行为一致） */
export function playFlop(uri: string) {
  if (!window.flop?.playVideo) return;
  window.flop.playVideo(uri, {
    background: "transparent",
    listener: () => {},
  });
}

/** 「在线播放」按钮（对应 2008 版 Show.asp 的按钮） */
export function PlayButton({ uri }: { uri: string }) {
  return (
    <button type="button" onClick={() => playFlop(uri)}>
      在线播放
    </button>
  );
}

export function FlopPlayer() {
  const loaded = useRef(false);

  useEffect(() => {
    // 播放器加载完成后会回调 onload（2008 版用于激活播放按钮）
    window.flop = window.flop ?? {};
    window.flop.onload = () => {
      loaded.current = true;
    };
  }, []);

  return (
    <iframe
      className="flop-player-iframe flop-player-display-none"
      src="/play/index.html"
      title="录像播放器"
    />
  );
}
