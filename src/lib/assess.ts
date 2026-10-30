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

/** 军衔：总司令=雷界排行第一人特判（2026-10-19 张老师改口径，原 SUB30 绝对阈值），
 *  其余按高级时间绝对阈值评定（2026-10-13 张老师改版，原按总计时间相对阈值）
 *  TITLE_THRESHOLDS 与 TITLES 同序（严→宽降序）：取第一个 score <= threshold 的档；
 *  全部超过（>150s）→ 列兵；无成绩 → 预备役。
 *  @param isKing 是否雷界排行第一人（总计时间 TOP1，调用方经 getThunderKingId 判定；
 *                不传/未知时按 SUB35 起评——king 不会掉出大元帅档，保守显示） */
export function title(score: number | null | undefined, isKing = false): string {
  if (isKing) return "总司令";
  if (!score) return "预备役";
  for (let i = 0; i < TITLE_THRESHOLDS.length; i++) {
    if (score <= TITLE_THRESHOLDS[i]) return TITLES[i + 1] ?? "";
  }
  return TITLES[TITLES.length - 1] ?? "";
}

// ---------- 录像语境的军衔评定（2026-10-28 张老师定） ----------
// 上传后产生军衔变化（从无到有/从低到高）的录像，在录像动态与录像列表中按新军衔显示。
// 例：高级 51s（大校）上传一盘 49s → 该录像行按 49s 评定显示「少将」。

/**
 * 录像行的有效评定高级时间：录像行内快照 exp_time（上传时刻、不含本盘）与本盘高级成绩取优。
 * 军衔只随高级时间变——仅高级（level=exp）录像且成绩严格更优（或快照为 0=从无到有）时
 * 返回本盘 real_time，其余（初级/中级盘、更差成绩、脏数据）一律维持快照原值。
 */
export function promotedExpTime(snapExpTime: number, level: string, realTime: number): number {
  if (level === "exp" && realTime > 0 && (snapExpTime === 0 || realTime < snapExpTime)) {
    return realTime;
  }
  return snapExpTime;
}

/**
 * 破纪录动态行的有效评定高级时间：动态快照 exp_time 为破纪录前旧值（review.ts 写入点
 * expTimeOverride=original.expTime 口径），details 的 lv/od/cr 记录坐标与新成绩——
 * 高级时间纪录（lv=exp & od=time）按新成绩 cr 评定。纪录动态只在成绩严格变优（or=0 或
 * cr<or，or 即快照旧值）时发出，cr<快照恒成立；防御性再判一次，异常时回退快照原值。
 *
 * 2026-10-30 泛化（张老师报告 /video/340425 双破军衔不一致）：同盘录像同时破时间+3bvs
 * 两条纪录时，3bvs 纪录行 details 只带 3BV/s 不带时间，此前回退快照旧值显示旧军衔——
 * 与时间纪录行（按新军衔）不一致。统一语义改为「本盘之后实际最好成绩」：
 * 有效评定时间 = min(快照旧值, 本盘 real_time)——本盘更快则按新军衔，否则维持旧军衔。
 * od=time 行 cr 即本盘 real_time（videoRealTime 缺省时兜底）；其余行靠调用方传入
 * videoRealTime（getNews 按关联录像批量带出 NewsItem.videoRealTime）。
 */
export function recordNewsExpTime(
  newsExpTime: number,
  details: Record<string, unknown>,
  videoRealTime = 0
): number {
  if (details["lv"] !== "exp") return newsExpTime;
  let eff = newsExpTime;
  if (details["od"] === "time") {
    const cr = Number(details["cr"]) || 0;
    if (cr > 0 && (eff === 0 || cr < eff)) eff = cr;
  }
  if (videoRealTime > 0 && (eff === 0 || videoRealTime < eff)) eff = videoRealTime;
  return eff;
}

export interface TitleDistribution {
  /** 各军衔的高级时间上限（毫秒，升序；2026-10-13 起为常量 TITLE_THRESHOLDS；
   *  2026-10-19 总司令改雷界第一人特判，不占阈值档位，本数组=大元帅~上等兵 18 档） */
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
