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

export type MetricKey = "stnb" | "bvs" | "ioe" | "thrp" | "corr" | "cls" | "ppc" | "bpp" | "cmp";
/** 重放得出、逐盘落库并建分位基准的客观事实（cmp 是合成的，不在内） */
export type BaseMetricKey = Exclude<MetricKey, "cmp">;
/**
 * 雷达分项轴的候选键。「效率」轴按组选指标：FL 用 thrp（chord 收益，组内 r=0.715 优于
 * IOE 的 0.646）、NF 用 ioe（NF 无 chord，thrp 被钉死 ≤1.0 无区分度）——见 axisMetricsFor。
 * 「走位」= 3BV/PATH（2026-10-28 张老师定，替换原「精准 corr」轴）。
 */
export type AxisMetricKey = "bvs" | "ioe" | "thrp" | "bpp" | "cls";

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
 * 八项落库事实：重放得出的客观指标，逐盘存进 video_metrics，每一项都建分位基准。
 * 「移动 ppc」与「精准 corr」已移出雷达，但值照旧落库留存（重放结果是确定性事实，
 * 留着不占成本，将来想恢复随时可用）。
 */
export const BASE_METRICS: MetricDef<BaseMetricKey>[] = [
  // 2026-10-14 晚张老师定：气泡里的「3BV/s」与手速单位都放到数值前/整词化 ——
  // 速度轴 3BV/s 由后缀改前缀（气泡读「3BV/s 4.065」），手速由「次/秒」改「次点击/秒」。
  // ⚠️ BASE_METRICS 与 axisMetricsFor 两处定义必须同步改（录像页与练习页都走 formatMetric）。
  // 2026-10-28 晚张老师定：五轴改四字名（纯文案）——判雷→判雷能力、速度→开图速度、
  // 效率→操作效率、走位→路线规划、手速→点击速度（corr/ppc 已退出雷达，名不动）。
  // ⚠️ BASE_METRICS 与 axisMetricsFor 两处定义必须同步改（录像页与练习页都走 formatMetric）。
  { key: "stnb", name: "判雷能力", desc: "综合评分 STNB", prefix: "STNB", unit: "", digits: 1, highIsBetter: true },
  { key: "bvs", name: "开图速度", desc: "每秒完成 3BV", prefix: "3BV/s", unit: "", digits: 3, highIsBetter: true },
  { key: "ioe", name: "操作效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true },
  { key: "thrp", name: "操作效率", desc: "每次有效操作换回的 3BV（chord 收益）", prefix: "ThrP", unit: "", digits: 3, highIsBetter: true },
  { key: "corr", name: "精准", desc: "有效操作占比", prefix: "Corr", unit: "", digits: 3, highIsBetter: true },
  { key: "cls", name: "点击速度", desc: "每秒点击数", prefix: "", unit: "次点击/秒", digits: 2, highIsBetter: true },
  { key: "ppc", name: "移动", desc: "每击鼠标行程", prefix: "", unit: "格/次", digits: 2, highIsBetter: false },
  // 路线规划（2026-10-29 张老师定口径 v2；2026-10-30 定名）：完成3BV/Crossings ＝
  // 已完成 3BV ÷ 跨格次数。v1（3BV/PATH）分母是事件间欧氏累加的鼠标行程，
  // 受鼠标回报率影响（采样越密抖动进得越多、同一轨迹 Path 越长），且低 3BV 盘
  // 结构性吃亏；v2 分母 crossings 只数跨格线动作、对回报率构造性免疫（探针
  // scripts/cellpath-probe.ts 实测 6/6 组技能区分度优于 PATH）。3BV 结构依赖由
  // 「3BV 分桶基准」治（见 BV_BUCKETS）。⚠️ 展示名一律 Crossings（张老师定），
  // 「CPath」是调研期伞名勿用；DB 列 cp 存的即 crossings 值（缩写不动）。
  { key: "bpp", name: "路线规划", desc: "每跨一次格换回的完成 3BV", prefix: "完成3BV/Crossings", unit: "", digits: 3, highIsBetter: true },
];

/**
 * 雷达的四根分项轴 —— 自顶部「判雷能力」起顺时针：开图速度 / 操作效率 / 路线规划 / 点击速度
 * （2026-10-28 晚张老师定四字名；旧名：速度 / 效率 / 走位 / 手速）。
 * 「操作效率」按组选指标（2026-10-28 张老师定）：FL=ThrP（每次有效操作换回的 3BV，
 * 即 chord 收益），NF=IOE（每点击换回的 3BV）——NF 无 chord，ThrP 恒 ≤1 无区分度。
 * 「路线规划」= 完成3BV/Crossings（2026-10-29 张老师定 v2 口径：分母由鼠标行程
 * 换跨格次数 crossings，对回报率免疫；2026-10-30 定名），替换原「精准」corr 轴
 * （corr 与水平负相关）。
 */
export function axisMetricsFor(noflag: boolean): MetricDef<AxisMetricKey>[] {
  return [
    { key: "bvs", name: "开图速度", desc: "每秒完成 3BV", prefix: "3BV/s", unit: "", digits: 3, highIsBetter: true },
    noflag
      ? { key: "ioe", name: "操作效率", desc: "每点击换回的 3BV", prefix: "IOE", unit: "", digits: 3, highIsBetter: true }
      : { key: "thrp", name: "操作效率", desc: "每次有效操作换回的 3BV（chord 收益）", prefix: "ThrP", unit: "", digits: 3, highIsBetter: true },
    { key: "bpp", name: "路线规划", desc: "每跨一次格换回的完成 3BV", prefix: "完成3BV/Crossings", unit: "", digits: 3, highIsBetter: true },
    { key: "cls", name: "点击速度", desc: "每秒点击数", prefix: "", unit: "次点击/秒", digits: 2, highIsBetter: true },
  ];
}

export const BASE_METRIC_KEYS: BaseMetricKey[] = BASE_METRICS.map((m) => m.key);

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
 * 分位分组 = **级别 × 模式（标雷/无猜）× 3BV 粗桶**（2026-10-29 张老师定，v2）。
 *
 * 历史：初版按「级别 × 模式 × 精确 3BV」分组（bucket = 该盘 3BV 原值，507 行基准），
 * 后改为只按级别 × 模式（bucket 恒 -1）。2026-10-29 用户反馈「初级路线规划特别低、
 * 高级小图偏低、大图很难到 S」——实测 bpp 结构性随 3BV 单调上升（3BV 越多岛越密、
 * 每换回 1 个 3BV 要走的路越短，30.7 万盘实证 beg FL：3BV<5 桶 p50=0.129 vs
 * 3BV 26-32 桶 p50=0.450），与玩家水平无关；整组分位让低 3BV 盘被高 3BV 盘碾压。
 * 换公式（宽×高/Path、CPath、Epath）均实测证伪，病灶在分位组未按 3BV 分层——
 * 故恢复 bucket 分层但改**粗桶**（固定边界，见 BV_BUCKETS），桶内同规模盘互比。
 *
 * video_metric_dist 跑批**同时写**桶行与整组行（bucket=-1）：
 *   · 桶行样本 ≥ MIN_DIST_SIZE 才写；
 *   · 取基准先查桶行，缺行/样本不足回退整组行（getBaseline / computeRadarPoints）；
 *   · composite（STNB 组内分位）与 STNB 榜仍走整组行（STNB 已按难度归一，无此偏置）。
 */
export const DIST_BUCKET_ALL = -1;

/**
 * 3BV 粗桶边界（2026-10-29，与探针 scripts/cellpath-probe.ts 分桶一致）：
 * 数组是各桶**下界**，升序；桶值 = 不超过该盘 3BV 的最大下界（即 [lo, nextLo) 的 lo），
 * 最大桶右开到 ∞。边界取自本地库 3BV 分布的中段（桶内样本数千级、桶间 bpp 中位数
 * 拉得开），极端小 3BV 桶（beg [0,6)）样本也充足；极限大 3BV 桶（beg 27+ / int 85+ /
 * exp 225+）桶内指标区分度衰减（探针实测 ~0），靠 MIN_DIST_SIZE 不足时自动回退整组。
 */
export const BV_BUCKETS: Partial<Record<string, number[]>> = {
  beg: [0, 6, 9, 12, 15, 18, 22, 27],
  int: [0, 35, 45, 55, 65, 75, 85],
  exp: [0, 120, 140, 160, 180, 200, 225],
};

/**
 * 该盘 3BV 所属的粗桶（桶值 = 桶下界；未知级别 / 非法 3BV → DIST_BUCKET_ALL 走整组）。
 * 桶边界三处共用同一份 BV_BUCKETS：跑批建基准、录像详情页 getBaseline、
 * 练习页 computeRadarPoints —— 改边界只改 BV_BUCKETS 一处，然后重跑跑批。
 */
export function bucketOf(level: string, bbbv: number): number {
  const edges = BV_BUCKETS[level];
  if (!edges || !Number.isFinite(bbbv) || bbbv <= 0) return DIST_BUCKET_ALL;
  let lo = DIST_BUCKET_ALL;
  for (const e of edges) if (bbbv >= e) lo = e;
  return lo;
}

/**
 * 桶区间的人话描述（2026-10-30 张老师需求：录像评级标题问号气泡要讲清「在哪个桶里评的」）。
 * 返回 null＝整组行（bucket=-1 或回退），文案里就不带 3BV 限定；返回 "lo-hi"＝闭区间
 * （3BV 是整数，[lo, nextLo) 半开即 [lo, nextLo-1]）；最大桶右开 ∞ →「lo以上」。
 * 纯函数、三处（跑批/录像页/练习页）可共用，桶边界只认 BV_BUCKETS 一份。
 */
export function bucketRangeText(level: string, bucket: number): string | null {
  if (bucket === DIST_BUCKET_ALL) return null;
  const edges = BV_BUCKETS[level];
  if (!edges) return null;
  const i = edges.indexOf(bucket);
  if (i < 0) return null;
  return i === edges.length - 1 ? `${bucket}以上` : `${bucket}-${edges[i + 1] - 1}`;
}

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
  thrp: 1,
  bpp: 1,
  corr: 1,
  cls: 1,
  // 不参与加权：stnb 已被本分取代；ppc/corr 已移出雷达；cmp 是本分自身
  stnb: 0,
  ppc: 0,
  cmp: 0,
};

/** 综合分 = 四轴组内百分位的加权平均（0-100，本身就是百分位量纲，可直接当综合轴的半径）
 *  ⚠️ 已无生产调用方（综合轴 2026-10-14 晚起 = STNB 原值），仅为兼容保留。 */
export function compositeOf(percents: Partial<Record<MetricKey, number>>, noflag = false): number {
  let sum = 0;
  let wsum = 0;
  for (const def of axisMetricsFor(noflag)) {
    const w = COMPOSITE_WEIGHTS[def.key] ?? 0;
    if (w <= 0) continue;
    sum += (percents[def.key] ?? 0) * w;
    wsum += w;
  }
  return wsum > 0 ? Math.round((sum / wsum) * 10) / 10 : 0;
}

/**
 * 「本局表现」评级（在线玩结算面板标题右侧「评级：S+」）的权重 —— 2026-10-15 张老师定：
 * **判雷能力(STNB) 占一半，开图速度 / 操作效率 / 路线规划 / 点击速度 各 1/8**。
 * （2026-10-28 轴调整：原「精准 corr」换「走位 bpp」；效率轴 FL=thrp / NF=ioe ——
 * 两组各自只会提供其中一个键，performanceOf 只对**有值的键**加权。）
 *
 * 与 COMPOSITE_WEIGHTS 是两回事：后者是雷达「综合」轴的历史口径（已被 STNB 原值取代），
 * 这里用的是五围图**全部五根轴**的组内分位加权，只在结算面板标题上用，不落库。
 * 要偏重某项直接改数字（不必改逻辑）。
 */
export const PERFORMANCE_KEYS: MetricKey[] = ["stnb", "bvs", "ioe", "thrp", "bpp", "cls"];

/** 权重（4:1:1:1:1 = 50% + 12.5%×4；ioe/thrp 二选一按组提供）；未参与的两项恒 0 */
export const PERFORMANCE_WEIGHTS: Record<MetricKey, number> = {
  stnb: 4,
  bvs: 1,
  ioe: 1,
  thrp: 1,
  bpp: 1,
  corr: 0,
  cls: 1,
  ppc: 0,
  cmp: 0,
};

/**
 * 本局表现分 = 五围图各轴组内分位的加权平均（0-100）。
 * 它本身就是百分位量纲，可直接过 GRADE_PERCENTS 九档表出等级（gradeFromPercent）。
 * ⚠️ 只对 percents 里**实际有值**的键加权（无值键不进 wsum）——效率轴 ioe/thrp
 * 按组二选一，缺的那个不能稀释权重。
 */
export function performanceOf(percents: Partial<Record<MetricKey, number>>): number {
  let sum = 0;
  let wsum = 0;
  for (const key of PERFORMANCE_KEYS) {
    const w = PERFORMANCE_WEIGHTS[key] ?? 0;
    if (w <= 0) continue;
    const v = percents[key];
    if (v == null) continue; // 无值键（如另一打法的效率指标）不进权重分母
    sum += v * w;
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

/**
 * 「容易顶格」指标（2026-10-16 张老师定）：corr / ioe 有理论极限，
 * 新手慢慢玩、零废操作即可满分（本地实证：初级无猜组 20.6% 的盘 corr=1.0，
 * 1.3 万盘并列「全网第一」），说「全网第一」明显不合理。
 * bpp 同理（2026-10-28 并入）：最短路线有下界，慢速直走的玩家也能逼近顶格。
 * 这些指标达到组内满分时百分位封顶 NO_FIRST_PERCENT（99.99），
 * 气泡显示「超过 99.99% 的玩家」而非「全网第一」；等级仍按原档位评（SSS 保留）。
 * bvs / cls / stnb / thrp 无固定理论上限、组内最大值只有真正最强的一盘，维持「全网第一」。
 */
export const NO_FIRST_METRICS: ReadonlySet<MetricKey> = new Set(["corr", "ioe", "bpp"]);
export const NO_FIRST_PERCENT = 99.99;

/** 超越百分比（0-100；corr/ioe 等易顶格指标封顶 99.99，见 NO_FIRST_METRICS） */
export function percentOf(value: number, dist: number[], highIsBetter: boolean, key?: MetricKey): number {
  if (!value || dist.length === 0) return 0;
  const position = getPosition(value, dist, highIsBetter);
  if (position === 0) return key && NO_FIRST_METRICS.has(key) ? NO_FIRST_PERCENT : GRADE_PERCENTS[0];
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

// ---------- 五轴雷达点组装（录像详情页 / 练习页结算 / 全屏试玩「我的评级」共用） ----------

/**
 * 单轴雷达点。原定义在 lib/videoanalysis.ts（那个模块挂着 prisma，只能服务端引）——
 * 2026-10-16 迁到本模块：全屏试玩「我的评级」要在**客户端**算同一套点，
 * 引不动 videoanalysis；videoanalysis 原样再导出一份，老 import 路径不变。
 */
export interface VideoAnalysisPoint {
  key: MetricKey;
  /** 轴名 */
  name: string;
  /** 原始值（综合轴即 STNB 原值） */
  value: number;
  /** 气泡里的格式化数值 */
  disp: string;
  /** 该维度超越了百分之多少的玩家（0-100） */
  percent: number;
  /** 等级（SSS~F，含 +/-） */
  grade: string;
}

/**
 * 五轴雷达点组装：判雷能力（STNB 原值）置顶 + 开图速度 / 操作效率 / 路线规划 / 点击速度
 * （2026-10-28 晚张老师定四字名，旧名：判雷 / 速度 / 效率 / 走位 / 手速）。
 * 录像详情页右栏、练习页结算面板、全屏试玩「我的评级」**三处共用这一份**——
 * 2026-10-14 副本分叉的教训（OnlinePlay 曾留本地副本，主模块修了口径副本没跟上）。
 *
 * @param values 本局原始指标值（stnb / bvs / ioe / thrp / bpp / cls）
 * @param group  该组（级别 × 模式）的分位基准：指标 → 9 档边界；缺项 / 空数组 → 该轴冻结为 "?"
 * @param rateable 是否可评级（缺基准 / 零点击 / 完成度过低＝false）
 *   —— false 时全轴 disp "—"、percent 0、grade "?"（雷达收缩到圆心的空图，值仍保留）
 * @param noflag 打法（2026-10-28 起「效率」轴按组选指标：NF=IOE / FL=ThrP）
 */
export function radarPointsFrom(
  values: Partial<Record<MetricKey, number>>,
  group: Partial<Record<MetricKey, number[]>> | undefined,
  rateable: boolean,
  noflag = false,
): VideoAnalysisPoint[] {
  const axis = (key: AxisMetricKey | "stnb", name: string, highIsBetter: boolean): VideoAnalysisPoint => {
    const value = values[key] ?? 0;
    const dist = group?.[key] ?? [];
    return {
      key,
      name,
      value,
      disp: dist.length ? formatMetric(key, value) : "—",
      percent: dist.length ? percentOf(value, dist, highIsBetter, key) : 0,
      grade: dist.length ? gradeOf(value, dist, highIsBetter) : "?",
    };
  };
  const all: VideoAnalysisPoint[] = [
    axis("stnb", "判雷能力", true),
    ...axisMetricsFor(noflag).map((d) => axis(d.key, d.name, d.highIsBetter)),
  ];
  return rateable ? all : all.map((p) => ({ ...p, disp: "—", percent: 0, grade: "?" }));
}

/**
 * 五轴组内分位加权出的**综合评级**（判雷 STNB 占一半、四分项各 1/8，见 PERFORMANCE_WEIGHTS）。
 * 全轴都无可评级（grade 全 "?")→ 返回 "?"（面板显示「—」）。
 */
export function radarOverall(points: VideoAnalysisPoint[]): string {
  if (!points.some((p) => p.grade !== "?")) return "?";
  const percents: Partial<Record<MetricKey, number>> = {};
  for (const p of points) percents[p.key] = p.percent;
  return gradeFromPercent(performanceOf(percents));
}

/**
 * 档位强制下修（2026-10-19 张老师定：在线练习每原地复活一次，雷达「判雷」轴
 * ——原「综合」轴——的档位强制降一级，最低 F；**先独立计算，再加修正**）。
 * 纯函数，练习页结算面板专用；录像详情页（真实对局）不经过这里。
 * 语义：按 GRADES 九档主档（SSS…F）下移 steps 位，落点**不带 +/- 尾缀**
 * （惩罚性钳位不保留细分）；"?"（无法评级）与 F 原样/钳底。
 */
export function demoteGrade(grade: string, steps: number): string {
  if (grade === "?" || steps <= 0) return grade;
  const base = grade.replace(/[+-]$/, "");
  const i = GRADES.indexOf(base as (typeof GRADES)[number]);
  if (i < 0) return grade;
  return GRADES[Math.min(i + steps, GRADES.length - 1)];
}
