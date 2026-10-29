// 后台统计与趋势数据源（2026-09-24 管理后台）
//
// 口径约定：
// · 所有「按天」聚合一律走 +08:00 切天（`FLOOR((create_time + 28800)/86400)`），
//   不依赖 MySQL 会话时区，避免服务器/容器时区变化导致曲线整体平移。
// · COUNT/聚合结果统一用 N() 归一化：MySQL 的 COUNT(*) 回 BigInt、FLOOR() 回 DECIMAL，
//   直接丢给 React/JSON 会炸（Decimal 不可序列化），SQL 里一律 CAST(... AS SIGNED)。
// · 大数据表（video 30 万行、news 15 万行）只做 GROUP BY 聚合，不逐行拉取。

import { prisma } from "@/lib/db";
import { getTitleCounts, rankedOnly } from "@/lib/queries";
import { TITLES, TITLE_THRESHOLDS, VIDEO_STATUS, VIDEO_LEVELS, MIN_3BV_FOR_3BVS, CONTENT_STATUS } from "@/lib/config";
import { assertIdent } from "@/lib/sqlguard";

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
  { key: "banned", label: "屏蔽录像", color: "#f92672" },
  { key: "news", label: "成绩动态", color: "#f79646" },
  { key: "comments", label: "评论", color: "#ae81ff" },
  { key: "bbs", label: "论坛主题", color: "#b1b1a4" },
  { key: "clicks", label: "人气点击", color: "#7dd3fc" },
] as const;

export type TrendKey = (typeof TREND_METRICS)[number]["key"];

/** 单表按天计数（只取窗口内、只取需要的列） */
async function dailyCounts(table: string, since: number, extra = ""): Promise<Map<number, number>> {
  const rows = await prisma.$queryRawUnsafe<{ d: number; c: bigint }[]>(
    // 2026-10-27 加固：表名占位符接不了，拼前过 assertIdent（调用方传的都是常量表名）
    `SELECT CAST(FLOOR((create_time + 28800) / 86400) AS SIGNED) d, COUNT(*) c
     FROM ${assertIdent(table)} WHERE create_time >= ? ${extra} GROUP BY d`,
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
  const [users, videos, reviewed, banned, news, comments, bbs, clicks] = await Promise.all([
    dailyCounts("user", since),
    dailyCounts("video", since),
    dailyCounts("video", since, `AND status = ${VIDEO_STATUS.REVIEWED}`),
    dailyCounts("video", since, `AND status = ${VIDEO_STATUS.BANNED}`),
    dailyCounts("news", since),
    dailyCounts("comment", since),
    dailyCounts("bbs_post", since),
    dailyCounts("click", since),
  ]);

  const dates: string[] = [];
  const series: Record<TrendKey, number[]> = {
    users: [], videos: [], reviewed: [], banned: [], news: [], comments: [], bbs: [], clicks: [],
  };
  const totals = Object.fromEntries(TREND_METRICS.map((m) => [m.key, 0])) as unknown as Record<TrendKey, number>;
  const maps: Record<TrendKey, Map<number, number>> = {
    users, videos, reviewed, banned, news, comments, bbs, clicks,
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
  commentToday: number;
  bbsPostTotal: number;
  bbsPostToday: number;
  bbsReplyTotal: number;
  clickTotal: number;
  messageTotal: number;
  donateTotal: number;
  /** 待人工复核队列（CONTENT_STATUS.PENDING=5：AI 后置审核存疑的评论/论坛帖） */
  commentPending: number;
  bbsPending: number;
  /** 头像待审（avatar_review status=10：AI 判 review 或未过自动闸的） */
  avatarPending: number;
  activeUploaders7d: number;
  activeUploaders30d: number;
  /** 数据取数时刻（Unix 秒）——页面展示用，避免在渲染期调 Date.now()（react-hooks/purity） */
  now: number;
  /** 待审积压：最老一条待审录像的上传时间（0 = 无积压） */
  oldestPendingTime: number;
  /** 待审积压天数 */
  oldestPendingDays: number;
  /** 通过率（全部录像口径，%） */
  passRate: number;
  /** 平均审核耗时（秒，仅统计新站留痕的审核；0 = 无样本） */
  avgAuditSeconds: number;
}

export async function getOverview(): Promise<Overview> {
  const now = Math.floor(Date.now() / 1000);
  const today = dayStart(0);
  const week = dayStart(6);
  const d7 = dayStart(7);
  const d30 = dayStart(30);

  const [
    userTotal, userToday, userWeek, rankedTotal,
    videoTotal, videoReviewed, videoPending, videoBanned, videoToday,
    newsTotal, newsToday, commentTotal, commentToday, bbsPostTotal, bbsPostToday, bbsReplyTotal,
    clickTotal, messageTotal, donateAgg, act7, act30,
    commentPending, bbsPending, avatarPending,
  ] = await Promise.all([
    // 2026-10-14：人数口径与前台上榜口径统一——封禁账号（旧站「停用」）不计入
    prisma.user.count({ where: { status: 0 } }),
    prisma.user.count({ where: { createTime: { gte: BigInt(today) } } }),
    prisma.user.count({ where: { createTime: { gte: BigInt(week) } } }),
    prisma.userScores.count({ where: { sumTime: { gt: 0 }, ...(await rankedOnly()) } }),
    prisma.video.count(),
    prisma.video.count({ where: { status: VIDEO_STATUS.REVIEWED } }),
    prisma.video.count({ where: { status: VIDEO_STATUS.NORMAL } }),
    prisma.video.count({ where: { status: VIDEO_STATUS.BANNED } }),
    prisma.video.count({ where: { createTime: { gte: BigInt(today) } } }),
    prisma.news.count(),
    prisma.news.count({ where: { createTime: { gte: BigInt(today) } } }),
    prisma.comment.count({ where: { status: 0 } }),
    prisma.comment.count({ where: { status: 0, createTime: { gte: BigInt(today) } } }),
    prisma.bbsPost.count({ where: { status: 0 } }),
    prisma.bbsPost.count({ where: { status: 0, createTime: { gte: BigInt(today) } } }),
    prisma.bbsReply.count({ where: { status: 0 } }),
    prisma.click.count(),
    prisma.message.count(),
    prisma.donate.aggregate({ _sum: { amount: true } }),
    activeUploaders(d7),
    activeUploaders(d30),
    // 待人工复核队列（AI 后置审核存疑 → status=5；2026-10-27 论坛口径=主题+回复合计，
    // 与 admin/layout.tsx 侧栏 badge 一致，仪表盘卡片不再漏算回复）
    prisma.comment.count({ where: { status: CONTENT_STATUS.PENDING } }),
    Promise.all([
      prisma.bbsPost.count({ where: { status: CONTENT_STATUS.PENDING } }),
      prisma.bbsReply.count({ where: { status: CONTENT_STATUS.PENDING } }),
    ]).then(([a, b]) => a + b),
    prisma.avatarReview.count({ where: { status: 10 } }),
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
    now,
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
    commentToday,
    bbsPostTotal,
    bbsPostToday,
    bbsReplyTotal,
    clickTotal,
    messageTotal,
    donateTotal: N(donateAgg._sum.amount),
    commentPending,
    bbsPending,
    avatarPending,
    activeUploaders7d: act7,
    activeUploaders30d: act30,
    oldestPendingTime: N(oldest?.createTime),
    oldestPendingDays:
      oldest?.createTime && N(oldest.createTime) > 0
        ? Math.max(0, Math.floor((now - N(oldest.createTime)) / 86400))
        : 0,
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

/** 录像软件分布（video_info.software，旧站多为 Windows 扫雷 / 各版本客户端）
 *  2026-10-29 张老师定：只统计最近 1000 盘（按上传时间倒序取 1000 条再分组，
 *  反映当前玩家在用什么软件，而非 2008 年以来的历史累积）。 */
export async function getSoftwareCounts(limit = 8): Promise<{ label: string; value: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ software: string; c: bigint }[]>(
    `SELECT software, COUNT(*) c FROM (
       SELECT vi.software software FROM video v JOIN video_info vi ON vi.id = v.id
       ORDER BY v.create_time DESC, v.id DESC LIMIT 1000
     ) t WHERE software <> '' GROUP BY software ORDER BY c DESC LIMIT ${limit}`
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

/**
 * 称号体系偏好分布（2026-10-21 张老师需求：统计新版军衔 vs 旧版人神界称号占比）。
 * 口径（2026-10-29 收紧）：近 30 天登录过且 user_info 有行的账号（user.last_login_time
 * 由 setSession 实时刷新；纯注册无 user_info 行不建偏好）。
 * 'm'=军衔制（默认口径，含未主动设置）/ 'c'=旧版称号（主动切换）。
 */
export async function getTitlePrefCounts(): Promise<{ label: string; value: number }[]> {
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const rows = await prisma.$queryRawUnsafe<{ pref: string; c: bigint }[]>(
    `SELECT ui.title_pref pref, COUNT(*) c
     FROM user_info ui JOIN \`user\` u ON u.id = ui.id
     WHERE u.last_login_time >= ? GROUP BY ui.title_pref`,
    BigInt(since)
  );
  const map = new Map(rows.map((r) => [r.pref, N(r.c)]));
  const classic = map.get("c") ?? 0;
  // 脏值（非 'c'）与 'm' 一样按军衔口径渲染，并入军衔制
  // 2026-10-23 修双重计数：filter(≠'c') 求和已含 'm'，原先又 +map.get('m') 把 'm' 算了两遍
  const military = [...map.entries()].filter(([k]) => k !== "c").reduce((s, [, v]) => s + v, 0);
  return [
    { label: "军衔制（默认口径）", value: military },
    { label: "旧版人神界称号", value: classic },
  ];
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
         ${order === "3bvs" ? `AND vi.board_3bv >= ${MIN_3BV_FOR_3BVS[level]}` : ""}
     ) t WHERE val ${cmp} run ORDER BY ct`,
    level
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

// ---------- 当前纪录 / 快照健康度 ----------

export interface CurrentRecord {
  level: "beg" | "int" | "exp";
  levelName: string;
  time: number;
  timeVideo: number;
  timeUser: number;
  timeDate: number;
  b3bvs: number;
  b3bvsVideo: number;
  b3bvsUser: number;
  b3bvsDate: number;
}

/** 三级当前最好成绩（含持有人与被承认录像），数据分析页顶部用 */
export async function getCurrentRecords(): Promise<CurrentRecord[]> {
  const names: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
  const fields: [string, string, string, string, string, string][] = [
    ["beg", "beg_time", "beg_time_video", "beg_time_date", "beg_3bvs", "beg_3bvs_video"],
    ["int", "int_time", "int_time_video", "int_time_date", "int_3bvs", "int_3bvs_video"],
    ["exp", "exp_time", "exp_time_video", "exp_time_date", "exp_3bvs", "exp_3bvs_video"],
  ];
  return Promise.all(
    fields.map(async ([level, tf, tv, td, bf, bv]) => {
      const rows = await prisma.$queryRawUnsafe<Record<string, bigint | number | null>[]>(
        `SELECT s.id, s.${tf} t, s.${tv} tv, s.${td} td, s.${bf} b, s.${bv} bvid
         FROM user_scores s JOIN \`user\` u ON u.id = s.id AND u.status = 0
         WHERE s.${tf} > 0 ORDER BY s.${tf} ASC LIMIT 1`
      );
      const r = rows[0] ?? null;
      const uid = N(r?.id);
      const bRows = r
        ? await prisma.$queryRawUnsafe<Record<string, bigint | number | null>[]>(
            `SELECT s.id, s.${bf} b, s.${bv} bvid, s.update_time ut
             FROM user_scores s JOIN \`user\` u ON u.id = s.id AND u.status = 0
             WHERE s.${bf} > 0 ORDER BY s.${bf} DESC LIMIT 1`
          )
        : [];
      const b = bRows[0] ?? null;
      return {
        level: level as "beg" | "int" | "exp",
        levelName: names[level],
        time: N(r?.t),
        timeVideo: N(r?.tv),
        timeUser: uid,
        timeDate: N(r?.td),
        b3bvs: N(b?.b),
        b3bvsVideo: N(b?.bvid),
        b3bvsUser: N(b?.id),
        b3bvsDate: 0,
      };
    })
  );
}

/** 排行快照健康度（今日是否已刷新、窗口累计天数、最新日期）
 *  2026-10-22 JSON 重构后：ranks 是每人一个 JSON 对象 {date: rank}，无独立 date 列——
 *  今日判定 = 任一行 ranks 含今日键；窗口天数 = 全表 JSON 键的并集天数。 */
export async function getSnapshotHealth(): Promise<{ todayDone: boolean; days: number; latest: string }> {
  const today = dayIndexToDate(Math.floor((Date.now() / 1000 + 28800) / 86400));
  const [todayRows, dayRows, latestRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) c FROM rank_snapshot WHERE JSON_CONTAINS_PATH(ranks, 'one', ?)`,
      `$."${today}"`
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(DISTINCT jt.k) c FROM rank_snapshot,
       JSON_TABLE(JSON_KEYS(ranks), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) jt`
    ),
    prisma.$queryRawUnsafe<{ k: string }[]>(
      `SELECT MAX(jt.k) k FROM rank_snapshot,
       JSON_TABLE(JSON_KEYS(ranks), '$[*]' COLUMNS(k VARCHAR(10) PATH '$')) jt`
    ),
  ]);
  return { todayDone: N(todayRows[0]?.c) > 0, days: N(dayRows[0]?.c), latest: latestRows[0]?.k ?? "—" };
}

/** 军衔阈值表（2026-10-13 起为常量 TITLE_THRESHOLDS，不再读 distribution）+ 各军衔人数，军衔页/仪表盘共用 */
export async function getTitleThresholds(): Promise<{
  size: number;
  createTime: number;
  rows: { title: string; threshold: number; count: number }[];
} | null> {
  const [counts] = await Promise.all([getTitleCounts()]);
  const thresholds = TITLE_THRESHOLDS;
  const countMap = new Map(counts.map((c) => [c.title, c.count]));
  return {
    size: 0,
    // SUB 制颁布时间（2026-10-13 0 点 +08:00）
    createTime: 1791254400,
    // 与 assess.ts title() 同口径：总司令不占阈值档（雷界第一人特判），thresholds[i] 对应 TITLES[i + 1]
    // （2026-10-28 修 off-by-one：原 TITLES[i] 对 thresholds[i] 各档错一位，总司令被标 35s）
    rows: TITLES.map((t, i) => ({
      title: t,
      threshold: i >= 1 ? thresholds[i - 1] ?? 0 : 0,
      count: countMap.get(t) ?? 0,
    })),
  };
}
