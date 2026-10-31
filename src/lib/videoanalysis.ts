// 录像详情页「录像评级」雷达取数：指标 → 分位/等级 + 本局综合评级
// 数据源 video_metrics（逐盘）+ video_metric_dist（分位基准），均由 scripts/video-metrics.ts 跑批产出。
// 缺行兜底：指标缺 → 补算（videometrics.ts，与审核后置钩子同一个幂等入口）；
//           基准组缺 → 不出雷达盒。
//
// 口径（2026-10-31 张老师定稿）：
//   · **所有级别、NF 和 FL 录像分开评**——五轴全部在「级别 × 模式」组内比；
//   · 五轴：稀有程度（顶，time/3bvs/stnb 三合一取最强）/ 移动速度（cps，右上）/
//     操作效率（thrp，右下）/ 路线规划（bpp，左下，同级别 3BV 低中高三桶）/
//     有效点击（ces，左上）；
//   · 综合评级：**稀有程度为主（4 份）+ 四维各 1 份**加权（PERFORMANCE_WEIGHTS），
//     与练习页结算面板「评级：S+」同一个算法（lib/videoscore.ts performanceOf +
//     gradeFromPercent），两处不许各写一份。

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
import { bucketName, bucketRangeText } from "./videoscore";
import { LEVEL_NAMES, MIN_3BV_FOR_3BVS } from "./config";
import type { MetricKey } from "./videoradar";
import type { VideoAnalysisPoint } from "./videoscore";
import { ensureVideoMetrics } from "./videometrics";

/* VideoAnalysisPoint 的类型定义 2026-10-16 迁到 lib/videoscore.ts（纯数据类型；全屏试玩
   「我的评级」在客户端要算同一套点，引不动本模块）。这里原样再导出，老 import 路径不变。 */
export type { VideoAnalysisPoint };

/** 录像评级盒的取数结果 */
export interface VideoAnalysisResult {
  /** 五根轴（2026-10-30 改版；2026-10-31 定稿全轴组内比）：稀有程度（三合一，
   *  key 锚 stnb）置顶 + 移动速度（右上）/ 操作效率（右下）/ 路线规划（左下，
   *  3BV 三桶）/ 有效点击（左上） */
  points: VideoAnalysisPoint[];
  /** 综合评级（S+/A-…）：稀有为主 4 份 + 四维各 1 份加权，与练习页结算面板同算法 */
  overall: string;
  /** 综合评级对应的表现分（0-100，百分位量纲，调试/对账用） */
  overallScore: number;
  /** 组内基准（2026-10-31 定稿：**全轴**走级别×模式组——time/bvs/stnb/thrp/ces/cps
   *  整组行 + bpp 3BV 三桶行优先）。全屏试玩结束时的「我的评级」要拿
   *  **同一个基准组**给玩家本局打分（与首页录像评级可比），客户端算分必须拿到这份边界数组。 */
  dists: Partial<Record<MetricKey, number[]>>;
  /** 气泡池描述（2026-10-31 张老师定，如「高级NF玩家」）——轴 hover 气泡与
   *  客户端「我的评级」同源用 */
  poolDesc: string;
  /** 路线规划桶前缀（「在小图上」等，统一模板「在…上超过 xx% 的池」）；null＝整组回退 */
  bppBucketPrefix: string | null;
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
 * 级别×模式整组行（2026-10-31 张老师定稿：**所有轴**按组内比——time/bvs/stnb/thrp/
 * ces/cps 全走这行的边界；桶行只服务 bpp）。行缺失返回 null（对应轴 "?"）。
 */
async function getWholeRow(level: string, noflag: boolean): Promise<DistRow | null> {
  try {
    const row = await prisma.videoMetricDist.findUnique({
      where: { level_noflag_bucket: { level, noflag, bucket: DIST_BUCKET_ALL } },
      select: { size: true, bvs: true, ioe: true, thrp: true, corr: true, cls: true, ppc: true, bpp: true, stnb: true, time: true, ces: true, cps: true } as const,
    });
    return row && row.size >= MIN_DIST_SIZE ? row : null;
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
  // time 列 2026-10-31 起消费（稀有程度 time 分项按同级别组比）；ces/cps 仍只在
  // 全网池行用，但一起带上无害（getOnlineMetricDists 才是练习页取数口）。
  const select = { size: true, bvs: true, ioe: true, thrp: true, corr: true, cls: true, ppc: true, bpp: true, stnb: true, time: true } as const;
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

    // ① 五轴组装全部移交共享件 radarPointsFrom（2026-10-30 改版；2026-10-31 定稿
    //    **全轴组内比**）；本函数只负责把原始值与基准备齐。
    //    values：bvs / stnb / thrp / bpp 来自 video_metrics 落库事实；
    //    ces = Ce÷秒、cps = crossings÷秒 现算（列未落库，纯除法）。
    //    ⚠️ time 用 **Est RTime**（2026-10-31 张老师定）——败局的半截用时不能直接
    //    进组内比 time（否则未完成局个个「全网第一」）。est = t × 3BV ÷ 已完成 3BV；
    //    落库 bvs = solved÷t（analyzeVideo 口径）⇒ est = bbbv÷bvs 一除即得。
    //    **胜局识别**（video 表无胜负列，bvs 舍入反推有 ~0.01% 噪声——328090 实测
    //    25.102 vs 25.100 恰好跌破 SSS 边界 25.1）：est 与 t 相对偏差 <0.5% 视为胜局，
    //    直接用原值 t（精确等于成绩口径）；败局偏差大、用 est 折算值。
    //    dist 的 time 列样本本就只含胜局（跑批 status=20），基准是胜局分布。
    const sec = input.realTime / 1000;
    const bvsVal = Number(row.bvs);
    const estRaw = bvsVal > 0 ? input.bbbv / bvsVal : sec;
    const estSec = Math.abs(estRaw - sec) / sec < 0.005 ? sec : estRaw;
    const values: Partial<Record<MetricKey, number>> = {
      time: estSec,
      bvs: bvsVal,
      stnb: Number(row.stnb),
      thrp: Number(row.thrp),
      bpp: Number(row.bpp),
      ces: sec > 0 && row.ce > 0 ? row.ce / sec : 0,
      cps: sec > 0 && row.cp > 0 ? row.cp / sec : 0,
    };
    // group 池（2026-10-31 张老师定稿：**所有轴**按级别×模式组内比）：
    // 整组行带全 time/bvs/stnb/thrp/ces/cps（跑批都在写）；bpp 用 3BV 三桶行
    // （getBaseline 已按桶取好，桶行缺失时它就是整组行，天然回退）。
    const whole = await getWholeRow(input.level, input.noflag);
    const groupDists: Partial<Record<MetricKey, number[]>> = {
      bpp: distFor(baseline.row, "bpp"),
      time: distFor(whole, "time"),
      bvs: distFor(whole, "bvs"),
      stnb: distFor(whole, "stnb"),
      thrp: distFor(whole, "thrp"),
      ces: distFor(whole, "ces"),
      cps: distFor(whole, "cps"),
    };
    // crossings 未回填的存量行（cp=0，全量重放欠账期）：移动速度轴没有真实值——
    // 该轴 dist 也撤掉（dist 缺 → disp「—」+ ?），避免「0.00 次跨格/秒」配 ? 档的怪形态
    if (!(Number(row.cp) > 0)) {
      values.cps = 0;
      delete groupDists.cps;
    }
    // 初级运气盘（3BV<10）自身：3bvs / STNB 成绩不被承认（2026-10-31 张老师定，
    // 与跑批基准划线 MIN_3BV_FOR_3BVS.beg=10 同口径）——两分项不评级（dist 撤掉
    // → ?），稀有程度三合一里 time 仍正常参与；试玩「我的评级」复用本 dists 自动跟随
    if (input.level === "beg" && input.bbbv < MIN_3BV_FOR_3BVS.beg) {
      values.bvs = 0;
      values.stnb = 0;
      delete groupDists.bvs;
      delete groupDists.stnb;
    }
    // 气泡池描述（2026-10-31 张老师定）：「高级NF玩家」式分桶说明——NF/FL 都显式
    // 带模式词（例句「超过72%的高级NF玩家」）；路线规划在「超过……」前加桶前缀
    // 「在小图上/在中图上/在大图上」（与其他轴统一模板，2026-10-31 定稿；
    // 桶行回退整组＝null 不带）
    const lvName = LEVEL_NAMES[input.level as keyof typeof LEVEL_NAMES] ?? input.level;
    const modeName = input.noflag ? "NF" : "FL";
    const poolDesc = `${lvName}${modeName}玩家`;
    const bkName = bucketName(input.level, baseline.bucket);
    const bppBucketPrefix = bkName ? `在${bkName}上` : null;
    const rateable = !!Object.values(groupDists).some((d) => d && d.length);
    const points = radarPointsFrom(values, groupDists, rateable, input.noflag, undefined, poolDesc, bppBucketPrefix);

    // ② 盒标题右侧的「综合评级」（2026-10-31 定稿：稀有为主 4 份 + 四维各 1 份）——
    //    与练习页同算法（radarOverall），此处直接复用 points。
    const overall = radarOverall(points);
    const percents: Partial<Record<MetricKey, number>> = {};
    for (const p of points) percents[p.key] = p.percent;
    const overallScore = performanceOf(percents);

    return {
      points,
      overall,
      overallScore,
      /* 组内边界原样带出（全轴组内比）：全屏试玩「我的评级」在客户端按同一组
         给玩家本局打分，边界数组必须与首页录像评级完全同源 */
      dists: groupDists,
      /* 气泡池描述（轴气泡 + 客户端「我的评级」同源） */
      poolDesc,
      /* 实际命中桶的区间文案（问号气泡用；回退整组＝null，文案不带 3BV 限定） */
      bucketRange: bucketRangeText(input.level, baseline.bucket),
      /* 路线规划桶描述（客户端「我的评级」气泡同源用；整组回退＝null） */
      bppBucketPrefix,
    };
  } catch {
    return null;
  }
}
