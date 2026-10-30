// 录像详情页「录像评级」雷达取数：指标 → 分位/等级 + 本局综合评级
// 数据源 video_metrics（逐盘）+ video_metric_dist（分位基准），均由 scripts/video-metrics.ts 跑批产出。
// 缺行兜底：指标缺 → 补算（videometrics.ts，与审核后置钩子同一个幂等入口）；
//           基准组缺 → 不出雷达盒。
//
// 口径（张老师 2026-10-14 定；2026-10-28 轴调整）：
//   · 分组只按 **级别 × 模式（标雷/无猜）**，不细分 3BV，也不同级别之间比；
//   · 雷达 **五轴**（2026-10-28 晚张老师定四字名）：判雷能力（置顶，2026-10-19 定改名，
//     原「综合」）/ 开图速度 / 操作效率 / 路线规划 / 点击速度（旧名：判雷/速度/效率/走位/手速）
//     —— 原「移动」轴已去掉；原「精准」corr 轴 2026-10-28 换「路线规划」
//     （2026-10-29 起 v2 口径 = 完成3BV/Crossings，分母换跨格次数；2026-10-30 定名）；
//     「操作效率」按组选指标：NF=IOE / FL=ThrP（张老师 2026-10-28 定）；
//   · 综合轴 = **STNB 原值**（2026-10-14 晚张老师定：数值与评级都回到 STNB 组内分位）。
//     历史：中间版本曾用「四轴百分位加权平均（compositeOf）」，已弃；排行榜落库字段
//     video_metrics.composite 的口径同步见 scripts/video-metrics.ts。
//   · 盒标题右侧的**综合评级**（2026-10-15 张老师定）走 PERFORMANCE_WEIGHTS 五轴加权
//     （STNB 占一半、四分项各 1/8）——**与练习页结算面板「评级：S+」同一个算法**
//     （lib/videoscore.ts performanceOf + gradeFromPercent），两处不许各写一份。

import { prisma } from "./db";
import {
  DIST_BUCKET_ALL,
  bucketOf,
  axisMetricsFor,
  formatMetric,
  gradeFromPercent,
  gradeOf,
  MIN_DIST_SIZE,
  performanceOf,
  percentOf,
  radarOverall,
  radarPointsFrom,
} from "./videoradar";
import { bucketRangeText } from "./videoscore";
import type { MetricKey } from "./videoradar";
import type { VideoAnalysisPoint } from "./videoscore";
import { ensureVideoMetrics } from "./videometrics";

/* VideoAnalysisPoint 的类型定义 2026-10-16 迁到 lib/videoscore.ts（纯数据类型；全屏试玩
   「我的评级」在客户端要算同一套点，引不动本模块）。这里原样再导出，老 import 路径不变。 */
export type { VideoAnalysisPoint };

/** 录像评级盒的取数结果 */
export interface VideoAnalysisResult {
  /** 五根轴（2026-10-30 改版）：稀有程度（三合一，key 锚 stnb）置顶 + 移动速度（右上）/
   *  操作效率（右下）/ 路线规划（左下，3BV 三桶）/ 有效点击（左上） */
  points: VideoAnalysisPoint[];
  /** 综合评级（S+/A-…）：五轴分位加权，与练习页结算面板同算法 */
  overall: string;
  /** 综合评级对应的表现分（0-100，百分位量纲，调试/对账用） */
  overallScore: number;
  /** 路线规划轴的分位基准（同级别 × 模式 × 3BV 三桶行，缺行回退整组行）。
   *  全屏试玩结束时的「我的评级」要拿**同一个基准组**给玩家本局打分
   *  （与首页录像评级可比），客户端算分必须拿到这份边界数组。 */
  dists: Partial<Record<MetricKey, number[]>>;
  /** 全网池基准（2026-10-30 五轴改版，level='all' 行按 NF/FL 分池后那份：
   *  time/bvs/stnb/ces/cps/thrp → 9 档边界）——稀有程度三合一 / 移动速度 /
   *  操作效率 / 有效点击四轴 + 客户端「我的评级」同源用 */
  allDists: Partial<Record<MetricKey, number[]>>;
  /** 实际命中的 3BV 粗桶区间文案（如 "120-139"；2026-10-30 张老师需求：
   *  标题问号气泡要讲清「在哪个桶里评的」）。null＝整组行（桶行缺样本回退 /
   *  自定义盘等无桶级别），文案不带 3BV 限定。 */
  bucketRange: string | null;
}

export interface VideoAnalysisInput {
  id: number;
  level: string;
  noflag: boolean;
  bbbv: number;
  /** 库内权威用时（毫秒）——速度类指标必须与页面标题的 3BV/s 同源 */
  realTime: number;
  filepath: string;
}

type DistRow = {
  size: number;
  bvs: string;
  ioe: string;
  thrp: string;
  corr: string;
  cls: string;
  ppc: string;
  bpp: string;
  stnb: string;
  /** 2026-10-30 五轴改版：全网池行（level='all'）专供——普通行恒 "" */
  time?: string | null;
  ces?: string | null;
  cps?: string | null;
};

function parseDist(raw: string | undefined | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .filter((s) => s !== "")
    .map(Number);
}

function distFor(row: DistRow | null, key: MetricKey): number[] {
  if (!row) return [];
  const map: Record<MetricKey, string | null | undefined> = {
    stnb: row.stnb,
    bvs: row.bvs,
    ioe: row.ioe,
    thrp: row.thrp,
    corr: row.corr,
    cls: row.cls,
    ppc: row.ppc,
    bpp: row.bpp,
    cmp: "", // 综合是合成的，没有自己的分布
    time: row.time,
    ces: row.ces,
    cps: row.cps,
  };
  return parseDist(map[key]);
}

/**
 * 全网池基准（2026-10-30 五轴改版）：level='all' 行（NF/FL 各一，跑批写）——
 * 「稀有程度」（time/3bvs/stnb 三合一）/「移动速度」（cps）/「操作效率」（thrp）/
 * 「有效点击」（ces）四轴的全网评级边界。行缺失（跑批未升级前）返回空对象，
 * 对应轴显示 "?"（详情页兜底不炸，只是那几轴暂无评级）。
 */
async function getAllPool(noflag: boolean): Promise<DistRow | null> {
  try {
    return await prisma.videoMetricDist.findUnique({
      where: { level_noflag_bucket: { level: "all", noflag, bucket: DIST_BUCKET_ALL } },
    });
  } catch {
    return null;
  }
}

/**
 * 取该盘所属「级别 × 模式 × 3BV 粗桶」的分位基准（2026-10-29 v2）：
 * 先查该盘 3BV 所属桶行（同规模盘互比，治「初级低/小图低/大图难S」的 3BV 结构偏置），
 * 桶行不存在或样本不足 MIN_DIST_SIZE → 回退整组行（bucket=-1）。
 * 跑批对每组**同时写**桶行与整组行，这里不命中桶行只可能是极端 3BV 段（样本 <30）。
 *
 * 2026-10-30：带回**实际命中桶的 bucket 值**（问号气泡文案要说清在哪个桶里评的；
 * 回退整组时为 DIST_BUCKET_ALL）——命中与否必须以这里实际查到的行为准，
 * 不能拿 bucketOf 的理论值（桶行可能缺样回退）。
 */
async function getBaseline(
  level: string,
  noflag: boolean,
  bbbv: number
): Promise<{ row: DistRow | null; bucket: number }> {
  const select = { size: true, bvs: true, ioe: true, thrp: true, corr: true, cls: true, ppc: true, bpp: true, stnb: true } as const;
  const bucket = bucketOf(level, bbbv);
  if (bucket !== DIST_BUCKET_ALL) {
    const row = await prisma.videoMetricDist.findUnique({
      where: { level_noflag_bucket: { level, noflag, bucket } },
      select,
    });
    if (row && row.size >= MIN_DIST_SIZE) return { row, bucket };
  }
  const all = await prisma.videoMetricDist.findUnique({
    where: { level_noflag_bucket: { level, noflag, bucket: DIST_BUCKET_ALL } },
    select,
  });
  return { row: all && all.size >= MIN_DIST_SIZE ? all : null, bucket: DIST_BUCKET_ALL };
}

/**
 * 计算某盘录像的五维分析数据。
 * 返回 null 表示「没有可用基准」（跑批未产出该组），此时页面不渲染雷达盒。
 *
 * ⚠️ 全流程包 try/catch：这两张表是本功能新加的，只要线上还没跑过 db push（或表被误删、
 *    连接抖动），查询会抛错；宁可少显示一个雷达盒，也绝不能把录像详情页打成 500。
 */
export async function getVideoAnalysis(input: VideoAnalysisInput): Promise<VideoAnalysisResult | null> {
  try {
    let row = await prisma.videoMetrics.findUnique({ where: { id: BigInt(input.id) } });
    if (!row) {
      // 缺行自愈：与审核后置钩子共用同一个幂等写入口，补完再读一遍
      await ensureVideoMetrics(input.id);
      row = await prisma.videoMetrics.findUnique({ where: { id: BigInt(input.id) } });
    }
    if (!row) return null;

    const baseline = await getBaseline(input.level, input.noflag, input.bbbv);
    if (!baseline.row) return null;
    // 全网池行（2026-10-30 五轴改版）：跑批未升级 / 行缺失时为 null——
    // 走全网池的四轴（稀有程度/移动速度/操作效率/有效点击）显示 "?"，页面不炸
    const allPool = await getAllPool(input.noflag);

    // ① 五轴组装全部移交共享件 radarPointsFrom（2026-10-30 改版：三合一取最高 /
    //    全网池 / 3BV 三桶都在里面）；本函数只负责把原始值与两份基准备齐。
    //    values：time 秒 / bvs / stnb / thrp / bpp 来自 video_metrics 落库事实；
    //    ces = Ce÷秒、cps = crossings÷秒 现算（列未落库，纯除法）。
    const sec = input.realTime / 1000;
    const values: Partial<Record<MetricKey, number>> = {
      time: sec,
      bvs: Number(row.bvs),
      stnb: Number(row.stnb),
      thrp: Number(row.thrp),
      bpp: Number(row.bpp),
      ces: sec > 0 && row.ce > 0 ? row.ce / sec : 0,
      cps: sec > 0 && row.cp > 0 ? row.cp / sec : 0,
    };
    const allDists: Partial<Record<MetricKey, number[]>> = {
      time: distFor(allPool, "time"),
      bvs: distFor(allPool, "bvs"),
      stnb: distFor(allPool, "stnb"),
      thrp: distFor(allPool, "thrp"),
      ces: distFor(allPool, "ces"),
      cps: distFor(allPool, "cps"),
    };
    // crossings 未回填的存量行（cp=0，全量重放欠账期）：移动速度轴没有真实值——
    // 该轴 dist 也撤掉（dist 缺 → disp「—」+ ?），避免「0.00 次跨格/秒」配 ? 档的怪形态
    if (!(Number(row.cp) > 0)) {
      values.cps = 0;
      delete allDists.cps;
    }
    const groupDists: Partial<Record<MetricKey, number[]>> = {
      bpp: distFor(baseline.row, "bpp"),
    };
    const rateable = !!(allPool || distFor(baseline.row, "bpp").length);
    const points = radarPointsFrom(values, groupDists, rateable, input.noflag, allDists);

    // ② 盒标题右侧的「综合评级」：五轴分位加权（稀有程度 key=stnb 占一半）——
    //    与练习页同算法（radarOverall），此处直接复用 points。
    const overall = radarOverall(points);
    const percents: Partial<Record<MetricKey, number>> = {};
    for (const p of points) percents[p.key] = p.percent;
    const overallScore = performanceOf(percents);

    return {
      points,
      overall,
      overallScore,
      /* 路线规划轴的 9 档边界原样带出：全屏试玩「我的评级」在客户端按同一组
         给玩家本局打分，边界数组必须与首页录像评级完全同源 */
      dists: groupDists,
      /* 全网池边界同源带出（2026-10-30）：客户端「我的评级」四轴全网评级用 */
      allDists,
      /* 实际命中桶的区间文案（问号气泡用；回退整组＝null，文案不带 3BV 限定） */
      bucketRange: bucketRangeText(input.level, baseline.bucket),
    };
  } catch {
    return null;
  }
}
