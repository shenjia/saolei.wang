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


export interface RankedLatencyRow {
  area: string; // 与 user.area / 地图几何同口径（剥后缀省名）
  players: number; // 7 日内参加排行模式的去重人数
  games: number; // 有延迟采样的排行局数
  minRtt: number;
  maxRtt: number;
  avgRtt: number;
}

/** 全国排行延迟地图数据（2026-10-28 张老师需求）：近 N 天 ranked_rtt_log 按省聚合。
 *  颜色按 avgRtt 绿黄红分级（LatencyMap 组件内插值），悬停给人数与最小/平均/最大。 */
export async function getRankedLatencyMap(days = 7): Promise<RankedLatencyRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await prisma.$queryRawUnsafe<
    { area: string; players: bigint; games: bigint; minRtt: number; maxRtt: number; avg: number }[]
  >(
    `SELECT area, COUNT(DISTINCT user_id) players, COUNT(*) games,
            MIN(rtt) minRtt, MAX(rtt) maxRtt, AVG(rtt) avg
     FROM ranked_rtt_log WHERE rtt > 0 AND area <> '' AND create_time >= ?
     GROUP BY area ORDER BY players DESC, games DESC`,
    now - days * 86400
  );
  return rows.map((r) => ({
    area: r.area,
    players: N(r.players),
    games: N(r.games),
    minRtt: N(r.minRtt),
    maxRtt: N(r.maxRtt),
    avgRtt: Math.round(N(r.avg)),
  }));
}

export interface RegionTodayRow {
  area: string;
  plays: number; // 今日练习盘数（尝试，含踩雷）
  players: number; // 今日去重人数
  winRate: number; // 胜率 %（wins/plays，1 位小数）
  avgRtt: number | null; // 平均延迟 ms（排行局采样，无则 null）
  minRtt: number | null;
  maxRtt: number | null;
}

/** 全国各地区今日明细（2026-10-31 张老师需求）：练习盘数/人数/胜率来自
 *  practice_daily 当天按 user.area 聚合（游客 user_id=0 无地区、空 area 不计）；
 *  平均延迟/延迟范围来自 ranked_rtt_log 当天（排行局采样，无数据的省显示 —）。
 *  按盘数从高到低排列。 */
export async function getRegionToday(): Promise<RegionTodayRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const day = Math.floor((now + 28800) / 86400);
  const dayStart = day * 86400 - 28800;
  const pRows = await prisma.$queryRawUnsafe<
    { area: string; players: bigint; plays: bigint; wins: bigint }[]
  >(
    `SELECT u.area area, COUNT(DISTINCT pd.user_id) players, SUM(pd.plays) plays, SUM(pd.wins) wins
     FROM practice_daily pd JOIN user u ON u.id = pd.user_id
     WHERE pd.day = ? AND pd.user_id <> 0 AND u.area <> ''
     GROUP BY u.area`,
    day
  );
  const rRows = await prisma.$queryRawUnsafe<
    { area: string; g: bigint; avg: number; mn: number; mx: number }[]
  >(
    `SELECT area, COUNT(*) g, AVG(rtt) avg, MIN(rtt) mn, MAX(rtt) mx
     FROM ranked_rtt_log WHERE create_time >= ? AND rtt > 0 AND area <> ''
     GROUP BY area`,
    dayStart
  );
  const rttMap = new Map(rRows.map((r) => [r.area, r]));
  const rows: RegionTodayRow[] = pRows.map((r) => {
    const rt = rttMap.get(r.area);
    const plays = N(r.plays);
    return {
      area: r.area,
      plays,
      players: N(r.players),
      winRate: plays ? Math.round((N(r.wins) / plays) * 1000) / 10 : 0,
      avgRtt: rt ? Math.round(N(rt.avg)) : null,
      minRtt: rt ? N(rt.mn) : null,
      maxRtt: rt ? N(rt.mx) : null,
    };
  });
  // 只有延迟采样、无练习盘的省也补一行（延迟数据不丢）
  for (const [area, rt] of rttMap) {
    if (!rows.some((r) => r.area === area)) {
      rows.push({
        area,
        plays: 0,
        players: 0,
        winRate: 0,
        avgRtt: Math.round(N(rt.avg)),
        minRtt: N(rt.mn),
        maxRtt: N(rt.mx),
      });
    }
  }
  return rows.sort((a, b) => b.plays - a.plays || b.players - a.players || a.area.localeCompare(b.area));
}
