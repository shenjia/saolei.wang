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

export type MetricKey = "stnb" | "bvs" | "ioe" | "thrp" | "corr" | "cls" | "ppc" | "bpp" | "cmp" | "time" | "ces" | "cps";
/** 重放得出、逐盘落库并建分位基准的客观事实（cmp 是合成的，不在内） */
export type BaseMetricKey = Exclude<MetricKey, "cmp">;
/**
 * 雷达分项轴的候选键。2026-10-30 五轴改版（张老师定）——五轴全部换新口径：
 *   ① 稀有程度（顶）：time / 3bvs / stnb 三者各评级后**取最高档**展示（三合一，
 *      见 radarPointsFrom；2026-10-31 张老师定稿：三分项全部按**级别 × 模式**组内比
 *      ——先分初中高、再分 FL/NF，跨级混比无意义）；
 *   ② 有效点击（左上）：CES = Ce/s 全网评级；
 *   ③ 移动速度（右上）：crossings/s 全网评级；
 *   ④ 路线规划（左下）：solved3bv/crossings 在**同级别 3BV 低中高三桶**内评级（BV3 桶）；
 *   ⑤ 操作效率（右下）：Thrp 全网评级（不再按 NF/FL 组二选一）。
 * 全网池供数：跑批 video-metrics.ts 写 level='all' 行（NF/FL 各一），列 ces/cps/thrp
 * （移动速度/操作效率/有效点击三轴），取数见 videoanalysis distFor 的 'all' 分支；
 * 稀有程度三分项走级别×模式整组行（time/bvs/stnb 列跑批都在写）。
 */
export type AxisMetricKey = "bvs" | "ioe" | "thrp" | "bpp" | "cls" | "ces" | "cps" | "time";

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
  // 2026-10-30 五轴改版（张老师定）新增的全网评级指标（基准池 = 全站过审胜局，
  // NF/FL 分开；不入 BASE_METRICS——它们没有「级别×桶」分组基准，由全网池行供数）：
  // time：用时（秒）——「稀有程度」三合一之一，越小越好（越小越快越稀有）；
  // ces：有效点击速度 = Ce ÷ 用时秒（CES）——「有效点击」轴；
  // cps：移动速度 = crossings ÷ 用时秒——「移动速度」轴（crossings 对回报率免疫，
  //      不用 path：同回报率偏置会虚高，张老师点名 crossings/Rtime）。
  { key: "time", name: "稀有程度", desc: "用时（秒）", prefix: "", unit: "秒", digits: 2, highIsBetter: false },
  { key: "ces", name: "有效点击", desc: "每秒有效点击数", prefix: "CES", unit: "", digits: 2, highIsBetter: true },
  { key: "cps", name: "移动速度", desc: "每秒跨格次数", prefix: "", unit: "次跨格/秒", digits: 2, highIsBetter: true },
];

/**
 * 雷达的四根分项轴（2026-10-30 五轴改版张老师定）——自顶部「稀有程度」起顺时针：
 * 右上「移动速度」（cps=Crossings/s）/ 右下「操作效率」（Thrp）/ 左下「路线规划」
 * （完成3BV/Crossings，同级别 3BV 低中高三桶内评级）/ 左上「有效点击」（CES=Ce/s）。
 * 除「路线规划」外的三根都走**全网池**（level='all' 行，NF/FL 分池）。
 * ⚠️ 此数组只描述「分项轴的字面定义」（formatMetric/气泡/标签用）；各轴的取数池
 * 与等级计算已高度定制（三合一取最高 / 全网池 / 三桶），组装见 radarPointsFrom，
 * 不再是「一组 dist 逐轴评」的简单模型——axisMetricsFor 的调用方只剩格式化场景。
 */
export function axisMetricsFor(noflag: boolean): MetricDef<AxisMetricKey>[] {
  // noflag 参数 2026-10-30 起不再影响轴选择（操作效率恒 ThrP、全网池 NF/FL 分池在取数侧做）；
  // 保留签名避免破坏三处消费方（radarPointsFrom / videoanalysis / OnlinePlay 的 import）。
  void noflag;
  return [
    { key: "cls", name: "有效点击", desc: "每秒有效点击数", prefix: "CES", unit: "", digits: 2, highIsBetter: true },
    { key: "cps", name: "移动速度", desc: "每秒跨格次数", prefix: "", unit: "次跨格/秒", digits: 2, highIsBetter: true },
    { key: "thrp", name: "操作效率", desc: "每次有效操作换回的 3BV（chord 收益）", prefix: "ThrP", unit: "", digits: 3, highIsBetter: true },
    { key: "bpp", name: "路线规划", desc: "每跨一次格换回的完成 3BV", prefix: "完成3BV/Crossings", unit: "", digits: 3, highIsBetter: true },
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
 * 3BV 三桶边界（2026-10-30 五轴改版张老师定：路线规划按**同级别 3BV 低中高只分三个桶**）。
 * 数组是各桶**下界**，升序 [0, midLo, hiLo]：低 [0,midLo) / 中 [midLo,hiLo) / 高 [hiLo,∞)。
 * 边界张老师 2026-10-31 亲定（替换首版的 p33/p67 分位取整——分位桶高级过宽、
 * 初级过窄，改手工锚点）：beg 9/18、int 45/75、exp 145/175。
 * 即：初级 小图≤8 / 中图 9-17 / 大图≥18；中级 小图≤44 / 中图 45-74 / 大图≥75；
 * 高级 小图≤144 / 中图 145-174 / 大图≥175。
 */
export const BV_BUCKETS: Partial<Record<string, number[]>> = {
  beg: [0, 9, 18],
  int: [0, 45, 75],
  exp: [0, 145, 175],
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
 * 3BV 三桶的口语名（2026-10-31 张老师定：路线规划 hover 气泡要带「在高级**小图**上
 * 超过 xx% 的 NF 玩家」这类分桶说明）。桶值 = BV_BUCKETS 下界：0=低（小图）/
 * 中段=中 / 最大下界=高（大图）；无桶级别 / 整组回退返回 null（气泡不带限定）。
 */
export function bucketName(level: string, bucket: number): string | null {
  if (bucket === DIST_BUCKET_ALL) return null;
  const edges = BV_BUCKETS[level];
  if (!edges) return null;
  const i = edges.indexOf(bucket);
  if (i < 0) return null;
  if (i === edges.length - 1) return "大图";
  return i === 0 ? "小图" : "中图";
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
  // 不参与加权：stnb 已被本分取代；ppc/corr 已移出雷达；cmp 是本分自身；
  // time/ces/cps 是 2026-10-30 五轴改版的全网池专用键，无「级别×桶」分组基准不参与
  stnb: 0,
  ppc: 0,
  cmp: 0,
  time: 0,
  ces: 0,
  cps: 0,
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
 * 「本局表现」评级（在线玩结算面板标题右侧「评级：S+」）的权重 —— 2026-10-31 张老师定稿：
 * **稀有程度为主占四份，其余四轴各一份**（4:1:1:1:1 = 稀有 4/8=50%，四维各 1/8），
 * 加权平均后过九档表出等级。稀有程度轴 key 锚 stnb（吃 4 权重），移动 cps / 操作 thrp /
 * 路线 bpp / 有效 ces 各 1。ioe/cls/bvs/time 不出现在雷达点上，不进加权。
 *
 * 与 COMPOSITE_WEIGHTS 是两回事：后者是雷达「综合」轴的历史口径（已被 STNB 原值取代），
 * 这里用的是五围图**全部五根轴**的组内分位加权，只在结算面板标题上用，不落库。
 * 要偏重某项直接改数字（不必改逻辑）。
 */
export const PERFORMANCE_KEYS: MetricKey[] = ["stnb", "bvs", "ioe", "thrp", "bpp", "cls", "cps", "ces"];

/** 权重（4:1:1:1:1 = 稀有为主 50% + 四维各 12.5%；雷达五轴外的键恒 0 不参与）；未参与的两项恒 0 */
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
  cps: 1,
  ces: 1,
  time: 0,
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
 * bvs / cls / stnb / thrp / cps 无固定理论上限、组内最大值只有真正最强的一盘，维持「全网第一」。
 * （2026-10-30 五轴改版补：ces 与 ioe 同性质——Ce 有理论上限节奏，慢玩零废操作
 * 即可顶格，封顶不说「全网第一」。）
 */
export const NO_FIRST_METRICS: ReadonlySet<MetricKey> = new Set(["corr", "ioe", "bpp", "ces"]);
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
  /** 气泡「超过 xx% 的 XX玩家」里的比对池描述（2026-10-31 张老师定：所有轴气泡要
   *  说明分桶——如「高级NF玩家」）。组件层拼文案，这里只给池名（levelName + nf 后缀） */
  pool?: string;
  /** 路线规划轴专用的桶前缀（「在小图上」/「在中图上」/「在大图上」，2026-10-31
   *  张老师定稿：与其他轴统一模板，仅在「超过……」前加桶限定；普通轴 undefined） */
  prefix?: string;
}

/**
 * 五轴雷达点组装（2026-10-30 五轴改版张老师定，三处共用：录像详情页右栏 /
 * 练习页结算面板 / 全屏试玩「我的评级」——2026-10-14 副本分叉的教训，口径只此一份）：
 *
 *   ① 稀有程度（顶）：time / 3bvs / stnb 三者各评级后**取最高档**展示（半径用三者
 *      的最高 percent；气泡 disp 显示最能代表该盘稀有性的那项的数值——按 percent
 *      最高者）。池子（2026-10-31 张老师定稿）：三分项全部在**同级别 × 同模式组内**比
 *      （先分初中高、再分 FL/NF——time/bvs 跨级别混比无意义，stnb 虽难度归一化
 *      也统一按组内比，口径一致），全部走 group 池（级别×模式整组行）；
 *   ② 移动速度（右上）：cps = crossings ÷ 用时秒；
 *   ③ 操作效率（右下）：thrp；
 *   ④ 路线规划（左下）：bpp = 完成3BV ÷ crossings，**同级别 3BV 低中高三桶**内评级
 *      （group 参数：桶行缺失自动回退整组行，由调用方取好传入）；
 *   ⑤ 有效点击（左上）：ces = Ce ÷ 用时秒。
 *   ⚠️ 池子（2026-10-31 张老师定稿）：**全部五轴都在同级别 × 同模式组内比**
 *   （「所有级别、NF和FL录像分开评」）——cps/thrp/ces 也从 group 池取（整组行），
 *   全网池（allDists）已无消费方、参数保留仅为兼容旧调用签名。
 *
 * @param values 本局原始指标值（time 秒 / bvs / stnb / thrp / bpp / cps / ces）
 * @param group 同级别×模式组基准：五轴全部从这里取——稀有程度三分项与 cps/thrp/ces
 *   用整组行，路线规划 bpp 用 3BV 三桶行优先（缺行即整组行回退）
 * @param poolDesc 气泡池描述（如「高级NF玩家」）——组件层拼气泡用
 * @param bppBucketPrefix 路线规划的桶前缀（「在小图上」/「在中图上」/「在大图上」，
 *   2026-10-31 张老师定稿：与其他轴统一模板，只在「超过……」前加桶限定；
 *   null/undefined=桶行回退整组时不带）
 * @param rateable 是否可评级（缺基准 / 零点击 / 完成度过低＝false）
 *   —— false 时全轴 disp "—"、percent 0、grade "?"（雷达收缩到圆心的空图，值仍保留）
 * @param noflag 打法（保留签名兼容；池选择已收敛到 group，不再分 NF/FL 全网池）
 */
export function radarPointsFrom(
  values: Partial<Record<MetricKey, number>>,
  group: Partial<Record<MetricKey, number[]>> | undefined,
  rateable: boolean,
  noflag = false,
  allDists?: Partial<Record<MetricKey, number[]>>,
  poolDesc?: string,
  bppBucketPrefix?: string | null,
): VideoAnalysisPoint[] {
  void noflag;
  void allDists; // 2026-10-31 定稿后无消费（全轴组内）；参数保留防三处调用方连锁改签名
  // 单指标轴：从 group 池取边界评级
  const axis = (
    key: AxisMetricKey,
    name: string,
    dist: number[] | undefined,
    highIsBetter: boolean,
    pool: string | undefined,
    prefix?: string,
  ): VideoAnalysisPoint => {
    const value = values[key] ?? 0;
    const d = dist ?? [];
    return {
      key,
      name,
      value,
      disp: d.length ? formatMetric(key, value) : "—",
      percent: d.length ? percentOf(value, d, highIsBetter, key) : 0,
      grade: d.length ? gradeOf(value, d, highIsBetter) : "?",
      pool,
      prefix,
    };
  };
  // ① 稀有程度（三合一取最高）：time（反向）/ 3bvs / stnb 各自评级，
  //    取主档最高者展示；radius（percent）取三者最大（雷达画的是「稀有性强度」）；
  //    disp 取 percent 最高那项的格式化值（最能代表这盘为什么稀有）。
  //    主档序：SSS(0) 最强 … F(8) 最弱——比较用 GRADES.indexOf(主档)。
  //    ⚠️ 池子（2026-10-31 张老师定稿）：三分项全部走 group（级别×模式整组行，
  //    先分初中高再分 FL/NF）——不再用全网池。
  const rarityParts = [
    { key: "time" as const, name: "time", dist: group?.time, hib: false },
    { key: "bvs" as const, name: "3bvs", dist: group?.bvs, hib: true },
    { key: "stnb" as const, name: "stnb", dist: group?.stnb, hib: true },
  ].map((p) => ({
    ...p,
    value: values[p.key] ?? 0,
    percent: p.dist?.length ? percentOf(values[p.key] ?? 0, p.dist!, p.hib, p.key) : 0,
    grade: p.dist?.length ? gradeOf(values[p.key] ?? 0, p.dist!, p.hib) : "?",
  }));
  const rated = rarityParts.filter((p) => p.grade !== "?");
  const best = rated.length
    ? rated.reduce((a, b) => {
        const ra = GRADES.indexOf(a.grade.replace(/[+-]$/, "") as (typeof GRADES)[number]);
        const rb = GRADES.indexOf(b.grade.replace(/[+-]$/, "") as (typeof GRADES)[number]);
        // 主档相同取 percent 高者（档内更稀有）
        return rb < ra || (rb === ra && b.percent > a.percent) ? b : a;
      })
    : null;
  const rarity: VideoAnalysisPoint = {
    key: "stnb", // 语义锚定判雷/综合谱系（复活降档 demoteGrade 仍打在这根轴上）
    name: "稀有程度",
    value: best ? best.value : values.stnb ?? 0,
    disp: best ? formatMetric(best.key, best.value) : "—",
    percent: best ? Math.max(...rated.map((p) => p.percent)) : 0,
    grade: best ? best.grade : "?",
    pool: poolDesc,
  };
  const all: VideoAnalysisPoint[] = [
    rarity,
    axis("cps", "移动速度", group?.cps, true, poolDesc), // 右上
    axis("thrp", "操作效率", group?.thrp, true, poolDesc), // 右下
    // 左下：同级别 3BV 三桶内；气泡统一模板 + prefix「在小图上」等桶限定
    //（2026-10-31 张老师定稿；桶行回退整组＝不带 prefix）
    axis("bpp", "路线规划", group?.bpp, true, poolDesc, bppBucketPrefix ?? undefined),
    axis("ces", "有效点击", group?.ces, true, poolDesc), // 左上
  ];
  return rateable ? all : all.map((p) => ({ ...p, disp: "—", percent: 0, grade: "?" }));
}

/**
 * 五轴组内分位加权出的**综合评级**（2026-10-31 张老师定稿：稀有程度为主占四份、
 * 其余四轴各一份，见 PERFORMANCE_WEIGHTS）。全轴都无可评级（grade 全 "?")→ 返回
 * "?"（面板显示「—」）。
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
