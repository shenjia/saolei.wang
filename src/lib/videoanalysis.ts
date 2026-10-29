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
//     （2026-10-29 起 v2 口径 = 3BV/CP，分母换跨格次数）；
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
} from "./videoradar";
import type { MetricKey } from "./videoradar";
import type { VideoAnalysisPoint } from "./videoscore";
import { ensureVideoMetrics } from "./videometrics";

/* VideoAnalysisPoint 的类型定义 2026-10-16 迁到 lib/videoscore.ts（纯数据类型；全屏试玩
   「我的评级」在客户端要算同一套点，引不动本模块）。这里原样再导出，老 import 路径不变。 */
export type { VideoAnalysisPoint };

/** 录像评级盒的取数结果 */
export interface VideoAnalysisResult {
  /** 五根轴：判雷能力（STNB）置顶 + 开图速度 / 操作效率 / 路线规划 / 点击速度 */
  points: VideoAnalysisPoint[];
  /** 综合评级（S+/A-…）：五轴组内分位加权，与练习页结算面板同算法 */
  overall: string;
  /** 综合评级对应的表现分（0-100，百分位量纲，调试/对账用） */
  overallScore: number;
  /** 该组（级别 × 模式）的分位基准：指标 → 9 档边界。
   *  2026-10-16 新增：全屏试玩结束时的「我的评级」要拿**同一个基准组**给玩家本局打分
   *  （与首页录像评级可比），客户端算分必须拿到这份边界数组。 */
  dists: Partial<Record<MetricKey, number[]>>;
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
  const map: Record<MetricKey, string> = {
    stnb: row.stnb,
    bvs: row.bvs,
    ioe: row.ioe,
    thrp: row.thrp,
    corr: row.corr,
    cls: row.cls,
    ppc: row.ppc,
    bpp: row.bpp,
    cmp: "", // 综合是合成的，没有自己的分布
  };
  return parseDist(map[key]);
}

/**
 * 取该盘所属「级别 × 模式 × 3BV 粗桶」的分位基准（2026-10-29 v2）：
 * 先查该盘 3BV 所属桶行（同规模盘互比，治「初级低/小图低/大图难S」的 3BV 结构偏置），
 * 桶行不存在或样本不足 MIN_DIST_SIZE → 回退整组行（bucket=-1）。
 * 跑批对每组**同时写**桶行与整组行，这里不命中桶行只可能是极端 3BV 段（样本 <30）。
 */
async function getBaseline(level: string, noflag: boolean, bbbv: number): Promise<DistRow | null> {
  const select = { size: true, bvs: true, ioe: true, thrp: true, corr: true, cls: true, ppc: true, bpp: true, stnb: true } as const;
  const bucket = bucketOf(level, bbbv);
  if (bucket !== DIST_BUCKET_ALL) {
    const row = await prisma.videoMetricDist.findUnique({
      where: { level_noflag_bucket: { level, noflag, bucket } },
      select,
    });
    if (row && row.size >= MIN_DIST_SIZE) return row;
  }
  const all = await prisma.videoMetricDist.findUnique({
    where: { level_noflag_bucket: { level, noflag, bucket: DIST_BUCKET_ALL } },
    select,
  });
  return all && all.size >= MIN_DIST_SIZE ? all : null;
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
    if (!baseline) return null;

    // ① 四根分项轴（顺带攒下各轴组内分位，供综合评级加权）
    //    2026-10-28 轴调整：「效率」按组选指标（NF=IOE / FL=ThrP）；「路线规划」bpp
    //    2026-10-29 起 = 3BV/CP（分母 crossings）；基准按该盘 3BV 选粗桶（getBaseline）
    const percents: Partial<Record<MetricKey, number>> = {};
    const subs: VideoAnalysisPoint[] = axisMetricsFor(input.noflag).map((def) => {
      const value = Number(row[def.key]);
      const dist = distFor(baseline, def.key);
      const percent = dist.length ? percentOf(value, dist, def.highIsBetter, def.key) : 0;
      percents[def.key] = percent;
      return {
        key: def.key,
        name: def.name,
        value,
        disp: formatMetric(def.key, value),
        percent,
        grade: dist.length ? gradeOf(value, dist, def.highIsBetter) : "?",
      };
    });

    // ② 判雷能力轴（2026-10-19 张老师定改名，原「综合」；2026-10-28 晚定四字名）置顶：**STNB 原值**
    //    （张老师 2026-10-14 晚定：数值与评级都回到 STNB 口径，
    //    弃用中途的「四轴百分位加权平均」）。半径与气泡「超过 xx%」用 STNB 在组内的分位，
    //    等级走同一份分布 + gradeOf —— 与其余四轴同一套算法，口径自洽。
    //    STNB 分布列（video_metric_dist.stnb）本来就随跑批一起产出，无需额外数据。
    const stnbValue = Number(row.stnb);
    const stnbDist = distFor(baseline, "stnb");
    const stnbPercent = stnbDist.length ? percentOf(stnbValue, stnbDist, true, "stnb") : 0;
    const composite: VideoAnalysisPoint = {
      key: "stnb",
      name: "判雷能力",
      value: stnbValue,
      disp: formatMetric("stnb", stnbValue),
      percent: stnbPercent,
      grade: stnbDist.length ? gradeOf(stnbValue, stnbDist, true) : "?",
    };

    // ③ 盒标题右侧的「综合评级」：五轴组内分位加权（STNB 占一半）—— 与练习页同算法。
    //    它本身就是百分位量纲，过 GRADE_PERCENTS 九档表反推等级即可。
    percents.stnb = stnbPercent;
    const overallScore = performanceOf(percents);

    return {
      points: [composite, ...subs],
      overall: overallScore > 0 ? gradeFromPercent(overallScore) : "?",
      overallScore,
      /* 基准组的 9 档边界原样带出（2026-10-16）：全屏试玩「我的评级」在客户端按同一组
         给玩家本局打分，边界数组必须与首页录像评级完全同源 */
      dists: {
        stnb: stnbDist,
        bvs: distFor(baseline, "bvs"),
        ioe: distFor(baseline, "ioe"),
        thrp: distFor(baseline, "thrp"),
        corr: distFor(baseline, "corr"),
        cls: distFor(baseline, "cls"),
        bpp: distFor(baseline, "bpp"),
      },
    };
  } catch {
    return null;
  }
}
