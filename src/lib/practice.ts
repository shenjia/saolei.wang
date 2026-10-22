// 首页「今日练习」板块数据（2026-10-22 张老师要求；五轮升级为完成/尝试双口径）
// 口径与后台仪表盘「今日练习」KPI 完全一致（src/lib/admin/traffic.ts practice）：
// · 尝试盘数 = practice_log 当日全量行数（+08:00 切天，胜负都算，游客局也计）
// · 完成盘数 = 其中 won=1 行数（胜局）
// · 参与雷友 = 当日去重 user_id（未登录游客不入「位」）
// · 我完成/尝试 = 登录者 user_id 当日 won=1 / 全量行数（未登录 0，前端走 localStorage）
// 拆分文件不 import admin/traffic.ts——那个 aggregate() 会拉 30 天 page_view 全量行
// 进内存聚合，给首页用太重；这里只查轻量聚合并挂 unstable_cache（热点统计铁律）。
// 今日实时数不缓存（走 [createTime] 索引毫秒级），30 天走势缓存 300s 且末桶
// 用实时数覆盖——练完一局刷新立即可见，与后台 KPI 数值始终一致。

import { prisma } from "@/lib/db";
import { unstable_cache } from "next/cache";
import { dayStart } from "@/lib/admin/stats";

export interface PracticeToday {
  /** 今日全网尝试盘数（含踩雷局、游客局；后台 KPI 同口径） */
  today: number;
  /** 今日全网完成盘数（won=1） */
  todayWon: number;
  /** 今日去重参与玩家数（仅登录态） */
  todayUsers: number;
  /** 我今日完成盘数（未登录 0） */
  mineWon: number;
  /** 我今日尝试盘数（未登录 0） */
  mine: number;
  /** 近 30 天全网尝试盘数走势（+08:00 切天，末位=今日已被实时数覆盖） */
  trend: number[];
  /** 近 30 天全网完成盘数走势（与 trend 同轴对齐） */
  trendWon: number[];
  /** 近 30 天我的尝试盘数走势（登录才有；末位=今日实时数。绿线数据源） */
  mineTrend: number[];
}

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** 近 30 天分日尝试/完成双序列（不含今天；今天由实时查询补，保证练完即见） */
const getTrendCached = unstable_cache(
  async (): Promise<{ p: number[]; w: number[] }> => {
    const rows = await prisma.$queryRaw<Array<{ d: bigint; c: bigint; cw: bigint }>>`
      SELECT FLOOR((create_time + 28800) / 86400) AS d,
             COUNT(*) AS c,
             SUM(won) AS cw
      FROM practice_log
      WHERE create_time >= ${BigInt(dayStart(29))}
      GROUP BY d
    `;
    const map = new Map<number, { p: number; w: number }>(
      rows.map((r) => [N(r.d), { p: N(r.c), w: N(r.cw) }])
    );
    const fromIdx = Math.floor((dayStart(29) + 28800) / 86400);
    const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
    const p: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < 30; i++) {
      const idx = fromIdx + i;
      if (idx >= todayIdx) break; // 今天及以后的桶由实时数覆盖
      const b = map.get(idx);
      p.push(b?.p ?? 0);
      w.push(b?.w ?? 0);
    }
    return { p, w };
  },
  ["home-practice-trend", "v2"],
  { revalidate: 300 }
);

/** 近 30 天我的分日尝试盘数（不含今天；uid 参与缓存 key，每人一份不串）。
 *  五轮首版绿线恒平的根因：登录态没查个人分日序列，用 0 数组兜底（2026-10-22 六轮修复） */
const getMineTrendCached = (uid: number) =>
  unstable_cache(
    async (): Promise<number[]> => {
      const rows = await prisma.$queryRaw<Array<{ d: bigint; c: bigint }>>`
        SELECT FLOOR((create_time + 28800) / 86400) AS d, COUNT(*) AS c
        FROM practice_log
        WHERE user_id = ${BigInt(uid)} AND create_time >= ${BigInt(dayStart(29))}
        GROUP BY d
      `;
      const map = new Map<number, number>(rows.map((r) => [N(r.d), N(r.c)]));
      const fromIdx = Math.floor((dayStart(29) + 28800) / 86400);
      const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const idx = fromIdx + i;
        if (idx >= todayIdx) break;
        out.push(map.get(idx) ?? 0);
      }
      return out;
    },
    ["home-practice-mine-trend", `u${uid}`, "v1"],
    { revalidate: 300 }
  )();

export async function getPracticeToday(uid?: number | null): Promise<PracticeToday> {
  const today0 = dayStart(0);
  // 实时五数并行：全网尝试/完成/去重玩家 + 我的尝试/完成
  const [today, todayWon, usersGroup, mine, mineWon] = await Promise.all([
    prisma.practiceLog.count({ where: { createTime: { gte: today0 } } }),
    prisma.practiceLog.count({ where: { createTime: { gte: today0 }, won: true } }),
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
    uid
      ? prisma.practiceLog.count({
          where: { createTime: { gte: today0 }, userId: BigInt(uid), won: true },
        })
      : Promise.resolve(0),
  ]);
  const trend30 = await getTrendCached();
  const mineTrendBase = uid ? await getMineTrendCached(uid) : [];
  return {
    today,
    todayWon,
    todayUsers: usersGroup.length,
    mine,
    mineWon,
    trend: [...trend30.p, today],
    trendWon: [...trend30.w, todayWon],
    mineTrend: uid ? [...mineTrendBase, mine] : [],
  };
}
