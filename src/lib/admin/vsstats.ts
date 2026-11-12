// VS 对决统计（2026-11-11 张老师定）：仪表盘「今日对决」KPI（原「今日胜负」）+ /admin/vs 对决统计页。
// 数据源 vs_duel（/vs/:id 页有效访问落行，比分/结果为渲染时快照；历史行由
// page_view 回填、比分/结果 NULL）。口径：
// · 一次对决 = vs_duel 一行；发起人数 = 去重 user_id
// · 同比 = 上周同一日同时段（逐行精确窗口，与 PV/UV 同构）
// · 趋势聚合挂 unstable_cache 300s（铁律：热点统计必须挂缓存；改逻辑升版本号）
// · Top10（发起 / 被对决）范围由 /admin/vs ?range=1|7|30 指定（2026-11-12 张老师：
//   今天/7天/30天，默认今天）/ 最近记录为轻量查询实时取（表量级 = 访问数，索引齐；
//   最近记录分页取，COUNT 全表走主键索引）
// · 玩家名展示口径：中文名优先，退英文名，再退 #id（三处 SQL 各自内联同名表达式）

import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { dayStart } from "@/lib/admin/stats";

const N = (v: unknown): number => Number(v ?? 0);

// ---------- KPI 概览（趋势挂 300s 缓存） ----------

export interface VsDuelsOverview {
  now: number;
  /** 今日对决次数 / 发起人数（去重 user_id） */
  today: number; todayLaunchers: number;
  /** 上周同一日同时段（同比基数） */
  lastWeek: number;
  /** 今日预估全天（与同比同构外推）；null = 上周同日无数据 */
  todayEst: number | null;
  /** 近 30 天合计 */
  d30: number;
  /** 近 30 天分日趋势（+08:00 切天，末位=今日至今） */
  trend: number[];
  /** 趋势 x 轴日期（与 trend 对齐；RSC 禁 Date.now()，日期在聚合层生成） */
  dates: string[];
}

async function aggregate(): Promise<VsDuelsOverview> {
  const now = Math.floor(Date.now() / 1000);
  const today0 = dayStart(0);
  const todayIdx = Math.floor((today0 + 28800) / 86400);
  const fromIdx = todayIdx - 29;
  const from = BigInt(fromIdx * 86400 - 28800);
  const lastWeek0 = today0 - 7 * 86400;
  const lastWeekEnd = now - 7 * 86400;

  const rows = await prisma.vsDuel.findMany({
    where: { createTime: { gte: from } },
    select: { createTime: true, userId: true },
  });

  const dayMap = new Map<number, number>();
  const launchers = new Set<string>(); // 今日发起去重
  let today = 0;
  let lastWeek = 0;
  for (const r of rows) {
    const t = N(r.createTime);
    const idx = Math.floor((t + 28800) / 86400);
    dayMap.set(idx, (dayMap.get(idx) ?? 0) + 1);
    if (t >= today0) {
      today += 1;
      launchers.add(String(N(r.userId)));
    }
    if (t >= lastWeek0 && t < lastWeekEnd) lastWeek += 1;
  }
  const trend: number[] = [];
  const dates: string[] = [];
  for (let i = 0; i < 30; i++) {
    trend.push(dayMap.get(fromIdx + i) ?? 0);
    dates.push(new Date((fromIdx + i) * 86400000).toISOString().slice(0, 10));
  }

  // 今日预估全天：今日至今 × 上周同日全天 / 上周同日同时段（与 PV 同构）
  const lastWeekFull = dayMap.get(todayIdx - 7) ?? 0;
  const todayEst =
    lastWeek > 0 && lastWeekFull > 0
      ? Math.max(today, Math.round((today * lastWeekFull) / lastWeek))
      : null;

  return {
    now,
    today,
    todayLaunchers: launchers.size,
    lastWeek,
    todayEst,
    d30: trend.reduce((a, b) => a + b, 0),
    trend,
    dates,
  };
}

/** 缓存版（铁律：热点统计挂 unstable_cache） */
export const getVsDuelsOverview = unstable_cache(aggregate, ["admin-vs-duels", "v1"], {
  revalidate: 300,
});

// ---------- Top10（发起 / 被对决，范围 days=1|7|30，页面默认今天） ----------

export interface VsTopUser {
  uid: number;
  name: string;
  count: number;
}

/** 展示名表达式（中文名优先 → 英文名 → #id；alias 固定 u，三处内联一致） */
const NAME_EXPR = `COALESCE(NULLIF(u.chinese_name, ''), NULLIF(u.english_name, ''), CONCAT('#', u.id))`;

export async function getVsTopLaunchers(days = 7): Promise<VsTopUser[]> {
  const from = BigInt(dayStart(days - 1));
  const rows = await prisma
    .$queryRaw<{ uid: bigint; name: string; c: bigint }[]>(
      // 值拼 SQL 禁——此处无外部输入，整条静态模板；表达式无法参数化故内联（见 NAME_EXPR 注释）
      Prisma.sql`
        SELECT d.user_id AS uid, ${Prisma.raw(NAME_EXPR)} AS name, COUNT(*) AS c
        FROM vs_duel d JOIN \`user\` u ON u.id = d.user_id
        WHERE d.create_time >= ${from}
        GROUP BY d.user_id, u.chinese_name, u.english_name, u.id
        ORDER BY c DESC, uid ASC LIMIT 10
      `
    )
    .catch(() => []);
  return rows.map((r) => ({ uid: N(r.uid), name: r.name, count: N(r.c) }));
}

export async function getVsTopTargets(days = 7): Promise<VsTopUser[]> {
  const from = BigInt(dayStart(days - 1));
  const rows = await prisma
    .$queryRaw<{ uid: bigint; name: string; c: bigint }[]>(
      Prisma.sql`
        SELECT d.target_id AS uid, ${Prisma.raw(NAME_EXPR)} AS name, COUNT(*) AS c
        FROM vs_duel d JOIN \`user\` u ON u.id = d.target_id
        WHERE d.create_time >= ${from}
        GROUP BY d.target_id, u.chinese_name, u.english_name, u.id
        ORDER BY c DESC, uid ASC LIMIT 10
      `
    )
    .catch(() => []);
  return rows.map((r) => ({ uid: N(r.uid), name: r.name, count: N(r.c) }));
}

// ---------- 最近对决记录 ----------

export interface VsDuelRow {
  id: number;
  /** 发起时刻 Unix 秒 */
  time: number;
  u1: number; n1: string; // 发起者
  u2: number; n2: string; // 被挑战者
  /** 性别（user.sex，1=男）——记录表名字后缀图标（2026-11-11 张老师） */
  sex1: number; sex2: number;
  /** 高级最好成绩快照（user_scores.exp_time，毫秒；null=无成绩行）——军衔评定输入 */
  exp1: number | null; exp2: number | null;
  /** 比分（null=历史回填行未算） */
  s1: number | null; s2: number | null;
  /** 1=发起者胜 2=对方胜 0=平；null=未算 */
  result: number | null;
}

export async function getVsRecentDuels(
  page = 1,
  pageSize = 50
): Promise<{ rows: VsDuelRow[]; total: number; pageSize: number }> {
  const offset = (Math.max(1, page) - 1) * pageSize;
  const [rows, cnt] = await Promise.all([
    prisma
      .$queryRaw<{
        id: bigint; create_time: bigint; u1: bigint; u2: bigint;
        s1: number | null; s2: number | null; result: number | null;
        n1: string; n2: string; sex1: number; sex2: number;
        exp1: number | null; exp2: number | null;
      }[]>(
        Prisma.sql`
          SELECT d.id, d.create_time, d.user_id AS u1, d.target_id AS u2, d.s1, d.s2, d.result,
                 ${Prisma.raw("COALESCE(NULLIF(ua.chinese_name, ''), NULLIF(ua.english_name, ''), CONCAT('#', ua.id))")} AS n1,
                 ${Prisma.raw("COALESCE(NULLIF(ub.chinese_name, ''), NULLIF(ub.english_name, ''), CONCAT('#', ub.id))")} AS n2,
                 ua.sex AS sex1, ub.sex AS sex2,
                 sa.exp_time AS exp1, sb.exp_time AS exp2
          FROM vs_duel d
          JOIN \`user\` ua ON ua.id = d.user_id
          JOIN \`user\` ub ON ub.id = d.target_id
          LEFT JOIN \`user_scores\` sa ON sa.id = d.user_id
          LEFT JOIN \`user_scores\` sb ON sb.id = d.target_id
          ORDER BY d.create_time DESC LIMIT ${pageSize} OFFSET ${offset}
        `
      )
      .catch(() => []),
    // 总数（vs_duel 全表行数，COUNT 走主键索引，轻量）
    prisma
      .$queryRaw<{ c: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS c FROM vs_duel`)
      .then((r) => N(r[0]?.c))
      .catch(() => 0),
  ]);
  return {
    total: cnt,
    pageSize,
    rows: rows.map((r) => ({
      id: N(r.id),
      time: N(r.create_time),
      u1: N(r.u1), n1: r.n1,
      u2: N(r.u2), n2: r.n2,
      sex1: N(r.sex1), sex2: N(r.sex2),
      exp1: r.exp1 === null ? null : Number(r.exp1),
      exp2: r.exp2 === null ? null : Number(r.exp2),
      s1: r.s1 === null ? null : Number(r.s1),
      s2: r.s2 === null ? null : Number(r.s2),
      result: r.result === null ? null : N(r.result),
    })),
  };
}
