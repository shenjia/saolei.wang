// 练习数据聚合（2026-10-27 张老师定：/admin/practice 详情页 + 数据分析页级别分布）
// 数据源 practice_daily（日汇总，10-22 起不逐盘落行）+ practice_hourly（小时桶，本日起）。
// ⚠️ 口径：级别三列 plays_beg/int/exp 自 2026-10-27 下午起记——历史行三列为 0，
// 差额（plays − 三列和）含「上线前的历史盘」与真自定义盘，展示端必须注明起记日
// 防误读（95% 假自定义事件的教训）。

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

/** 级别三列起记日（2026-10-27 生产 15:10 左右生效；当日三列和>0 的最小 day） */
const LEVEL_COLS_SINCE = "2026-10-27";

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
    const b = N(r?.beg);
    const it = N(r?.intg);
    const e = N(r?.exp);
    dates.push(new Date(idx * 86400000).toISOString().slice(0, 10));
    total.push(p);
    beg.push(b);
    int.push(it);
    exp.push(e);
    cus.push(Math.max(0, p - b - it - e)); // 差额=自定义 + 起记日前历史盘（见文件头）
  }
  return { dates, total, beg, int, exp, cus };
}

/** 24 小时分布（近 N 天 practice_hourly 聚合；自起记日起有数据） */
export async function getPracticeHourly(days = 7): Promise<{ label: string; value: number }[]> {
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
    const b = N(r.beg);
    const it = N(r.intg);
    const e = N(r.exp);
    return {
      date: new Date(N(r.day) * 86400000).toISOString().slice(0, 10),
      plays: p,
      wins: N(r.wins),
      beg: b,
      int: it,
      exp: e,
      cus: Math.max(0, p - b - it - e),
      players: N(r.users) + (N(r.guests) > 0 ? 1 : 0), // 游客聚合行算 1「位」
    };
  });
}

/** 全量级别聚合（数据分析页 Donut）：自三列起记日（20753=2026-10-27）起——
 *  起记日下午生效，当日为部分样本但占比真实（分布不受样本时长影响） */
export async function getPracticeLevelCounts(): Promise<{
  items: { label: string; value: number; color?: string }[];
  total: number;
}> {
  const rows = await prisma.$queryRawUnsafe<{ beg: bigint; intg: bigint; exp: bigint; plays: bigint }[]>(
    `SELECT SUM(plays_beg) beg, SUM(plays_int) intg, SUM(plays_exp) exp, SUM(plays) plays
     FROM practice_daily WHERE day >= 20753`
  );
  const r = rows[0];
  const beg = N(r?.beg);
  const int = N(r?.intg);
  const exp = N(r?.exp);
  const plays = N(r?.plays);
  // 起记日（部分样本）计入分母——占比对样本时长不敏感；差额=自定义（含起记前盘）
  const cus = Math.max(0, plays - beg - int - exp);
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

export { LEVEL_COLS_SINCE };
