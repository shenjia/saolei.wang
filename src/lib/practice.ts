// 首页「今日练习」板块数据（2026-10-22 张老师要求；七轮改走 practice_daily 日汇总表）
// 口径不变（与后台仪表盘「今日练习」KPI 一致）：
// · 尝试盘数 = practice_daily 当日 plays（含踩雷、游客局，游客并入 user_id=0 聚合行）
// · 完成盘数 = 当日 wins（won=1）
// · 参与雷友 = 当日去重 user_id（user_id>0 才算「位」）
// · 我的完成/尝试 = 登录者当日行（未登录 0，前端走 localStorage）
// 表结构：每人每日一行（day 为 +08:00 切天序号），埋点路由 UPSERT 自增——
// 表体量 = 活跃练习者数 × 天数（一年仅数万行），无逐盘流水膨胀问题（张老师 2026-10-22 定）。
// 今日实时数不缓存（唯一键 (day,user_id) 点查毫秒级），30 天走势挂 unstable_cache 300s
// （铁律：热点统计必须挂缓存）且今日桶用实时数覆盖——练完一局刷新立即可见。

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

/** 近 30 天全网分日尝试/完成双序列（不含今天；今天由实时查询补，保证练完即见） */
const getTrendCached = unstable_cache(
  async (): Promise<{ p: number[]; w: number[] }> => {
    const fromIdx = Math.floor((dayStart(29) + 28800) / 86400);
    const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
    const rows = await prisma.$queryRaw<Array<{ d: bigint; p: bigint; w: bigint }>>`
      SELECT day AS d, SUM(plays) AS p, SUM(wins) AS w
      FROM practice_daily
      WHERE day >= ${fromIdx} AND day < ${todayIdx}
      GROUP BY day
    `;
    const map = new Map<number, { p: number; w: number }>(
      rows.map((r) => [N(r.d), { p: N(r.p), w: N(r.w) }])
    );
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
  ["home-practice-trend", "v3"],
  { revalidate: 300 }
);

/** 近 30 天我的分日尝试盘数（不含今天；uid 参与缓存 key，每人一份不串） */
const getMineTrendCached = (uid: number) =>
  unstable_cache(
    async (): Promise<number[]> => {
      const fromIdx = Math.floor((dayStart(29) + 28800) / 86400);
      const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
      const rows = await prisma.$queryRaw<Array<{ d: bigint; c: bigint }>>`
        SELECT day AS d, plays AS c
        FROM practice_daily
        WHERE user_id = ${BigInt(uid)} AND day >= ${fromIdx} AND day < ${todayIdx}
      `;
      const map = new Map<number, number>(rows.map((r) => [N(r.d), N(r.c)]));
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const idx = fromIdx + i;
        if (idx >= todayIdx) break;
        out.push(map.get(idx) ?? 0);
      }
      return out;
    },
    ["home-practice-mine-trend", `u${uid}`, "v2"],
    { revalidate: 300 }
  )();

/** 今日行（day, user_id）点查；userId=null 查游客聚合行（user_id=0） */
async function todayRow(userId: bigint | null): Promise<{ plays: number; wins: number } | null> {
  const rows = await prisma.$queryRaw<Array<{ plays: bigint; wins: bigint }>>`
    SELECT plays, wins FROM practice_daily
    WHERE day = ${Math.floor((dayStart(0) + 28800) / 86400)} AND user_id = ${userId ?? BigInt(0)}
  `;
  return rows[0] ? { plays: N(rows[0].plays), wins: N(rows[0].wins) } : null;
}

export async function getPracticeToday(uid?: number | null): Promise<PracticeToday> {
  const todayIdx = Math.floor((dayStart(0) + 28800) / 86400);
  // 实时数：全网今日（登录玩家汇总 + 游客 0 行单取）+ 参与玩家数 + 我的今日行
  const [netRow, guestRow, usersAgg, mineRow, trend30, mineTrendBase] = await Promise.all([
    prisma.$queryRaw<Array<{ p: bigint; w: bigint }>>`
      SELECT COALESCE(SUM(plays),0) AS p, COALESCE(SUM(wins),0) AS w
      FROM practice_daily WHERE day = ${todayIdx} AND user_id > 0
    `,
    todayRow(null),
    prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(*) AS c FROM practice_daily WHERE day = ${todayIdx} AND user_id > 0
    `,
    uid ? todayRow(BigInt(uid)) : Promise.resolve(null),
    getTrendCached(),
    uid ? getMineTrendCached(uid) : Promise.resolve([]),
  ]);
  const today = N(netRow[0]?.p) + (guestRow?.plays ?? 0);
  const todayWon = N(netRow[0]?.w) + (guestRow?.wins ?? 0);
  const todayUsers = N(usersAgg[0]?.c);
  const mine = uid && mineRow ? mineRow.plays : 0;
  const mineWon = uid && mineRow ? mineRow.wins : 0;
  return {
    today,
    todayWon,
    todayUsers,
    mine,
    mineWon,
    trend: [...trend30.p, today],
    trendWon: [...trend30.w, todayWon],
    mineTrend: uid ? [...mineTrendBase, mine] : [],
  };
}
