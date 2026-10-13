// 军衔与评级计算，移植自 2013 版 PHP 的 logic/Assess.php
// 评级（grade/percent）阈值仍缓存于 distribution 表（取最新一行），字段为逗号分隔的分数阈值
// 军衔（title）2026-10-13 起改为高级时间绝对阈值制（TITLE_THRESHOLDS 常量），不再读 distribution.title

import { prisma } from "./db";
import {
  GRADE_PERCENTS,
  GRADES,
  ORDER_DIRECTION,
  TITLE_THRESHOLDS,
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

/** 军衔：按高级时间绝对阈值评定（2026-10-13 张老师改版，原按总计时间相对阈值）
 *  TITLE_THRESHOLDS 与 TITLES 同序（严→宽降序）：取第一个 score <= threshold 的档；
 *  全部超过（>150s）→ 列兵；无成绩 → 预备役 */
export function title(score: number | null | undefined): string {
  if (!score) return "预备役";
  for (let i = 0; i < TITLE_THRESHOLDS.length; i++) {
    if (score <= TITLE_THRESHOLDS[i]) return TITLES[i] ?? "";
  }
  return TITLES[TITLES.length - 1] ?? "";
}

export interface TitleDistribution {
  /** 各军衔的高级时间上限（毫秒，升序；2026-10-13 起为常量 TITLE_THRESHOLDS） */
  thresholds: number[];
  /** 编制总人数（SUB 制下无意义，恒 0） */
  size: number;
  /** 颁布时间（Unix 秒；SUB 制下为 0） */
  createTime: number;
}

/** 军衔体系页的分布数据（2026-10-13 起数据源为常量；保留接口兼容旧调用方） */
export function getTitleDistribution(): TitleDistribution {
  return { thresholds: TITLE_THRESHOLDS, size: 0, createTime: 0 };
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
