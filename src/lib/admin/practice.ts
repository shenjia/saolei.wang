// 练习数据聚合（2026-10-27 张老师定：/admin/practice 详情页 + 数据分析页级别分布）
// 数据源 practice_daily（日汇总，10-22 起不逐盘落行）+ practice_hourly（小时桶，本日起）。
// ⚠️ 口径（张老师 16:10 定稿）：级别三列 10-27 15:11 才生效，当日差额混着大量
// 生效前未记盘（「自定义」是污染值）——**级别维度（初/中/高/自）一律自干净起点
// 2026-10-28（day 20754）起算，之前计 0**；总量 plays 任意日期都准。

import { prisma } from "@/lib/db";

const N = (v: unknown): number => Number(v ?? 0);

/** 练习级别统一配色（2026-10-27 张老师定）：初中高复用前台色（绿 #a6e22e /
 *  橙 #f79646 / 金 #fdc61d，同 admin_tag.lv_* 与前台 hover），自定义紫 #ae81ff，
 *  总盘亮灰 #b1b1a4（仅趋势序列用，不进饼图） */
export const PRACTICE_LEVEL_COLORS: Record<string, string> = {
  beg: "#a6e22e",
  int: "#f79646",
  exp: "#fdc61d",
  cus: "#ae81ff",
  total: "#b1b1a4",
};

/** 级别数据干净起点（day 20754 = 2026-10-28 全天，张老师 2026-10-27 定）：
 *  10-27 起记当日的差额里混着大量生效前的未记盘（「自定义」是污染值，不可用），
 *  所有级别维度（初/中/高/自）的聚合与展示一律自 10-28 起算，之前计 0；
 *  总量 plays 任意日期都准，不受影响。 */
export const LEVEL_CLEAN_SINCE_DAY = 20754;
export const LEVEL_CLEAN_SINCE = "2026-10-28";
/** 今日是否已有干净级别数据（仪表盘 KPI 占比行用：10-28 前显示对齐提示不显污染占比） */
export function practiceLevelsClean(): boolean {
  return Math.floor((Math.floor(Date.now() / 1000) + 28800) / 86400) >= LEVEL_CLEAN_SINCE_DAY;
}

export interface PracticeTrend {
  dates: string[];
  total: number[];
  beg: number[];
  int: number[];
  exp: number[];
  cus: number[];
}

/** 近 N 天练习趋势（总/初/中/高/自，日粒度） */
export async function getPracticeTrend(days = 30): Promise<PracticeTrend> {
  const now = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor((now + 28800) / 86400);
  const fromIdx = todayIdx - (days - 1);
  const rows = await prisma.$queryRawUnsafe<
    { day: number; plays: bigint; beg: bigint; intg: bigint; exp: bigint }[]
  >(
    `SELECT day, SUM(plays) plays, SUM(plays_beg) beg, SUM(plays_int) intg, SUM(plays_exp) exp
     FROM practice_daily WHERE day >= ? GROUP BY day`,
    fromIdx
  );
  const map = new Map(rows.map((r) => [N(r.day), r]));
  const dates: string[] = [];
  const total: number[] = [];
  const beg: number[] = [];
  const int: number[] = [];
  const exp: number[] = [];
  const cus: number[] = [];
  for (let i = 0; i < days; i++) {
    const idx = fromIdx + i;
    const r = map.get(idx);
    const p = N(r?.plays);
    // 级别维度只认干净起点之后（10-27 当天差额是污染值）；总量任意日期都准
    const clean = idx >= LEVEL_CLEAN_SINCE_DAY;
    const b = clean ? N(r?.beg) : 0;
    const it = clean ? N(r?.intg) : 0;
    const e = clean ? N(r?.exp) : 0;
    dates.push(new Date(idx * 86400000).toISOString().slice(0, 10));
    total.push(p);
    beg.push(b);
    int.push(it);
    exp.push(e);
    cus.push(clean ? Math.max(0, p - b - it - e) : 0); // 干净起点后差额=真自定义
  }
  return { dates, total, beg, int, exp, cus };
}

/** 模式使用聚合（2026-10-27 张老师定：柱状图「排名/NF/无猜/速旗/连击」使用比例）。
 *  模式五列与级别列同日上线，同用干净起点；分母=同期总盘数（模式可叠加，五项之和可 >100%） */
export async function getPracticeModes(days = 7): Promise<{
  items: { label: string; value: number }[];
  total: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor((now + 28800) / 86400);
  const fromIdx = Math.max(todayIdx - (days - 1), LEVEL_CLEAN_SINCE_DAY);
  const rows = await prisma.$queryRawUnsafe<{
    ranked: bigint; nf: bigint; ng: bigint; sq: bigint; combo: bigint; plays: bigint;
  }[]>(
    `SELECT SUM(mode_ranked) ranked, SUM(mode_nf) nf, SUM(mode_ng) ng, SUM(mode_sq) sq,
            SUM(mode_combo) combo, SUM(plays) plays
     FROM practice_daily WHERE day >= ?`,
    fromIdx
  );
  const r = rows[0];
  return {
    items: [
      { label: "排名", value: N(r?.ranked) },
      { label: "NF", value: N(r?.nf) },
      { label: "无猜", value: N(r?.ng) },
      { label: "速旗", value: N(r?.sq) },
      { label: "连击", value: N(r?.combo) },
    ],
    total: N(r?.plays),
  };
}

/** 24 小时分布（近 N 天 practice_hourly 聚合；自起记日起有数据） */export async function getPracticeHourly(days = 7): Promise<{ label: string; value: number }[]> {
  const now = Math.floor(Date.now() / 1000);
  const fromIdx = Math.floor((now + 28800) / 86400) - (days - 1);
  const rows = await prisma.$queryRawUnsafe<{ hour: number; plays: bigint }[]>(
    `SELECT hour, SUM(plays) plays FROM practice_hourly WHERE day >= ? GROUP BY hour ORDER BY hour`,
    fromIdx
  );
  const map = new Map(rows.map((r) => [N(r.hour), N(r.plays)]));
  return Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, value: map.get(h) ?? 0 }));
}

export interface PracticeDayRow {
  date: string;
  plays: number;
  wins: number;
  beg: number;
  int: number;
  exp: number;
  cus: number;
  players: number;
}

/** 近 N 天明细（列表用）：总盘/完成/初中高自/参与人数（user_id>0 去重 + 游客行标记） */
export async function getPracticeDays(days = 7): Promise<PracticeDayRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const todayIdx = Math.floor((now + 28800) / 86400);
  const fromIdx = todayIdx - (days - 1);
  const rows = await prisma.$queryRawUnsafe<
    {
      day: number;
      plays: bigint;
      wins: bigint;
      beg: bigint;
      intg: bigint;
      exp: bigint;
      users: bigint;
      guests: bigint;
    }[]
  >(
    `SELECT day, SUM(plays) plays, SUM(wins) wins, SUM(plays_beg) beg, SUM(plays_int) intg,
            SUM(plays_exp) exp, COUNT(DISTINCT CASE WHEN user_id > 0 THEN user_id END) users,
            SUM(CASE WHEN user_id = 0 THEN plays ELSE 0 END) guests
     FROM practice_daily WHERE day >= ? GROUP BY day ORDER BY day DESC`,
    fromIdx
  );
  return rows.map((r) => {
    const p = N(r.plays);
    const day = N(r.day);
    // 级别维度只认干净起点之后；10-27 及之前差额是污染值，级别四列一律 0
    const clean = day >= LEVEL_CLEAN_SINCE_DAY;
    const b = clean ? N(r.beg) : 0;
    const it = clean ? N(r.intg) : 0;
    const e = clean ? N(r.exp) : 0;
    return {
      date: new Date(day * 86400000).toISOString().slice(0, 10),
      plays: p,
      wins: N(r.wins),
      beg: b,
      int: it,
      exp: e,
      cus: clean ? Math.max(0, p - b - it - e) : 0,
      players: N(r.users) + (N(r.guests) > 0 ? 1 : 0), // 游客聚合行算 1「位」
    };
  });
}

/** 全量级别聚合（数据分析页 Donut）：自干净起点（LEVEL_CLEAN_SINCE_DAY=20754
 *  =2026-10-28）起——张老师定：起记日 10-27 当天的差额混着生效前大量未记盘
 *  （「自定义」是污染值），级别维度统计一律自上线后首个整天开始 */
export async function getPracticeLevelCounts(): Promise<{
  items: { label: string; value: number; color?: string }[];
  total: number;
}> {
  const rows = await prisma.$queryRawUnsafe<{ beg: bigint; intg: bigint; exp: bigint; plays: bigint }[]>(
    `SELECT SUM(plays_beg) beg, SUM(plays_int) intg, SUM(plays_exp) exp, SUM(plays) plays
     FROM practice_daily WHERE day >= ${LEVEL_CLEAN_SINCE_DAY}`
  );
  const r = rows[0];
  const beg = N(r?.beg);
  const int = N(r?.intg);
  const exp = N(r?.exp);
  const plays = N(r?.plays);
  const cus = Math.max(0, plays - beg - int - exp); // 干净起点后差额=真自定义
  return {
    items: [
      { label: "初级", value: beg, color: PRACTICE_LEVEL_COLORS.beg },
      { label: "中级", value: int, color: PRACTICE_LEVEL_COLORS.int },
      { label: "高级", value: exp, color: PRACTICE_LEVEL_COLORS.exp },
      { label: "自定义", value: cus, color: PRACTICE_LEVEL_COLORS.cus },
    ],
    total: plays,
  };
}

