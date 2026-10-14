// 录像评分的纯函数与常量（服务端 / 客户端共用，零外部依赖）
//
// 2026-10-14 从 lib/videoradar.ts 拆出：videoradar 里还挂着 avf/mvf 解析器与重放引擎，
// 在线玩结算面板（客户端组件）其实只需要这里的「指标定义 + 评级 + 配色」，整包引 videoradar
// 会把一整套解析器打进浏览器。拆开后两端共用同一份实现，**改评级口径只改这一个文件**。
//
// ⚠️ 不要在任何客户端组件里再复制一份 percentOf / gradeOf / GRADE_COLORS：
//    2026-10-14 的教训是 OnlinePlay.tsx 留了个本地副本，主模块修了「0~1 比率上界减 1」
//    的 bug、去掉了「移动」轴，副本没跟上，两个页面的评级口径悄悄分叉了。

import { GRADE_PERCENTS, GRADES } from "./config";

// ---------- 指标定义 ----------

export type MetricKey = "stnb" | "bvs" | "ioe" | "corr" | "cls" | "ppc" | "cmp";
/** 重放得出、逐盘落库并建分位基准的六项客观事实（cmp 是合成的，不在内） */
export type BaseMetricKey = Exclude<MetricKey, "cmp">;
/** 参与综合加权的四根分项轴 */
export type AxisMetricKey = "bvs" | "ioe" | "corr" | "cls";

export interface MetricDef<K extends MetricKey = MetricKey> {
  key: K;
  /** 雷达轴名 */
  name: string;
  /** hover 气泡里的完整说明 */
  desc: string;
  /** 数值前缀（STNB / IOE / Corr 这类指标名即单位） */
  prefix: string;
  /** 单位（跟在数值后） */
  unit: string;
  /** 小数位 */
  digits: number;
  /** 是否「越大越好」（移动轴是唯一反向轴） */
  highIsBetter: boolean;
}

/**
 * 六项落库事实：重放得出的客观指标，逐盘存进 video_metrics，每一项都建分位基准。
 * 注意「移动 ppc」已按张老师 2026-10-14 要求移出雷达图，但值照旧落库留存
 * （重放结果是确定性事实，留着不占成本，将来想恢复随时可用）。
 */
export const BASE_METRICS: MetricDef<BaseMetricKey>[] = [
  // 2026-10-14 晚张老师定：气泡里的「3BV/s」与手速单位都放到数值前/整词化 ——
  // 速度轴 3BV/s 由后缀改前缀（气泡读「3BV/s 4.065」），手速由「次/秒」改「次点击/秒」。
  // ⚠️ BASE_METRICS 与 AXIS_METRICS 两处定义必须同步改（录像页与练习页都走 formatMetric）。
  { key: "stnb", name: "综合", desc: "综合评分 STNB", prefix: "STNB", unit: "", digits: 1, highIsBetter: true },
  { key: "bvs", name: "速度", desc: "每秒完成 3BV", prefix: "3BV/s", unit: "", digits: 3, highIsBetter: true },
  { key: "ioe", name: "效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true },
  { key: "corr", name: "精准", desc: "有效操作占比", prefix: "Corr", unit: "", digits: 3, highIsBetter: true },
  { key: "cls", name: "手速", desc: "每秒点击数", prefix: "", unit: "次点击/秒", digits: 2, highIsBetter: true },
  { key: "ppc", name: "移动", desc: "每击鼠标行程", prefix: "", unit: "格/次", digits: 2, highIsBetter: false },
];

/**
 * 雷达的四根分项轴 —— 自顶部「综合」起顺时针：速度 / 效率 / 精准 / 手速。
 * 综合分就是这四项在（级别 × 模式）组内百分位的加权平均，见 compositeOf。
 */
export const AXIS_METRICS: MetricDef<AxisMetricKey>[] = [
  { key: "bvs", name: "速度", desc: "每秒完成 3BV", prefix: "3BV/s", unit: "", digits: 3, highIsBetter: true },
  { key: "ioe", name: "效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true },
  { key: "corr", name: "精准", desc: "有效操作占比", prefix: "Corr", unit: "", digits: 3, highIsBetter: true },
  { key: "cls", name: "手速", desc: "每秒点击数", prefix: "", unit: "次点击/秒", digits: 2, highIsBetter: true },
];

export const BASE_METRIC_KEYS: BaseMetricKey[] = BASE_METRICS.map((m) => m.key);
export const AXIS_METRIC_KEYS: AxisMetricKey[] = AXIS_METRICS.map((m) => m.key);

/** 指标值格式化（气泡展示），如 `STNB 87.0` / `3BV/s 4.065` / `8.50 次点击/秒` */
export function formatMetric(key: MetricKey, value: number): string {
  const def = BASE_METRICS.find((m) => m.key === key);
  if (!def) return String(value);
  const num = value.toFixed(def.digits);
  return [def.prefix, num, def.unit].filter((s) => s !== "").join(" ");
}

// ---------- 分组与综合分 ----------

/** 分位基准的最小样本量：不足则不产出该组（页面退化为不出雷达盒） */
export const MIN_DIST_SIZE = 30;

/**
 * 分位分组 = **级别 × 模式（标雷/无猜）**，不细分 3BV（张老师 2026-10-14 定）。
 *
 * 历史：初版按「级别 × 模式 × 精确 3BV」分组（bucket = 该盘 3BV 原值，507 行基准）。
 * 后改为只按级别 × 模式：① 不同 3BV 的盘没法横向比（3BV 越小越容易刷高 3BV/s）；
 * ② 细分后稀疏组合样本不足、要回退，口径反而不一致。现在全站只有 6 个组
 * （beg/int/exp × 标雷/无猜），每组样本万级，足够稳。
 *
 * video_metric_dist 的 bucket 列保留（唯一键的一部分），**恒写 -1**。
 */
export const DIST_BUCKET_ALL = -1;

/**
 * 综合分的权重（张老师 2026-10-14 定：只在「级别 × 模式」组内做百分位加权，
 * 不考虑 3BV，且不同级别不能放一起比较）。
 *
 * 现为**等权** —— 四项各占 1/4。要偏重某几项直接改这里的数字即可（不必改逻辑），
 * 改完跑一次批就会重算全站 composite 与组内排名。
 *
 * 为什么不用 STNB 当综合：STNB 只由「用时 + 3BV + 级别」构成，与「速度」轴是同一份
 * 信息的两种折算，用它排榜会被初级小局面垄断（实测 beg 3BV=2/0.09s 得 5671，
 * 而 exp 3BV=123/25.1s 的世界纪录只有 223）。百分位加权才跨 3BV 可比。
 */
export const COMPOSITE_WEIGHTS: Record<MetricKey, number> = {
  bvs: 1,
  ioe: 1,
  corr: 1,
  cls: 1,
  // 不参与加权：stnb 已被本分取代；ppc 已移出雷达；cmp 是本分自身
  stnb: 0,
  ppc: 0,
  cmp: 0,
};

/** 综合分 = 四轴组内百分位的加权平均（0-100，本身就是百分位量纲，可直接当综合轴的半径） */
export function compositeOf(percents: Partial<Record<MetricKey, number>>): number {
  let sum = 0;
  let wsum = 0;
  for (const def of AXIS_METRICS) {
    const w = COMPOSITE_WEIGHTS[def.key] ?? 0;
    if (w <= 0) continue;
    sum += (percents[def.key] ?? 0) * w;
    wsum += w;
  }
  return wsum > 0 ? Math.round((sum / wsum) * 10) / 10 : 0;
}

/**
 * 「本局表现」评级（在线玩结算面板标题右侧「评级：S+」）的权重 —— 2026-10-15 张老师定：
 * **综合(STNB) 占一半，速度 / 效率 / 精准 / 手速 各 1/8**。
 *
 * 与 COMPOSITE_WEIGHTS 是两回事：后者是雷达「综合」轴的历史口径（已被 STNB 原值取代），
 * 这里用的是五围图**全部五根轴**的组内分位加权，只在结算面板标题上用，不落库。
 * 要偏重某项直接改数字（不必改逻辑）。
 */
export const PERFORMANCE_KEYS: MetricKey[] = ["stnb", "bvs", "ioe", "corr", "cls"];

/** 权重（4:1:1:1:1 = 50% + 12.5%×4）；未参与的两项恒 0 */
export const PERFORMANCE_WEIGHTS: Record<MetricKey, number> = {
  stnb: 4,
  bvs: 1,
  ioe: 1,
  corr: 1,
  cls: 1,
  ppc: 0,
  cmp: 0,
};

/**
 * 本局表现分 = 五围图各轴组内分位的加权平均（0-100）。
 * 它本身就是百分位量纲，可直接过 GRADE_PERCENTS 九档表出等级（gradeFromPercent）。
 */
export function performanceOf(percents: Partial<Record<MetricKey, number>>): number {
  let sum = 0;
  let wsum = 0;
  for (const key of PERFORMANCE_KEYS) {
    const w = PERFORMANCE_WEIGHTS[key] ?? 0;
    if (w <= 0) continue;
    sum += (percents[key] ?? 0) * w;
    wsum += w;
  }
  return wsum > 0 ? Math.round((sum / wsum) * 10) / 10 : 0;
}

// ---------- 分位与等级（移植 Assess::grade / Assess::percent 语义） ----------

/** 线性插值分位数（升序数组，p 为 0-100） */
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 由样本值构建 9 档分位边界（与 GRADES / GRADE_PERCENTS 同位序）。
 * dist[0] 对应 GRADE_PERCENTS[0]=100（最强），所以：
 *   越大越好 → 边界降序（QG 同理）；越小越好（移动轴）→ 边界升序。
 * 注意：单调性修正循环**必须加花括号**——写成
 * `if (A) for (...) if (B) X; else Y;` 会触发悬空 else（2026-10-14 实测踩过）。
 */
export function buildDist(values: number[], highIsBetter: boolean): number[] {
  const s = [...values].map(Number).sort((a, b) => a - b);
  const dist = GRADE_PERCENTS.map((g) => quantile(s, highIsBetter ? g : 100 - g));
  if (highIsBetter) {
    for (let i = 1; i < dist.length; i++) if (dist[i] > dist[i - 1]) dist[i] = dist[i - 1];
  } else {
    for (let i = 1; i < dist.length; i++) if (dist[i] < dist[i - 1]) dist[i] = dist[i - 1];
  }
  return dist;
}

/** 移植 Assess::getPosition（末尾档位钳位，避免 GRADES[9] = undefined） */
function getPosition(value: number, dist: number[], highIsBetter: boolean): number {
  for (let i = 0; i < dist.length; i++) {
    if (highIsBetter ? value >= dist[i] : value <= dist[i]) return i;
  }
  return Math.min(dist.length, GRADES.length - 1);
}

/**
 * 档位内的插值上界。
 *
 * ⚠️ 原版 Assess::percent 这里是 `distribution[position-1] - 1` —— 那是**整数分**场景的
 * 产物（旧站 Distribution 阈值都是整数，减 1 表示「上一档的最高分」）。本站 IOE / Corr
 * 是 0~1 的比率，减 1 会把上界变成负数：实测 Corr=0.752 落在 [0.73, 0.77] 档内、
 * 真实约 55 分位，带 -1 的版本算出 49，**比本档下界 50 还低**，明显越界。
 * 连续量直接用上一档阈值当上界即可。
 */
function upperBound(dist: number[], position: number): number {
  return dist[position - 1];
}

/** 等级（SSS~F，含 +/-） */
export function gradeOf(value: number, dist: number[], highIsBetter: boolean): string {
  if (!value || dist.length === 0) return "?";
  const position = getPosition(value, dist, highIsBetter);
  if (position === 0 || position >= GRADES.length - 1) return GRADES[Math.min(position, GRADES.length - 1)];
  const maxScore = upperBound(dist, position);
  const minScore = dist[position];
  const range = Math.abs(maxScore - minScore);
  if (range === 0) return GRADES[position];
  const rate = Math.abs(maxScore - value) / range;
  if (rate > 0.6666) return GRADES[position] + "-";
  if (rate < 0.3333) return GRADES[position] + "+";
  return GRADES[position];
}

/** 超越百分比（0-100） */
export function percentOf(value: number, dist: number[], highIsBetter: boolean): number {
  if (!value || dist.length === 0) return 0;
  const position = getPosition(value, dist, highIsBetter);
  if (position === 0) return GRADE_PERCENTS[0];
  const maxPercent = GRADE_PERCENTS[position - 1] - 1; // 百分位档是整数档，减 1 正确（沿用原版）
  const minPercent = GRADE_PERCENTS[position];
  const maxScore = upperBound(dist, position); // 分数上界是连续量，不能减 1 —— 见 upperBound 注释
  const minScore = dist[position];
  const rangeScore = Math.abs(maxScore - minScore);
  if (rangeScore === 0) return minPercent;
  const offset = Math.abs(maxScore - value);
  const fix = Math.floor((offset * (maxPercent - minPercent)) / rangeScore);
  return Math.max(maxPercent - fix, 0);
}

/**
 * 由百分位反推等级 —— 综合分本身就是百分位，没有独立的分布可建，
 * 所以走 GRADE_PERCENTS 档位表而不是 gradeOf（后者需要 dist 边界）。
 */
export function gradeFromPercent(p: number): string {
  if (!p) return "?";
  if (p >= GRADE_PERCENTS[0]) return GRADES[0];
  for (let i = 1; i < GRADE_PERCENTS.length; i++) {
    if (p > GRADE_PERCENTS[i]) {
      const upper = GRADE_PERCENTS[i - 1] - 1;
      const lower = GRADE_PERCENTS[i];
      const range = Math.abs(upper - lower);
      if (range === 0) return GRADES[i];
      const rate = Math.abs(upper - p) / range;
      if (rate > 0.6666) return GRADES[i] + "-";
      if (rate < 0.3333) return GRADES[i] + "+";
      return GRADES[i];
    }
  }
  return GRADES[GRADES.length - 1];
}

// ---------- 等级配色（雷达图 SSS~F，三处展示共用一份） ----------

export const GRADE_COLORS: Record<string, string> = {
  SSS: "#E6DB74",
  SS: "#E6DB74",
  S: "#E6DB74",
  A: "#ff0080",
  B: "#df00a6",
  C: "#bf00cc",
  D: "#a000e5",
  E: "#8000ff",
  // F 改暗灰（2026-10-15 八期张老师定）：原 #6600cc 深紫在深色底上几乎看不见；
  // 用站内常规弱化灰 #8a8878（与雷达轴名同色阶）。「所有雷达图同步」= 本表是
  // 唯一来源（实力雷达 RadarChart / 录像分析 / 结算面板评级都走 gradeColor）
  F: "#8a8878",
};
/** 无成绩 / 未评级（?）的兜底色 */
export const UNKNOWN_COLOR = "#636359";

/** 等级 → 颜色（自动吃掉 SSS+ / A- 这类尾缀；未知等级回退 UNKNOWN_COLOR） */
export function gradeColor(grade: string): string {
  return GRADE_COLORS[grade.replace(/[+-]$/, "")] ?? UNKNOWN_COLOR;
}
