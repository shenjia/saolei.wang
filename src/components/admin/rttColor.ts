// 玩家实测延迟三色（2026-11-01 张老师定，分界 35/75ms）：绿=快、金=中、红=慢
// （站内 Monokai 三色）。单一来源：RegionTodayTable（今日地区表）与
// ServerStatusPanel（服务器负载面板）共用，改分界只动这里。

export const RTT_GOOD = 35;
export const RTT_MID = 75;

export function rttColor(avg: number): string {
  if (avg <= RTT_GOOD) return "#a6e22e";
  if (avg <= RTT_MID) return "#fdc61d";
  return "#e24b4a";
}

/** 图例/悬停统一文案 */
export const RTT_LEGEND = "≤35ms 绿（快）· 35-75ms 金（中）· >75ms 红（慢）";
