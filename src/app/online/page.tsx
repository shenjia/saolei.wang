// 在线玩 /online（2026-10-14 一期：纯前端娱乐局，不存录像、成绩不入排行）
// 引擎与外观经 design/online-play.html 多轮评审确认后移植；游戏本体见 components/OnlinePlay.tsx。
// 路由说明：/play 已被 flop 播放器静态目录（public/play/）占用，故用 /online。

import type { Metadata } from "next";
import { OnlinePlay } from "@/components/OnlinePlay";

export const metadata: Metadata = { title: "在线扫雷 | 扫雷网" };

export default function OnlinePage() {
  return (
    <div id="page" className="main">
      <div className="box" id="online_play">
        <OnlinePlay />
      </div>
    </div>
  );
}
