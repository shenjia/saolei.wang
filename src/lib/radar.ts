// 实力雷达图数据：移植 2013 版 logic/Assess.php + logic/Distribution.php
// 8 个维度 = 排序(time/3bvs) × 级别(sum/exp/int/beg)，按全服成绩分布评定百分比与等级

import { prisma } from "@/lib/db";
import { GRADES, GRADE_PERCENTS, ORDER_DIRECTION, type Level, type Order } from "@/lib/config";
import { score3bvs, scoreTime } from "@/lib/format";

export interface RadarPoint {
  /** 维度名，如「总计时间」 */
  name: string;
  /** 格式化后的成绩，如 46.65 / 5.832 */
  score: string;
  /** 0-100 的百分位 */
  percent: number;
  /** 等级，如 SSS / A+ / B- / ? */
  grade: string;
}

const RADAR_LEVELS: Level[] = ["sum", "exp", "int", "beg"];
const RADAR_ORDERS: Order[] = ["time", "3bvs"];

const LEVEL_NAMES: Record<Level, string> = {
  beg: "初级",
  int: "中级",
  exp: "高级",
  sum: "总计",
};
// 雷达图维度名从简（张老师 2026-09-23：去掉「记录」二字），与 config.ORDER_NAMES 区分
const ORDER_NAMES: Record<Order, string> = {
  time: "时间",
  "3bvs": "3BV/s",
};

// 分布缓存（对应 PHP 的 Distribution::$distribution 静态缓存）
let distributionCache: Record<string, number[]> | null = null;

async function getDistribution(): Promise<Record<string, number[]>> {
  if (distributionCache) return distributionCache;
  const row = await prisma.distribution.findFirst({ orderBy: { id: "desc" } });
  const result: Record<string, number[]> = {};
  if (row) {
    const rec = row as unknown as Record<string, string>;
    for (const level of RADAR_LEVELS) {
      for (const order of RADAR_ORDERS) {
        const field = level + (order === "time" ? "Time" : "3bvs");
        result[`${level}_${order}`] = (rec[field] ?? "")
          .split(",")
          .filter((s) => s !== "")
          .map(Number);
      }
    }
  }
  distributionCache = result;
  return result;
}

/** 移植 Assess::getPosition */
function getPosition(score: number, dist: number[], direction: "asc" | "desc"): number {
  for (let i = 0; i < dist.length; i++) {
    if (direction === "desc") {
      if (score >= dist[i]) return i;
    } else {
      if (score <= dist[i]) return i;
    }
  }
  return dist.length;
}

/** 移植 Assess::grade */
function grade(dist: number[], direction: "asc" | "desc", score: number): string {
  if (score === 0 || dist.length === 0) return "?";
  const position = getPosition(score, dist, direction);
  if (position === 0 || position === GRADES.length - 1) return GRADES[position];

  const maxScore = dist[position - 1] - 1;
  const minScore = dist[position];
  const range = Math.abs(maxScore - minScore);
  if (range === 0) return GRADES[position];

  const rate = Math.abs(maxScore - score) / range;
  if (rate > 0.6666) return GRADES[position] + "-";
  if (rate < 0.3333) return GRADES[position] + "+";
  return GRADES[position];
}

/** 移植 Assess::percent */
function percent(dist: number[], direction: "asc" | "desc", score: number): number {
  if (score === 0 || dist.length === 0) return 0;
  const position = getPosition(score, dist, direction);
  if (position === 0) return GRADE_PERCENTS[0];

  const maxPercent = GRADE_PERCENTS[position - 1] - 1;
  const minPercent = GRADE_PERCENTS[position];
  const maxScore = dist[position - 1] - 1;
  const minScore = dist[position];
  const rangeScore = Math.abs(maxScore - minScore);
  if (rangeScore === 0) return minPercent;

  const offset = Math.abs(maxScore - score);
  const fix = Math.floor((offset * (maxPercent - minPercent)) / rangeScore);
  return Math.max(maxPercent - fix, 0);
}

/**
 * 计算用户雷达图 8 个维度数据
 * @param scores getUserDetail 返回的 scores（键为 `${level}_${order}`，score 为原始值）
 */
export async function getRadarData(
  scores: Record<string, { score: number | null }>
): Promise<RadarPoint[]> {
  const distribution = await getDistribution();
  const points: RadarPoint[] = [];

  for (const order of RADAR_ORDERS) {
    for (const level of RADAR_LEVELS) {
      const raw = scores[`${level}_${order}`]?.score ?? 0;
      const dist = distribution[`${level}_${order}`] ?? [];
      const direction = ORDER_DIRECTION[order];
      points.push({
        name: LEVEL_NAMES[level] + ORDER_NAMES[order],
        score: raw > 0 ? (order === "time" ? scoreTime(raw) : score3bvs(raw)) : "无",
        percent: percent(dist, direction, raw),
        grade: grade(dist, direction, raw),
      });
    }
  }
  return points;
}
