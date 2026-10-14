// 录像详情页「录像分析」雷达取数：指标 → 分位/等级
// 数据源 video_metrics（逐盘）+ video_metric_dist（分位基准），均由 scripts/video-metrics.ts 跑批产出。
// 缺行兜底：指标缺 → 补算（videometrics.ts，与审核后置钩子同一个幂等入口）；
//           基准组缺 → 不出雷达盒。
//
// 口径（张老师 2026-10-14 定）：
//   · 分组只按 **级别 × 模式（标雷/无猜）**，不细分 3BV，也不同级别之间比；
//   · 雷达 **五轴**：综合（置顶）/ 速度 / 效率 / 精准 / 手速 —— 原「移动」轴已去掉；
//   · 综合 = 其余四轴在组内百分位的加权平均（见 videoradar.ts compositeOf），
//     不再用 STNB（STNB 只由用时+3BV 构成，与「速度」是同一份信息，跨 3BV 不可比）。

import { prisma } from "./db";
import {
  AXIS_METRICS,
  compositeOf,
  DIST_BUCKET_ALL,
  formatMetric,
  gradeFromPercent,
  gradeOf,
  MIN_DIST_SIZE,
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
export async function getVideoAnalysis(input: VideoAnalysisInput): Promise<VideoAnalysisPoint[] | null> {
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

    // ① 四根分项轴
    const percents: Partial<Record<MetricKey, number>> = {};
    const subs: VideoAnalysisPoint[] = AXIS_METRICS.map((def) => {
      const value = Number(row[def.key]);
      const dist = distFor(baseline, def.key);
      const percent = dist.length ? percentOf(value, dist, def.highIsBetter) : 0;
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

    // ② 综合轴置顶：四轴百分位的加权平均。它本身就是百分位量纲，
    //    所以半径、气泡里的「超过 xx%」读数都用同一个值，等级由档位表反推。
    const cmp = compositeOf(percents);
    const composite: VideoAnalysisPoint = {
      key: "cmp",
      name: "综合",
      value: cmp,
      disp: `综合 ${cmp.toFixed(1)} 分`,
      percent: cmp,
      grade: gradeFromPercent(cmp),
    };

    return [composite, ...subs];
  } catch {
    return null;
  }
}
