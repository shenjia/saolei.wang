// 可播放棋盘容器：点击棋盘即播放在线录像（对应 2008 版「在线播放」按钮）
// 地图中心叠一枚半透明播放图标（2026-09-26 张老师要求），点击开启播放

"use client";

import type { ReactNode } from "react";
import { playFlop } from "./FlopPlayer";

export function BoardPlay({ uri, children }: { uri: string; children: ReactNode }) {
  return (
    <div className="playable" title="点击播放在线录像" onClick={() => playFlop(uri)}>
      {/* 内层 float 包裹（.play_board）：legacy 里 .board 是 float:left、
          后续 <p> 文字环绕其右；wrapper 也 float 才能既包住棋盘又不破坏环绕布局，
          播放图标以 wrapper 为包含块居中＝棋盘几何中心 */}
      <div className="play_board">
        {children}
        <button type="button" className="play_overlay" aria-label="播放在线录像" onClick={() => playFlop(uri)}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true">
            <path d="M8 5.14v13.72c0 .96 1.05 1.54 1.86 1.03l10.44-6.86a1.22 1.22 0 0 0 0-2.06L9.86 4.11C9.05 3.6 8 4.18 8 5.14z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
