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

/** 级别三列起记日（day 20753 = 2026-10-27，生产 15:11 生效）。三列自此就是真值；
 *  唯一不可用的是 10-27 当天的「自定义」差额（混着生效前的未记盘，无法分离）。
 *  口径（张老师 16:50 定）：初中高自起记日起即统计真值；仅 10-27 当天 cus 计 0；
 *  占比分母 = 已记级别的盘数（beg+int+exp+cus），不掺未记盘。10-28 起全维度干净。 */
export const LEVEL_CLEAN_SINCE_DAY = 20753;
export const LEVEL_CLEAN_SINCE = "2026-10-27";
/** 「自定义」差额可信起点（首个整天） */
export const CUS_TRUST_SINCE_DAY = 20754;
/** 今日「自定义」差额是否可信（10-27 当天不可信，cus 计 0） */
export function practiceCusClean(): boolean {
  return Math.floor((Math.floor(Date.now() / 1000) + 28800) / 86400) >= CUS_TRUST_SINCE_DAY;
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
    // 初中高三列自起记日（10-27 15:11）即真值；仅 10-27 当天 cus 差额不可信计 0
    const since = idx >= LEVEL_CLEAN_SINCE_DAY;
    const b = since ? N(r?.beg) : 0;
    const it = since ? N(r?.intg) : 0;
    const e = since ? N(r?.exp) : 0;
    const cusTrust = idx >= CUS_TRUST_SINCE_DAY;
    dates.push(new Date(idx * 86400000).toISOString().slice(0, 10));
    total.push(p);
    beg.push(b);
    int.push(it);
    exp.push(e);
    cus.push(cusTrust ? Math.max(0, p - b - it - e) : 0);
  }
  return { dates, total, beg, int, exp, cus };
}

/** 模式使用聚合（2026-10-27 张老师定：柱状图「排名/NF/无猜/速旗/连击」使用比例）。
 *  模式五列自 16:33 上线起即真值（即刻可看）；分母=同期总盘数（含未带模式字段的
 *  老客户端局——16:33 前的局占比因此被稀释，明天起分母全干净；模式可叠加可 >100%） */
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
    // 初中高自起记日即真值；仅 10-27 当天 cus 差额不可信计 0
    const since = day >= LEVEL_CLEAN_SINCE_DAY;
    const b = since ? N(r.beg) : 0;
    const it = since ? N(r.intg) : 0;
    const e = since ? N(r.exp) : 0;
    return {
      date: new Date(day * 86400000).toISOString().slice(0, 10),
      plays: p,
      wins: N(r.wins),
      beg: b,
      int: it,
      exp: e,
      cus: day >= CUS_TRUST_SINCE_DAY ? Math.max(0, p - b - it - e) : 0,
      players: N(r.users) + (N(r.guests) > 0 ? 1 : 0), // 游客聚合行算 1「位」
    };
  });
}

/** 全量级别聚合（数据分析页 Donut + 练习页饼图数据基础）：
 *  初中高自起记日（20753）起累计真值；cus 单独口径——起记日当天差额不可信，
 *  只累计 CUS_TRUST_SINCE_DAY（10-28）之后。分母 = 四段之和（已记级别的盘数），
 *  不掺生效前未记盘，占比即刻真实。 */
export async function getPracticeLevelCounts(): Promise<{
  items: { label: string; value: number; color?: string }[];
  total: number;
}> {
  const rows = await prisma.$queryRawUnsafe<
    { beg: bigint; intg: bigint; exp: bigint; plays: bigint; b2: bigint; i2: bigint; e2: bigint }[]
  >(
    `SELECT SUM(plays_beg) beg, SUM(plays_int) intg, SUM(plays_exp) exp,
            SUM(CASE WHEN day >= ${CUS_TRUST_SINCE_DAY} THEN plays ELSE 0 END) plays,
            SUM(CASE WHEN day >= ${CUS_TRUST_SINCE_DAY} THEN plays_beg ELSE 0 END) b2,
            SUM(CASE WHEN day >= ${CUS_TRUST_SINCE_DAY} THEN plays_int ELSE 0 END) i2,
            SUM(CASE WHEN day >= ${CUS_TRUST_SINCE_DAY} THEN plays_exp ELSE 0 END) e2
     FROM practice_daily WHERE day >= ${LEVEL_CLEAN_SINCE_DAY}`
  );
  const r = rows[0];
  const beg = N(r?.beg);
  const int = N(r?.intg);
  const exp = N(r?.exp);
  // 差额只在 cus 可信时段内计算（10-28 起）——该时段内 plays − 三列 = 真自定义，
  // 与 10-27 当天的污染差额完全无关
  const cus = Math.max(0, N(r?.plays) - N(r?.b2) - N(r?.i2) - N(r?.e2));
  return {
    items: [
      { label: "初级", value: beg, color: PRACTICE_LEVEL_COLORS.beg },
      { label: "中级", value: int, color: PRACTICE_LEVEL_COLORS.int },
      { label: "高级", value: exp, color: PRACTICE_LEVEL_COLORS.exp },
      { label: "自定义", value: cus, color: PRACTICE_LEVEL_COLORS.cus },
    ],
    total: beg + int + exp + cus, // 分母=已记级别的盘数（四段之和），占比即刻真实
  };
}

