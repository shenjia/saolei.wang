// 军衔与评级计算，移植自 2013 版 PHP 的 logic/Assess.php
// 阈值缓存于 distribution 表（取最新一行），字段为逗号分隔的分数阈值

import { prisma } from "./db";
import {
  GRADE_PERCENTS,
  GRADES,
  ORDER_DIRECTION,
  TITLE_LEVEL,
  TITLE_ORDER,
  TITLES,
  type Level,
  type Order,
} from "./config";

type DistributionRow = Record<string, string | null> & { id: bigint };

let cached: DistributionRow | null = null;

async function getDistribution(): Promise<DistributionRow | null> {
  if (cached) return cached;
  const row = await prisma.distribution.findFirst({ orderBy: { id: "desc" } });
  if (row) cached = row as unknown as DistributionRow;
  return cached;
}

function parseThresholds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return raw.split(",").map((s) => parseInt(s, 10));
}

/** 在阈值数组中定位（移植 Assess::getPosition） */
function getPosition(score: number, distribution: number[], direction: 0 | 1): number {
  let i = 0;
  for (; i < distribution.length; i++) {
    if (direction === 1) {
      if (score >= distribution[i]) return i;
    } else {
      if (score <= distribution[i]) return i;
    }
  }
  return i;
}

/** 军衔：按总计时间成绩评定（移植 Assess::title）；2026-09-23 起无成绩玩家评为「预备役」（张老师要求） */
export async function title(score: number | null | undefined): Promise<string> {
  if (!score) return "预备役";
  const dist = await getDistribution();
  if (!dist) return "";
  const thresholds = parseThresholds(dist["title"]);
  if (!thresholds.length) return "";
  const direction = ORDER_DIRECTION[TITLE_ORDER] === "desc" ? 1 : 0;
  const position = getPosition(score, thresholds, direction);
  return TITLES[Math.min(position, TITLES.length - 1)] ?? "";
}

export interface TitleDistribution {
  /** 各军衔的总计时间阈值（毫秒，升序） */
  thresholds: number[];
  /** 编制总人数 */
  size: number;
  /** 颁布时间（Unix 秒） */
  createTime: number;
}

/** 军衔体系页的分布数据（对应 Distribution::get('title'/'size'/'create_time')） */
export async function getTitleDistribution(): Promise<TitleDistribution | null> {
  const dist = await getDistribution();
  if (!dist) return null;
  const raw = dist as unknown as Record<string, unknown>;
  return {
    thresholds: parseThresholds(dist["title"]),
    size: Number(raw["size"] ?? 0),
    createTime: Number(raw["createTime"] ?? raw["create_time"] ?? 0),
  };
}

/** 评级：SSS~F（移植 Assess::grade） */
export async function grade(level: Level, order: Order, score: number | null | undefined): Promise<string> {
  if (!score) return "?";
  const dist = await getDistribution();
  if (!dist) return "?";
  const thresholds = parseThresholds(dist[`${level}_${order}`]);
  if (!thresholds.length) return "?";
  const direction = ORDER_DIRECTION[order] === "desc" ? 1 : 0;
  const position = getPosition(score, thresholds, direction);

  if (position === 0 || position >= GRADES.length - 1) return GRADES[Math.min(position, GRADES.length - 1)];

  const maxScore = thresholds[position - 1] - 1;
  const minScore = thresholds[position];
  const range = Math.abs(maxScore - minScore);
  if (range === 0) return GRADES[position];
  const rate = Math.abs(maxScore - score) / range;

  if (rate > 0.6666) return GRADES[position] + "-";
  if (rate < 0.3333) return GRADES[position] + "+";
  return GRADES[position];
}

/** 评级百分比（移植 Assess::percent） */
export async function percent(level: Level, order: Order, score: number | null | undefined): Promise<number> {
  if (!score) return 0;
  const dist = await getDistribution();
  if (!dist) return 0;
  const thresholds = parseThresholds(dist[`${level}_${order}`]);
  if (!thresholds.length) return 0;
  const direction = ORDER_DIRECTION[order] === "desc" ? 1 : 0;
  const position = getPosition(score, thresholds, direction);
  if (position === 0) return GRADE_PERCENTS[0];

  const maxPercent = GRADE_PERCENTS[position - 1] - 1;
  const minPercent = GRADE_PERCENTS[position];
  const rangePercent = maxPercent - minPercent;

  const maxScore = thresholds[position - 1] - 1;
  const minScore = thresholds[position];
  const rangeScore = Math.abs(maxScore - minScore);
  if (rangeScore === 0) return maxPercent;

  const offset = Math.abs(maxScore - score);
  const fix = Math.floor((offset * rangePercent) / rangeScore);
  return Math.max(maxPercent - fix, 0);
}
