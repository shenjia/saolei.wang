// 实力雷达图数据：8 维 = 排序(time/3bvs) × 级别(sum/exp/int/beg)。
// 2026-11-08 起改 23 个显式名次档（radar-standard.mjs），不再用九主档档内插值推 +/-。
//
// ⚠️ 两个「百分比」语义不同（2026-10-15 张老师指出气泡逻辑漏洞后明确区分）：
//   percent  = 23 个显式子档各自的固定绘图半径（非真实排位），只用于雷达形状区分；
//   beatPct  = 真实排位百分位（全服该维度成绩严格更差者 / 上榜人口，与 getUserRanks
//              全国名次同口径：JOIN user status=0），气泡「超过 xx% 的玩家」只认这个。

import { prisma } from "@/lib/db";
import { ORDER_DIRECTION, type Level, type Order } from "@/lib/config";
import { score3bvs, scoreTime } from "@/lib/format";
import { SCORE_FIELD, rankedOnly } from "@/lib/queries";
import { radarGrade, radarPercent } from "@/lib/radar-standard.mjs";
import { unstable_cache } from "next/cache";

export interface RadarPoint {
  /** 维度名，如「总计时间」 */
  name: string;
  /** 格式化后的成绩，如 46.65 / 5.832 */
  score: string;
  /** 0-100 的子档固定绘图半径（非真实排位） */
  percent: number;
  /** 真实排位百分位：超过全服该维度多少百分比的玩家（0=无成绩/无基准；100=全网第一） */
  beatPct: number;
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

// 每日 00:30 重算后无需重启：最新快照最多 5 分钟自动接替旧快照（双活各槽独立缓存亦然）。
async function getDistributionImpl(): Promise<Record<string, number[]>> {
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
  return result;
}

export const getRadarDistribution = unstable_cache(getDistributionImpl, ["radar-distribution-v2"], {
  revalidate: 300,
});

/**
 * 真实排位百分位（2026-10-15 修气泡逻辑漏洞新增）：
 * total = 该维度上榜人口（封禁不在榜，与排行榜同口径），better/worse = 严格更优/更差人数（同分不计）。
 * better=0 → 100（「全网第一」，含并列第一）；否则 floor(worse/total*100)，天然 ≤ 99
 * （如 24516 总计时间：7343/7372 = 99.6% → 99，而旧档位插值只给 79）。
 * 每维度 3 条 count（user_scores 3.5 万行带索引，毫秒级）×8；
 * 名次只在有人出成绩时变化，按用户 id 缓存 10 分钟（与 getUserRanks 同节奏）。
 */
async function getBeatPctImpl(
  scores: Record<string, { score: number | null }>
): Promise<Record<string, number>> {
  const ranked = await rankedOnly();
  const out: Record<string, number> = {};
  for (const order of RADAR_ORDERS) {
    for (const level of RADAR_LEVELS) {
      const key = `${level}_${order}`;
      const score = scores[key]?.score ?? 0;
      const field = SCORE_FIELD(level, order);
      if (!score) {
        out[key] = 0;
        continue;
      }
      // time 越小越好：更优 = 更小；3bvs 越大越好：更优 = 更大（两者都排除 0=无成绩）
      const betterWhere =
        order === "time"
          ? { [field]: { lt: score, gt: 0 } }
          : { [field]: { gt: score } };
      const worseWhere =
        order === "time"
          ? { [field]: { gt: score } }
          : { [field]: { lt: score, gt: 0 } };
      const [better, worse, total] = await Promise.all([
        prisma.userScores.count({ where: { ...betterWhere, ...ranked } }),
        prisma.userScores.count({ where: { ...worseWhere, ...ranked } }),
        prisma.userScores.count({ where: { ...ranked, [field]: { gt: 0 } } }),
      ]);
      out[key] = !total ? 0 : better === 0 ? 100 : Math.floor((worse / total) * 100);
    }
  }
  return out;
}
// 8 维 beatPct 一次算齐再并入 RadarPoint；scores 入参含全部 8 个原始成绩，
// unstable_cache 以参数为缓存键 —— 同一份成绩恒同结果，新成绩自动换键重算。
// 用户主页与侧栏卡片共用此缓存，热页面零额外负担。
const getBeatPct = unstable_cache(getBeatPctImpl, ["radar-beat-pct-v1"], { revalidate: 600 });

export async function getRadarData(
  scores: Record<string, { score: number | null }>
): Promise<RadarPoint[]> {
  const [distribution, beatPct] = await Promise.all([
    getRadarDistribution(),
    getBeatPct(scores),
  ]);
  const points: RadarPoint[] = [];

  for (const order of RADAR_ORDERS) {
    for (const level of RADAR_LEVELS) {
      const raw = scores[`${level}_${order}`]?.score ?? 0;
      const dist = distribution[`${level}_${order}`] ?? [];
      const direction = ORDER_DIRECTION[order];
      points.push({
        name: LEVEL_NAMES[level] + ORDER_NAMES[order],
        score:
          raw > 0 || (level === "beg" && order === "3bvs" && (scores.beg_time?.score ?? 0) > 0)
            ? order === "time"
              ? scoreTime(raw)
              : score3bvs(raw)
            : "无",
        percent: radarPercent(raw, dist, direction),
        beatPct: beatPct[`${level}_${order}`] ?? 0,
        grade: radarGrade(raw, dist, direction),
      });
    }
  }
  return points;
}
