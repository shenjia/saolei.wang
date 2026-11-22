// 比赛模式本盘 metric 值（score 域）客户端现算（2026-11-22 张老师需求：破纪录气泡）。
//
// 与服务端落库链（videoradar.analyzeVideo → video_metrics）同式同源：同一 replayCounts
// 计数（结算面板/下载录像唯一事实源）+ 同一公式，预演值与上传后权威落库值仅差
// ±0.001 级舍入（r3 三位小数在 ×1000 域恰是整数精度，气泡展示无感知）。
// 零依赖纯模块——core 内客户端 bundle 引用，不沾服务端 lib（prisma 链）。

/** score 域值（time=毫秒，3bv/3bvs/ioe/thrp/crossings=落库×1000；无效恒 0）。
 *  · time：ms 直接进（noRecord 盘调用方先闸，不进来）
 *  · 3bv：board3bv×1000
 *  · 3bvs：solved/秒 ×1000（= bvs 落库值×1000；ms>0 保底除法）＝ solvedBv×1e6/ms
 *  · ioe：solved/cl ×1000；thrp：solved/ce ×1000；crossings：cp×1000 */
export function localMetricScore(
  metric: string,
  ms: number,
  board3bv: number,
  solvedBv: number,
  cl: number,
  ce: number,
  crossings: number
): number {
  switch (metric) {
    case "time":
      return ms > 0 ? ms : 0;
    case "3bv":
      return board3bv > 0 ? board3bv * 1000 : 0;
    case "3bvs":
      return solvedBv > 0 && ms > 0 ? (solvedBv * 1000000) / ms : 0;
    case "ioe":
      return cl > 0 ? (solvedBv / cl) * 1000 : 0;
    case "thrp":
      return ce > 0 ? (solvedBv / ce) * 1000 : 0;
    case "crossings":
      return crossings > 0 ? crossings * 1000 : 0;
    default:
      return 0;
  }
}
