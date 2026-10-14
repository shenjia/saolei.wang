// 在线玩 /online（2026-10-14 一期：纯前端娱乐局，不存录像、成绩不入排行）
// 引擎与外观经 design/online-play.html 多轮评审确认后移植；游戏本体见 components/OnlinePlay.tsx。
// 路由说明：/play 已被 flop 播放器静态目录（public/play/）占用，故用 /online。
// 2026-10-14 二期：右上角收敛为 齿轮设置 + 全屏 两个图标按钮（设置浮窗稿 design/online-settings.html）；
// 3BV 范围上下限复用主站 3BV 统计区间（level_3bv_range，读取时钳到 LEVEL_MIN_3BV）。
// 2026-10-14 五期：注入雷达分位基准（video_metric_dist），结算面板的六维评级与
// 录像详情页「录像分析」同源；无基准数据时面板只显示按钮不显示雷达。

import type { Metadata } from "next";
import { OnlinePlay } from "@/components/OnlinePlay";
import { getLevel3bvRanges, getOnlineMetricDists } from "@/lib/queries";

export const metadata: Metadata = { title: "练习 | 扫雷网" };

export default async function OnlinePage() {
  const [ranges, metricDists] = await Promise.all([getLevel3bvRanges(), getOnlineMetricDists()]);
  /* 服务端注入各级别统计区间（getLevel3bvRanges 已按现行排行规则钳下限）；
     缺行（极端空库）时按理论完整范围兜底，保证浮窗滑杆始终可用 */
  const bvRanges = {
    beg: ranges.beg ?? { min: 2, max: 51 },
    int: ranges.int ?? { min: 30, max: 133 },
    exp: ranges.exp ?? { min: 100, max: 271 },
  };
  return (
    <div id="page" className="main">
      <div className="box" id="online_play">
        <OnlinePlay bvRanges={bvRanges} metricDists={metricDists} />
      </div>
    </div>
  );
}
