// 录像详情页「录像评级」雷达取数：指标 → 分位/等级 + 本局综合评级
// 数据源 video_metrics（逐盘）+ video_metric_dist（分位基准），均由 scripts/video-metrics.ts 跑批产出。
// 缺行兜底：指标缺 → 补算（videometrics.ts，与审核后置钩子同一个幂等入口）；
//           基准组缺 → 不出雷达盒。
//
// 口径（张老师 2026-10-14 定）：
//   · 分组只按 **级别 × 模式（标雷/无猜）**，不细分 3BV，也不同级别之间比；
//   · 雷达 **五轴**：综合（置顶）/ 速度 / 效率 / 精准 / 手速 —— 原「移动」轴已去掉；
//   · 综合轴 = **STNB 原值**（2026-10-14 晚张老师定：数值与评级都回到 STNB 组内分位）。
//     历史：中间版本曾用「四轴百分位加权平均（compositeOf）」，已弃；排行榜落库字段
//     video_metrics.composite 的口径同步见 scripts/video-metrics.ts。
//   · 盒标题右侧的**综合评级**（2026-10-15 张老师定）走 PERFORMANCE_WEIGHTS 五轴加权
//     （STNB 占一半、四分项各 1/8）——**与练习页结算面板「评级：S+」同一个算法**
//     （lib/videoscore.ts performanceOf + gradeFromPercent），两处不许各写一份。

import { prisma } from "./db";
import {
  AXIS_METRICS,
  DIST_BUCKET_ALL,
  formatMetric,
  gradeFromPercent,
  gradeOf,
  MIN_DIST_SIZE,
  performanceOf,
  percentOf,
} from "./videoradar";
import type { MetricKey } from "./videoradar";
import { ensureVideoMetrics } from "./videometrics";

export interface VideoAnalysisPoint {
  key: MetricKey;
  /** 轴名 */
  name: string;
  /** 原始值（综合轴即加权百分位） */
  value: number;
  /** 气泡里的格式化数值 */
  disp: string;
  /** 该维度超越了百分之多少的玩家（0-100） */
  percent: number;
  /** 等级（SSS~F，含 +/-） */
  grade: string;
}

/** 录像评级盒的取数结果 */
export interface VideoAnalysisResult {
  /** 五根轴：综合（STNB）置顶 + 速度 / 效率 / 精准 / 手速 */
  points: VideoAnalysisPoint[];
  /** 综合评级（S+/A-…）：五轴组内分位加权，与练习页结算面板同算法 */
  overall: string;
  /** 综合评级对应的表现分（0-100，百分位量纲，调试/对账用） */
  overallScore: number;
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
  corr: string;
  cls: string;
  ppc: string;
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
    corr: row.corr,
    cls: row.cls,
    ppc: row.ppc,
    cmp: "", // 综合是合成的，没有自己的分布
  };
  return parseDist(map[key]);
}

/** 取该盘所属「级别 × 模式」组的分位基准（group 内样本不足则不产出行） */
async function getBaseline(level: string, noflag: boolean): Promise<DistRow | null> {
  const row = await prisma.videoMetricDist.findUnique({
    where: { level_noflag_bucket: { level, noflag, bucket: DIST_BUCKET_ALL } },
    select: { size: true, bvs: true, ioe: true, corr: true, cls: true, ppc: true, stnb: true },
  });
  return row && row.size >= MIN_DIST_SIZE ? row : null;
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

    const baseline = await getBaseline(input.level, input.noflag);
    if (!baseline) return null;

    // ① 四根分项轴（顺带攒下各轴组内分位，供综合评级加权）
    const percents: Partial<Record<MetricKey, number>> = {};
    const subs: VideoAnalysisPoint[] = AXIS_METRICS.map((def) => {
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

    // ② 综合轴置顶：**STNB 原值**（张老师 2026-10-14 晚定：数值与评级都回到 STNB 口径，
    //    弃用中途的「四轴百分位加权平均」）。半径与气泡「超过 xx%」用 STNB 在组内的分位，
    //    等级走同一份分布 + gradeOf —— 与其余四轴同一套算法，口径自洽。
    //    STNB 分布列（video_metric_dist.stnb）本来就随跑批一起产出，无需额外数据。
    const stnbValue = Number(row.stnb);
    const stnbDist = distFor(baseline, "stnb");
    const stnbPercent = stnbDist.length ? percentOf(stnbValue, stnbDist, true, "stnb") : 0;
    const composite: VideoAnalysisPoint = {
      key: "stnb",
      name: "综合",
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
    };
  } catch {
    return null;
  }
}
