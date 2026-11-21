// 比赛计分数据项注册表（2026-11-21 张老师需求：成绩计算支持多数据项）
//
// 六个数据项的**单一事实来源**：key/中文名/落库精度/格式化/方向语义。
// 零依赖纯模块——tournament.ts（服务端）与 TournamentForm.tsx（客户端）共用，
// 避免把服务端 lib（prisma 链）拉进客户端 bundle。
//
// 存储口径（读库侧的换算约定，computePlayerScores 内部统一折算）：
// · time     → video_info.real_time，**毫秒**整数（score 大小域 = 毫秒）
// · 3bv      → video.board_3bv，**个**（落库精度 1 → score 域 ×1000）
// · 3bvs     → video_metrics.bvs，**实际值**（落库精度 1 → score 域 ×1000）
// · ioe      → video_metrics.ioe，实际值（同上 ×1000）
// · thrp     → video_metrics.thrp，实际值（同上 ×1000）
// · crossings → video_metrics.cp，**次**（落库精度 1 → score 域 ×1000）
//
// score 内部域统一为「落库值 × 1000」的浮点（time 例外，本来就是毫秒）：
// 这样所有项的保底/目标配置值 → score 域的换算都是「×1000」（time=秒×1000，
// 3bv=个×1000），而显示时用 fmtTourScore 按项折回人类可读值。0.001 精度的
// 效率项（3bvs/ioe/thrp）在 ×1000 域中恰是整数精度，求和/比较不丢精度。

/** 计分数据项 key（score_config.metric 落库值） */
export type TourMetricKey = "time" | "3bvs" | "ioe" | "thrp" | "crossings" | "3bv";

export interface TourMetricDef {
  key: TourMetricKey;
  /** 中文名（表单/描述文案用） */
  name: string;
  /** 简短单位标签（表单提示/动态文案用；无单位项给「值」） */
  unit: string;
  /** 默认方向（越大越好？）：time/crossings 越小越好，其余越大越好 */
  defaultDesc: boolean;
  /** 显示小数位（time 3 位惯例；3bv/crossings 整数；效率项 3 位） */
  digits: number;
}

/** 数据项注册表（顺序即表单下拉顺序） */
export const TOUR_METRICS: Record<TourMetricKey, TourMetricDef> = {
  time: { key: "time", name: "用时 time", unit: "秒", defaultDesc: false, digits: 3 },
  "3bvs": { key: "3bvs", name: "3BV/s", unit: "值", defaultDesc: true, digits: 3 },
  ioe: { key: "ioe", name: "IOE 操作效率", unit: "值", defaultDesc: true, digits: 3 },
  thrp: { key: "thrp", name: "ThrP 吞吐效率", unit: "值", defaultDesc: true, digits: 3 },
  crossings: { key: "crossings", name: "跨格数 crossings", unit: "次", defaultDesc: false, digits: 0 },
  "3bv": { key: "3bv", name: "3BV 盘面值", unit: "个", defaultDesc: true, digits: 0 },
};

/** 全部数据项 key（按注册表顺序） */
export const TOUR_METRIC_KEYS = Object.keys(TOUR_METRICS) as TourMetricKey[];

/** 解析数据项 key（非法回退 time，兼容旧配置无 metric 字段） */
export function parseTourMetric(v: unknown): TourMetricKey {
  const s = String(v ?? "time");
  return (TOUR_METRIC_KEYS as string[]).includes(s) ? (s as TourMetricKey) : "time";
}

/** 解析方向（desc=true 越大越好；非法回退该项默认方向） */
export function parseTourDesc(metric: TourMetricKey, v: unknown): boolean {
  if (v === true || v === false) return v;
  if (v === "desc" || v === "asc") return v === "desc";
  return TOUR_METRICS[metric].defaultDesc;
}

/**
 * 成绩格式化：score 内部域值 → 人类可读字符串。
 * · time：score=毫秒 → 秒 3 位小数（如 12.345，不带单位——沿用 scoreTime 全站惯例）
 * · 3bv / crossings：score=落库×1000 → 整数（如 156 / 438）
 * · 3bvs / ioe / thrp：score=落库×1000 → 3 位小数（如 2.345）
 * 非 ★ 常规值（0/负）返回 "0"（time 惯例空串留给调用方特判）。
 */
export function fmtTourScore(metric: TourMetricKey, score: number): string {
  if (metric === "time") {
    return (score / 1000).toFixed(3);
  }
  if (TOUR_METRICS[metric].digits === 0) {
    return String(Math.round(score / 1000));
  }
  return (score / 1000).toFixed(3);
}

/** 目标/保底等配置输入值（人类单位）→ score 内部域（×1000；time 秒→毫秒同构） */
export function tourInputToScore(metric: TourMetricKey, v: number): number {
  return v * 1000;
}
