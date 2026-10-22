// 首页「今日练习」板块数据（2026-10-22 张老师要求）
// 口径与后台仪表盘「今日练习」KPI 完全一致（src/lib/admin/traffic.ts practice）：
// · 今日总局数 = practice_log 当日全量行数（+08:00 切天，胜负/踩雷局都算，游客局也计）
// · 参与雷友 = 当日去重 user_id（未登录游客不入「位」）
// · 我今日局数 = 登录者 user_id 当日行数（未登录 0，文案降级）
// 拆分文件不 import admin/traffic.ts——那个 aggregate() 会拉 30 天 page_view 全量行
// 进内存聚合，给首页用太重；这里只查轻量聚合并挂 unstable_cache（热点统计铁律）。
// 今日实时数不缓存（走 [createTime] 索引毫秒级），30 天走势缓存 300s 且末桶
// 用实时数覆盖——练完一局刷新立即可见，与后台 KPI 数值始终一致。

import { prisma } from "@/lib/db";
import { unstable_cache } from "next/cache";
import { dayStart } from "@/lib/admin/stats";

export interface PracticeToday {
  /** 今日总局数（含踩雷局、游客局；后台 KPI 同口径） */
  today: number;
  /** 今日去重参与玩家数（仅登录态） */
  todayUsers: number;
  /** 我今日练的局数（未登录 0） */
  mine: number;
  /** 近 30 天走势（+08:00 切天，末位=今日已被实时数覆盖），画迷你折线 */
  trend: number[];
}

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** 近 30 天分日局数（不含今天；今天由实时查询补，保证练完即见） */
const getTrendCached = unstable_cache(
  async (): Promise<number[]> => {
    const rows = await prisma.$queryRaw<Array<{ d: bigint; c: bigint }>>`
      SELECT FLOOR((create_time + 28800) / 86400) AS d, COUNT(*) AS c
      FROM practice_log
      WHERE create_time >= ${BigInt(dayStart(29))}
      GROUP BY d
    `;
    const map = new Map<number, number>(rows.map((r) => [N(r.d), N(r.c)]));
    const fromIdx = Math.floor((dayStart(29) + 28800) / 86400);
    const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
    const out: number[] = [];
    for (let i = 0; i < 30; i++) {
      const idx = fromIdx + i;
      if (idx >= todayIdx) break; // 今天及以后的桶由实时数覆盖
      out.push(map.get(idx) ?? 0);
    }
    return out;
  },
  ["home-practice-trend", "v1"],
  { revalidate: 300 }
);

export async function getPracticeToday(uid?: number | null): Promise<PracticeToday> {
  const today0 = dayStart(0);
  // 实时三数并行：今日总量 / 今日去重玩家 / 我今日局数
  const [today, usersGroup, mine] = await Promise.all([
    prisma.practiceLog.count({ where: { createTime: { gte: today0 } } }),
    prisma.practiceLog.groupBy({
      by: ["userId"],
      where: { createTime: { gte: today0 }, userId: { not: null } },
      _count: { _all: true },
    }),
    uid
      ? prisma.practiceLog.count({
          where: { createTime: { gte: today0 }, userId: BigInt(uid) },
        })
      : Promise.resolve(0),
  ]);
  const trend = [...(await getTrendCached()), today];
  return { today, todayUsers: usersGroup.length, mine, trend };
}
