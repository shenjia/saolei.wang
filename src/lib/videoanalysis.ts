// 录像详情页「录像分析」雷达取数：指标 → 分位/等级
// 数据源 video_metrics（逐盘）+ video_metric_dist（分位基准），均由 scripts/video-metrics.ts 跑批产出。
// 缺行兜底：指标缺 → 补算（videometrics.ts，与审核后置钩子同一个幂等入口）；
//           基准段缺 → 回退到同级别同模式的全组行（bucket=-1）。

import { prisma } from "./db";
import {
  bbbvBucket,
  formatMetric,
  gradeOf,
  METRICS,
  MIN_DIST_SIZE,
  percentOf,
} from "./videoradar";
import type { MetricKey } from "./videoradar";
import { ensureVideoMetrics } from "./videometrics";

export interface VideoAnalysisPoint {
  key: MetricKey;
  /** 轴名 */
  name: string;
  /** 原始值 */
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
  };
  return parseDist(map[key]);
}

/** 取分区基准：优先「级别 × 模式 × 3BV 段」，样本不足回退全组行 */
async function getBaseline(level: string, noflag: boolean, bbbv: number): Promise<{ row: DistRow | null; fallback: boolean }> {
  const bucket = bbbvBucket(level, bbbv);
  const exact = await prisma.videoMetricDist.findUnique({
    where: { level_noflag_bucket: { level, noflag, bucket } },
    select: { size: true, bvs: true, ioe: true, corr: true, cls: true, ppc: true, stnb: true },
  });
  if (exact && exact.size >= MIN_DIST_SIZE) return { row: exact, fallback: false };
  const wide = await prisma.videoMetricDist.findUnique({
    where: { level_noflag_bucket: { level, noflag, bucket: -1 } },
    select: { size: true, bvs: true, ioe: true, corr: true, cls: true, ppc: true, stnb: true },
  });
  return { row: wide ?? null, fallback: true };
}

/**
 * 计算某盘录像的六维分析数据。
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

    const { row: baseline } = await getBaseline(input.level, input.noflag, row.bbbv || input.bbbv);
    if (!baseline) return null;

    return METRICS.map((def) => {
      const value = Number(row[def.key]);
      const dist = distFor(baseline, def.key);
      return {
        key: def.key,
        name: def.name,
        value,
        disp: formatMetric(def.key, value),
        percent: dist.length ? percentOf(value, dist, def.highIsBetter) : 0,
        grade: dist.length ? gradeOf(value, dist, def.highIsBetter) : "?",
      };
    });
  } catch {
    return null;
  }
}
