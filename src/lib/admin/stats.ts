// 后台统计与趋势数据源（2026-09-24 管理后台）
//
// 口径约定：
// · 所有「按天」聚合一律走 +08:00 切天（`FLOOR((create_time + 28800)/86400)`），
//   不依赖 MySQL 会话时区，避免服务器/容器时区变化导致曲线整体平移。
// · COUNT/聚合结果统一用 N() 归一化：MySQL 的 COUNT(*) 回 BigInt、FLOOR() 回 DECIMAL，
//   直接丢给 React/JSON 会炸（Decimal 不可序列化），SQL 里一律 CAST(... AS SIGNED)。
// · 大数据表（video 30 万行、news 15 万行）只做 GROUP BY 聚合，不逐行拉取。

import { prisma } from "@/lib/db";
import { VIDEO_STATUS, VIDEO_LEVELS } from "@/lib/config";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

/** 本地（+08:00）当天 0 点往前 daysAgo 天，Unix 秒 */
export function dayStart(daysAgo = 0): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000) - daysAgo * 86400;
}

/** +08:00 切天序号 → YYYY-MM-DD */
const dayIndexToDate = (d: number): string => new Date(d * 86400000).toISOString().slice(0, 10);

/** 日序号 → 本地日 0 点秒（图表 x 轴对齐用） */
const dayIndexToSec = (d: number): number => d * 86400 - 28800;

// ---------- 趋势曲线 ----------

export const TREND_METRICS = [
  { key: "users", label: "新增玩家", color: "#a6e22e" },
  { key: "videos", label: "上传录像", color: "#66d9ef" },
  { key: "reviewed", label: "通过录像", color: "#e6db74" },
  { key: "news", label: "成绩动态", color: "#f79646" },
  { key: "comments", label: "评论", color: "#ae81ff" },
  { key: "bbs", label: "论坛主题", color: "#f92672" },
  { key: "clicks", label: "人气点击", color: "#b1b1a4" },
] as const;

export type TrendKey = (typeof TREND_METRICS)[number]["key"];

/** 单表按天计数（只取窗口内、只取需要的列） */
async function dailyCounts(table: string, since: number, extra = ""): Promise<Map<number, number>> {
  const rows = await prisma.$queryRawUnsafe<{ d: number; c: bigint }[]>(
    `SELECT CAST(FLOOR((create_time + 28800) / 86400) AS SIGNED) d, COUNT(*) c
     FROM ${table} WHERE create_time >= ? ${extra} GROUP BY d`,
    since
  );
  return new Map(rows.map((r) => [N(r.d), N(r.c)]));
}

export interface TrendData {
  /** YYYY-MM-DD，长度 = days */
  dates: string[];
  /** 各指标每日值，与 dates 等长 */
  series: Record<TrendKey, number[]>;
  /** 各指标窗口内合计 */
  totals: Record<TrendKey, number>;
}

/** 近 N 天多指标趋势（仪表盘 / 数据分析页共用） */
export async function getTrend(days = 30): Promise<TrendData> {
  const since = dayStart(days - 1);
  const from = Math.floor((since + 28800) / 86400);
  const [users, videos, reviewed, news, comments, bbs, clicks] = await Promise.all([
    dailyCounts("user", since),
    dailyCounts("video", since),
    dailyCounts("video", since, `AND status = ${VIDEO_STATUS.REVIEWED}`),
    dailyCounts("news", since),
    dailyCounts("comment", since),
    dailyCounts("bbs_post", since),
    dailyCounts("click", since),
  ]);

  const dates: string[] = [];
  const series: Record<TrendKey, number[]> = {
    users: [], videos: [], reviewed: [], news: [], comments: [], bbs: [], clicks: [],
  };
  const totals = { ...series } as unknown as Record<TrendKey, number>;
  const maps: Record<TrendKey, Map<number, number>> = {
    users, videos, reviewed, news, comments, bbs, clicks,
  };

  for (let i = 0; i < days; i++) {
    const idx = from + i;
    dates.push(dayIndexToDate(idx));
    for (const m of TREND_METRICS) {
      const v = maps[m.key].get(idx) ?? 0;
      series[m.key].push(v);
      totals[m.key] += v;
    }
  }
  return { dates, series, totals };
}

// ---------- 概览指标 ----------

export interface Overview {
  userTotal: number;
  userToday: number;
  userWeek: number;
  rankedTotal: number;
  videoTotal: number;
  videoReviewed: number;
  videoPending: number;
  videoBanned: number;
  videoToday: number;
  newsTotal: number;
  newsToday: number;
  commentTotal: number;
  bbsPostTotal: number;
  bbsReplyTotal: number;
  clickTotal: number;
  messageTotal: number;
  donateTotal: number;
  activeUploaders7d: number;
  activeUploaders30d: number;
  /** 待审积压：最老一条待审录像的上传时间（0 = 无积压） */
  oldestPendingTime: number;
  /** 通过率（全部录像口径，%） */
  passRate: number;
  /** 平均审核耗时（秒，仅统计新站留痕的审核；0 = 无样本） */
  avgAuditSeconds: number;
}

export async function getOverview(): Promise<Overview> {
  const today = dayStart(0);
  const week = dayStart(6);
  const d7 = dayStart(7);
  const d30 = dayStart(30);

  const [
    userTotal, userToday, userWeek, rankedTotal,
    videoTotal, videoReviewed, videoPending, videoBanned, videoToday,
    newsTotal, newsToday, commentTotal, bbsPostTotal, bbsReplyTotal,
    clickTotal, messageTotal, donateAgg, act7, act30,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createTime: { gte: BigInt(today) } } }),
    prisma.user.count({ where: { createTime: { gte: BigInt(week) } } }),
    prisma.userScores.count({ where: { sumTime: { gt: 0 } } }),
    prisma.video.count(),
    prisma.video.count({ where: { status: VIDEO_STATUS.REVIEWED } }),
    prisma.video.count({ where: { status: VIDEO_STATUS.NORMAL } }),
    prisma.video.count({ where: { status: VIDEO_STATUS.BANNED } }),
    prisma.video.count({ where: { createTime: { gte: BigInt(today) } } }),
    prisma.news.count(),
    prisma.news.count({ where: { createTime: { gte: BigInt(today) } } }),
    prisma.comment.count({ where: { status: 0 } }),
    prisma.bbsPost.count({ where: { status: 0 } }),
    prisma.bbsReply.count({ where: { status: 0 } }),
    prisma.click.count(),
    prisma.message.count(),
    prisma.donate.aggregate({ _sum: { amount: true } }),
    activeUploaders(d7),
    activeUploaders(d30),
  ]);

  // 待审积压最老一条 + 平均审核耗时（新站才写 review_time）
  const oldest = await prisma.video.findFirst({
    where: { status: VIDEO_STATUS.NORMAL },
    orderBy: { createTime: "asc" },
    select: { createTime: true },
  });
  const audit = await prisma.$queryRawUnsafe<{ avg_gap: number | null; c: bigint }[]>(
    `SELECT AVG(review_time - create_time) avg_gap, COUNT(*) c
     FROM video WHERE review_time > 0 AND review_time >= create_time`
  );
  const auditGap = audit[0]?.avg_gap;
  const auditCount = N(audit[0]?.c);

  return {
    userTotal,
    userToday,
    userWeek,
    rankedTotal,
    videoTotal,
    videoReviewed,
    videoPending,
    videoBanned,
    videoToday,
    newsTotal,
    newsToday,
    commentTotal,
    bbsPostTotal,
    bbsReplyTotal,
    clickTotal,
    messageTotal,
    donateTotal: N(donateAgg._sum.amount),
    activeUploaders7d: act7,
    activeUploaders30d: act30,
    oldestPendingTime: N(oldest?.createTime),
    passRate: videoTotal ? Math.round((videoReviewed / videoTotal) * 1000) / 10 : 0,
    avgAuditSeconds: auditCount && auditGap != null ? Math.round(Number(auditGap)) : 0,
  };
}

/** 窗口内有上传行为的去重玩家数（活跃度） */
async function activeUploaders(since: number): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(DISTINCT user) c FROM video WHERE create_time >= ?`,
    since
  );
  return N(rows[0]?.c);
}

// ---------- 分布 ----------

/** 地区分布 Top N（空地区归入「未填写」） */
export async function getAreaCounts(limit = 12): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ area: string; c: bigint }[]>(
    `SELECT area, COUNT(*) c FROM user WHERE area <> '' GROUP BY area ORDER BY c DESC LIMIT ${limit}`
  );
  const empty = await prisma.user.count({ where: { area: "" } });
  const list = rows.map((r) => ({ label: r.area, value: N(r.c) }));
  if (empty > 0) list.push({ label: "未填写", value: empty });
  return list;
}

/** 录像软件分布（video_info.software，旧站多为 Windows 扫雷 / 各版本客户端） */
export async function getSoftwareCounts(limit = 8): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ software: string; c: bigint }[]>(
    `SELECT software, COUNT(*) c FROM video_info WHERE software <> '' GROUP BY software ORDER BY c DESC LIMIT ${limit}`
  );
  return rows.map((r) => ({ label: r.software || "未知", value: N(r.c) }));
}

/** 性别分布（1 男 / 0 女 / 其他） */
export async function getSexCounts(): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ sex: number; c: bigint }[]>(
    `SELECT sex, COUNT(*) c FROM user GROUP BY sex`
  );
  const names: Record<number, string> = { 1: "男", 0: "女" };
  return rows
    .map((r) => ({ label: names[N(r.sex)] ?? "其他", value: N(r.c) }))
    .sort((a, b) => b.value - a.value);
}

/** 录像级别分布 */
export async function getLevelCounts(): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ level: string; c: bigint }[]>(
    `SELECT level, COUNT(*) c FROM video GROUP BY level`
  );
  const names: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
  const map = new Map(rows.map((r) => [r.level, N(r.c)]));
  return VIDEO_LEVELS.map((l) => ({ label: names[l] ?? l, value: map.get(l) ?? 0 }));
}

/** NF（无标）录像占比 */
export async function getNfCounts(): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ noflag: number; c: bigint }[]>(
    `SELECT noflag, COUNT(*) c FROM video_info GROUP BY noflag`
  );
  const map = new Map(rows.map((r) => [N(r.noflag), N(r.c)]));
  return [
    { label: "标雷", value: map.get(0) ?? 0 },
    { label: "无标 NF", value: map.get(1) ?? 0 },
  ];
}

/** 地图尺寸分布（按 3BV 分档，看玩家主攻难度） */
export async function getBoardCounts(): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ bucket: number; c: bigint }[]>(
    `SELECT CAST(FLOOR(board_3bv / 50) AS SIGNED) bucket, COUNT(*) c FROM video_info GROUP BY bucket ORDER BY bucket`
  );
  const labels: Record<number, string> = { 0: "0-49", 1: "50-99", 2: "100-149", 3: "150-199", 4: "200+" };
  return rows
    .filter((r) => N(r.bucket) <= 4)
    .map((r) => ({ label: `${labels[N(r.bucket)] ?? "200+"} 3BV`, value: N(r.c) }));
}

// ---------- 异常检测（待办清单用） ----------

export interface Anomalies {
  /** video 有主记录但缺 video_info（上传中断/解析失败） */
  orphanVideos: number;
  /** 同一 hash 出现多次（重复上传） */
  duplicateHashGroups: number;
  /** 已通过但 3BV 低于级别下限（疑似改包） */
  lowBoardVideos: number;
  /** 有录像却无任何成绩的玩家 */
  scoreMissingUsers: number;
}

export async function getAnomalies(): Promise<Anomalies> {
  const [orphan, dup, low, missing] = await Promise.all([
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM video v LEFT JOIN video_info vi ON vi.id = v.id WHERE vi.id IS NULL`
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM (SELECT hash FROM video GROUP BY hash HAVING COUNT(*) > 1) t`
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM video v JOIN video_info vi ON vi.id = v.id
       WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND (
         (v.level = 'beg' AND vi.board_3bv < 2) OR
         (v.level = 'int' AND vi.board_3bv < 30) OR
         (v.level = 'exp' AND vi.board_3bv < 100))`
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM video v LEFT JOIN user_scores s ON s.id = v.user WHERE s.id IS NULL AND v.status = ${VIDEO_STATUS.REVIEWED}`
    ),
  ]);
  return {
    orphanVideos: N(orphan[0]?.c),
    duplicateHashGroups: N(dup[0]?.c),
    lowBoardVideos: N(low[0]?.c),
    scoreMissingUsers: N(missing[0]?.c),
  };
}

// ---------- 排行榜 / 纪录演变 ----------

export interface RecordPoint {
  date: string;
  value: number;
}

/**
 * 纪录演变曲线：按上传时间推进，取出「每一次刷新纪录」的点。
 * order=time → 取运行最小时间；order=3bvs → 取运行最大 3BV/s。
 * 只统计已通过录像（含历史全量），窗口函数一次算完。
 */
export async function getRecordCurve(
  level: "beg" | "int" | "exp",
  order: "time" | "3bvs",
  limit = 200
): Promise<RecordPoint[]> {
  const expr = order === "time" ? "vi.real_time" : "(vi.board_3bv * 1000000.0 / vi.real_time)";
  const agg = order === "time" ? "MIN" : "MAX";
  const cmp = order === "time" ? "<=" : ">=";
  const rows = await prisma.$queryRawUnsafe<{ ct: number; val: number }[]>(
    `SELECT ct, val FROM (
       SELECT v.create_time ct, ${expr} val,
              ${agg}(${expr}) OVER (ORDER BY v.create_time, v.id ROWS UNBOUNDED PRECEDING) run
       FROM video v JOIN video_info vi ON vi.id = v.id
       WHERE v.level = ? AND v.status = ${VIDEO_STATUS.REVIEWED} AND vi.real_time > 0
         ${order === "3bvs" ? "AND vi.board_3bv >= 4" : ""}
     ) t WHERE val ${cmp} run ORDER BY ct`
  );
  const raw = rows.map((r) => ({ time: N(r.ct), value: N(r.val) }));
  // 点数过多时等距抽样（保留首尾）
  if (raw.length <= limit) {
    return raw.map((r) => ({ date: dayIndexToDate(Math.floor((r.time + 28800) / 86400)), value: r.value }));
  }
  const step = Math.ceil(raw.length / limit);
  const picked = raw.filter((_, i) => i % step === 0 || i === raw.length - 1);
  return picked.map((r) => ({ date: dayIndexToDate(Math.floor((r.time + 28800) / 86400)), value: r.value }));
}

/** 上传时段分布（0-23 时，按 +08:00 折算） */
export async function getHourlyCounts(): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ h: number; c: bigint }[]>(
    `SELECT CAST(FLOOR(((create_time + 28800) % 86400) / 3600) AS SIGNED) h, COUNT(*) c
     FROM video GROUP BY h ORDER BY h`
  );
  const map = new Map(rows.map((r) => [N(r.h), N(r.c)]));
  return Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, value: map.get(h) ?? 0 }));
}

/** 星期分布（0=周日） */
export async function getWeekdayCounts(): Promise<{ label: string; value: number }[]> {
  // 1970-01-01 是周四：dayIndex 对 7 取模后再补 4 得星期
  const rows = await prisma.$queryRawUnsafe<{ w: number; c: bigint }[]>(
    `SELECT CAST(((FLOOR((create_time + 28800) / 86400) + 4) % 7) AS SIGNED) w, COUNT(*) c
     FROM video GROUP BY w ORDER BY w`
  );
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const map = new Map(rows.map((r) => [N(r.w), N(r.c)]));
  return names.map((label, i) => ({ label, value: map.get(i) ?? 0 }));
}

/** 审核员工作量（有留痕的审核记录） */
export async function getAuditorWorkload(limit = 10): Promise<{ user: number; count: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ review_user: bigint; c: bigint }[]>(
    `SELECT review_user, COUNT(*) c FROM video WHERE review_user IS NOT NULL AND review_user > 0
     GROUP BY review_user ORDER BY c DESC LIMIT ${limit}`
  );
  return rows.map((r) => ({ user: N(r.review_user), count: N(r.c) }));
}

/** 增长曲线：每日新增 + 累计（累计基数取窗口前总量，前缀和推） */
export async function getGrowth(days = 90): Promise<{ dates: string[]; daily: number[]; cumulative: number[] }> {
  const since = dayStart(days - 1);
  const from = Math.floor((since + 28800) / 86400);
  const map = await dailyCounts("user", since);
  const before = await prisma.user.count({ where: { createTime: { lt: BigInt(since) } } });

  const dates: string[] = [];
  const daily: number[] = [];
  const cumulative: number[] = [];
  let acc = before;
  for (let i = 0; i < days; i++) {
    const v = map.get(from + i) ?? 0;
    acc += v;
    dates.push(dayIndexToDate(from + i));
    daily.push(v);
    cumulative.push(acc);
  }
  return { dates, daily, cumulative };
}

export { dayIndexToDate, dayIndexToSec };
