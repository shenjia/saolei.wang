// 可播放棋盘容器：点击棋盘即播放在线录像（对应 2008 版「在线播放」按钮）

"use client";

import type { ReactNode } from "react";
import { playFlop } from "./FlopPlayer";

export function BoardPlay({ uri, children }: { uri: string; children: ReactNode }) {
  return (
    <div className="playable" title="点击播放在线录像" onClick={() => playFlop(uri)}>
      {children}
    </div>
  );
}
