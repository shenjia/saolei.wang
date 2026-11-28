// 比赛业务层（2026-11-13 张老师需求：前台「比赛」页 + 后台「比赛管理」）
//
// 口径备忘：
// · 状态不落库，由起止时间对 now 推导（未开始/进行中/已结束）；
// · 列表排序＝进行中 → 未开始 → 已结束（张老师 13:12 定）；同状态内：
//   进行中按结束时间升序（先结束的在前）、未开始按开始时间升序、已结束按结束时间倒序；
// · 比赛总量小（十场量级），列表整表取回内存排序 + 切页，避免 CASE WHEN 裸拼 SQL；
// · 比赛标识 code 默认留空（NULL=未设置不展示）；后台可手填/随机生成，唯一约束；
// · 成绩采集为下一期口径：本期图表无数据源，渲染占位；全网统计「录像数量」恒 0。

import { prisma } from "@/lib/db";
import { unstable_cache } from "next/cache";
import { getVideosByIds, type VideoListItem } from "@/lib/queries";
import { publishNews } from "@/lib/news";
import { NEWS_TYPE } from "@/lib/config";
import { dualTitles } from "@/lib/title-system";
import {
  LEVELS,
  LEVEL_NAMES,
  VIDEO_LIST_DEFAULT_DIR,
  assertVideoLevel,
  MIN_3BV_FOR_3BVS,
  type Level,
  type VideoLevel,
  type VideoListOrder,
  type VideoListDir,
} from "@/lib/config";

export type TournamentStatus = "upcoming" | "active" | "ended";

export const TOUR_PAGE_SIZE = 5; // 张老师：一页最多同时显示 5 个比赛

export function tourStatus(
  start: bigint | number,
  end: bigint | number,
  now: number
): TournamentStatus {
  const s = Number(start);
  const e = Number(end);
  if (now < s) return "upcoming";
  if (now < e) return "active";
  return "ended";
}

const STATUS_ORDER: Record<TournamentStatus, number> = { active: 0, upcoming: 1, ended: 2 };

// ---------- 展示格式化 ----------

/** 相对时长：X天X时X分 / X时X分 / X分（气泡倒计时与已结束相对时间共用） */
export function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天${h}时${m}分`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}

/** 已结束时刻展示：一天内相对（X时X分前），否则绝对（M月D日 HH:mm） */
export function fmtEndedAt(end: bigint | number, now: number): string {
  const e = Number(end);
  const diff = now - e;
  if (diff < 86400) return `${fmtDuration(Math.max(diff, 0))}前`;
  const d = new Date(e * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** 起止日期小标：11月11日 ~ 12月3日（跨年带年份）；括号版/裸版共用（裸版=图表下「比赛时间」行） */
export function fmtDateRange(start: bigint | number, end: bigint | number): string {
  const s = new Date(Number(start) * 1000);
  const e = new Date(Number(end) * 1000);
  // 精确到分钟（张老师 2026-11-18 详情页反馈）：比赛起止时刻恒为整点分钟级
  const f = (d: Date) =>
    `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const year = s.getFullYear() === e.getFullYear() ? "" : `${s.getFullYear()}年`;
  return `${year}${f(s)} ~ ${f(e)}`;
}

export const fmtPrize = (n: number): string => `¥${n.toLocaleString("en-US")}`;

/** 分配方案原文 → 气泡文本（每行一名次，逗号拼接；空行过滤） */
export function parsePrizePlan(plan: string): string[] {
  return plan
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 剩余时间气泡颜色分级（张老师 13:12 稿定）：一天以上绿 / 一小时内黄 / 10 分钟内玫瑰红 */
export function remainColor(sec: number): string {
  if (sec <= 600) return "#f92672";
  if (sec <= 3600) return "#fdc61a";
  return "#a6e22e";
}

// ---------- 比赛标识 ----------

const CODE_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 5 位数字+大小写字母随机标识（后台按钮生成/手填都走应用层查重，唯一索引兜底） */
export function genTourCode(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export async function genUniqueTourCode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = genTourCode();
    const hit = await prisma.tournament.findFirst({ where: { code }, select: { id: true } });
    if (!hit) return code;
  }
  return `${Date.now().toString(36)}`.slice(-5); // 兜底：碰撞概率极低，仍保证可写
}

// ---------- 列表查询 ----------

export interface TourRow {
  id: string;
  alias: string; // 比赛代号（""=未设置；详情页链接优先用 /tournaments/<alias>，2026-11-19）
  name: string;
  shortName: string;
  status: TournamentStatus;
  start: number;
  end: number;
  rules: string;
  creatorName: string;
  prizeTotal: number;
  prizeLines: string[];
  code: string; // 比赛标识（""=未设置，前台不展示标识行）
  entryCount: number;
  /** 完赛人数（标题状态标签「xx人已完赛」用；同 getTourDetailStats.finishers 口径） */
  finishedCount: number;
  joined: boolean; // 当前登录用户是否已报名
  levels: Level[]; // 收录录像级别（张老师 2026-11-13：可多选，默认初中高都有）
  /** 自选窗口时长（小时，0=同期集体赛；>0=窗口赛，张老师 2026-11-19） */
  windowHours: number;
  /** 我的进行中窗口会话（窗口赛已手动开赛；null=未开赛/无窗口）。
   *  2026-11-22 起 finished=true 表示该窗口已结束（「一人一赛只能开一次」——
   *  右栏显示「已完赛」不可再开赛；历史双会话取最早一次） */
  mySession: { race: string; start: number; end: number; finished: boolean } | null;
  creatorId: number; // 发起人（图表下方玩家卡片式名字展示：性别+军衔）
  creatorEnglishName: string;
  creatorSex: number;
  creatorTitle: string; // 军衔制称号
  creatorClassic: { name: string; color: string } | null; // 旧版称号备选
  /** 计分数据项与方向（2026-11-21 多数据项：最好成绩行/图表按 metric 格式化、
   *  按方向标注「越大越好」）——详情页 getTournamentDetail 填充解析值 */
  scoreMetric: TourMetricKey;
  scoreDesc: boolean;
  /** 计分方式与配置原文（详情页 tourMetric 解析用；列表行空串） */
  scoreMode: string;
  scoreConfig: string;
  /** 纪录图表散点（详情页形态填充：按比赛设定总分排名全部有成绩参赛者，score 秒；列表形态为空数组） */
  chartPoints: {
    rank: number;
    score: number;
    name?: string;
    uid?: number;
    englishName?: string;
    sex?: number;
    title?: string;
    classic?: { name: string; color: string } | null;
  }[];
  /** 图表上方「最好成绩」行（详情页形态填充；无成绩 null）——总分口径第一名 */
  bestLine: {
    score: number;
    name: string;
    englishName: string;
    sex: number;
    title: string;
    uid: number;
    at: number;
  } | null;
}

export interface TourPage {
  rows: TourRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 比赛列表：状态排序 → 内存切页。uid 传入时带「是否已报名」标记。
 *  pageSize 供「加载更多」大批量取数（82ff927 口径：size 只是本批行数 take） */
export async function getTournamentPage(page: number, uid?: number, pageSize?: number): Promise<TourPage> {
  const now = Math.floor(Date.now() / 1000);
  const size = Math.min(Math.max(pageSize ?? TOUR_PAGE_SIZE, 1), 100);
  const all = await prisma.tournament.findMany({
    orderBy: { startTime: "asc" },
  });

  // 报名数一次聚合
  const counts = await prisma.tournamentEntry.groupBy({
    by: ["tournamentId"],
    _count: { tournamentId: true },
  });
  const countMap = new Map<string, number>(counts.map((c) => [c.tournamentId.toString(), c._count.tournamentId]));

  // 我的报名集合
  let mineSet = new Set<string>();
  if (uid) {
    const mine = await prisma.tournamentEntry.findMany({
      where: { userId: BigInt(uid) },
      select: { tournamentId: true },
    });
    mineSet = new Set(mine.map((m) => m.tournamentId.toString()));
  }

  // 发起人：姓名/英文名/性别 + 称号评定数据（user_scores 与 user 同主键；
  // ranked=当前是否在榜即 user.status===0，与查询线口径一致）
  const creatorIds = [...new Set(all.map((c) => c.creatorId.toString()))];
  const creatorBigs = creatorIds.map((s) => BigInt(s));
  const [creators, scoreRows] = creatorIds.length
    ? await Promise.all([
        prisma.user.findMany({
          where: { id: { in: creatorBigs } },
          select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
        }),
        prisma.userScores.findMany({
          where: { id: { in: creatorBigs } },
          select: { id: true, expTime: true },
        }),
      ])
    : [[], []];
  const nameMap = new Map(creators.map((u) => [u.id.toString(), u.chineseName]));
  const creatorMap = new Map(creators.map((u) => [u.id.toString(), u]));
  const expMap = new Map(scoreRows.map((s) => [s.id.toString(), s.expTime ?? 0]));
  // 双体系称号一次评定（dualTitles 内部取一次雷界阈值；行序与 creators 对齐）
  const titlePairs = creators.length
    ? await dualTitles(
        creators.map((u) => ({
          userId: Number(u.id),
          expTime: expMap.get(u.id.toString()) ?? 0,
          ranked: u.status === 0,
          sex: u.sex,
        })),
      )
    : [];
  const titleMap = new Map(creators.map((u, i) => [u.id.toString(), titlePairs[i]]));

  // 收录级别解析（容错：非法键剔除；全空回退全级别）
  const parseLevels = (raw: string): Level[] => {
    const set = new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is Level => (LEVELS as readonly string[]).includes(s)),
    );
    return set.size ? LEVELS.filter((l) => set.has(l)) : [...LEVELS];
  };

  const rows: TourRow[] = all.map((c) => {
    const cid = c.id.toString();
    return {
      id: cid,
      alias: c.alias ?? "",
      name: c.name,
      shortName: c.shortName,
      status: tourStatus(c.startTime, c.endTime, now),
      start: Number(c.startTime),
      end: Number(c.endTime),
      rules: c.rules,
      creatorName: nameMap.get(c.creatorId.toString()) || `UID ${c.creatorId}`,
      prizeTotal: c.prizeTotal,
      prizeLines: parsePrizePlan(c.prizePlan),
      code: c.code ?? "",
      windowHours: c.windowHours ?? 0,
      mySession: null, // 列表行批量填充见下方会话查询
      entryCount: countMap.get(cid) ?? 0,
      finishedCount: 0, // 本页行填值见下方（只算当前页，不逐场扫全库）
      joined: mineSet.has(cid),
      levels: parseLevels(c.includeLevels),
      creatorId: Number(c.creatorId),
      creatorEnglishName: creatorMap.get(c.creatorId.toString())?.englishName ?? "",
      creatorSex: creatorMap.get(c.creatorId.toString())?.sex ?? 1,
      creatorTitle: titleMap.get(c.creatorId.toString())?.m ?? "",
      creatorClassic: titleMap.get(c.creatorId.toString())?.c ?? null,
      scoreMetric: parseScoreConfig(c.scoreMode, c.scoreConfig)?.metric ?? "time",
      scoreDesc: parseScoreConfig(c.scoreMode, c.scoreConfig)?.desc ?? false,
      scoreMode: c.scoreMode,
      scoreConfig: c.scoreConfig,
      chartPoints: [], // 列表形态不取图表数据（详情页才有）
      bestLine: null,
    };
  });

  // 排序：进行中 → 未开始 → 已结束（张老师 13:12 定）
  rows.sort((a, b) => {
    const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (d !== 0) return d;
    if (a.status === "active") return a.end - b.end; // 先结束的在前
    if (a.status === "upcoming") return a.start - b.start;
    return b.end - a.end; // 已结束：最近的在前
  });

  // 列表页图表数据（2026-11-19 张老师问「比赛列表为什么没显示图表」）：
  // 当前页每场已开赛的比赛取全部有成绩参赛者散点（带我的名次标记数据），并行拉取
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(page, 1), totalPages);
  const pageRows = rows.slice((p - 1) * size, p * size);
  // 完赛人数批量算分（与后台/详情页 finishers 同口径）：只算当前页行，一次取齐四表
  const finisherMap = await getTourFinishersBulk(pageRows.map((r) => Number(r.id)));
  pageRows.forEach((r) => { r.finishedCount = finisherMap.get(Number(r.id))?.length ?? 0; });
  const chartTargets = pageRows.filter((r) => r.status !== "upcoming");
  // 列表页图表改 TOP30（2026-11-27 张老师定「列表页改 TOP30」）：详情页保持全量口径，
  // 列表页只展示前 30 名散点（TourBlock 右上角有截断提示文案）
  const chartList = await Promise.all(chartTargets.map((r) => fetchTourListChartCached(Number(r.id))));
  const chartMap = new Map<string, { rank: number; score: number; name?: string; uid?: number; englishName?: string; sex?: number; title?: string; classic?: { name: string; color: string } | null }[]>();
  const bestMap = new Map<string, TourRow["bestLine"]>();
  chartTargets.forEach((r, i) => {
    chartMap.set(r.id, chartList[i].points);
    bestMap.set(
      r.id,
      chartList[i].best
        ? {
            ...chartList[i].best!,
            at: 0, // 列表形态不查「创造于」精确时刻（多一次查询单场比赛），渲染端 at=0 时不显示时刻段
          }
        : null,
    );
  });
  // 我的窗口会话（2026-11-19 窗口赛）：登录态下当前页各窗口赛的一场进行中会话
  for (const r of pageRows) {
    r.chartPoints = chartMap.get(r.id) ?? [];
    r.bestLine = bestMap.get(r.id) ?? null;
  }
  if (uid) {
    const pageWindowIds = pageRows.filter((r) => r.windowHours > 0).map((r) => BigInt(r.id));
    if (pageWindowIds.length) {
      // 取全部历史会话（不限进行中）：一人一赛只能开一次（2026-11-22），
      // 最早一次=本人参赛窗口；已结束的窗口 finished=true（列表行用于展示态判断）
      const sessions = await prisma.tournamentWindowSession.findMany({
        where: { tournamentId: { in: pageWindowIds }, userId: BigInt(uid) },
        select: { tournamentId: true, race: true, startTime: true, endTime: true },
        orderBy: { startTime: "asc" },
      });
      const sessMap = new Map<string, (typeof sessions)[number]>();
      for (const s of sessions) {
        const key = s.tournamentId.toString();
        if (!sessMap.has(key)) sessMap.set(key, s); // startTime asc → 首个=最早窗口
      }
      for (const r of pageRows) {
        const s = sessMap.get(r.id);
        if (s) {
          r.mySession = {
            race: s.race,
            start: Number(s.startTime),
            end: Number(s.endTime),
            finished: Number(s.endTime) <= now,
          };
        }
      }
    }
  }

  return {
    rows: pageRows,
    total,
    page: p,
    pageSize: size,
    totalPages,
  };
}

// ---------- 统计 ----------

export interface TourGlobalStats {
  tournaments: number; // 比赛个数（全站）
  tournamentsToday: number; // 今日新增比赛数（动态 type=1 当日写入量）
  participants: number; // 参赛人数（去重用户）
  participantsToday: number; // 今日新增参赛者（动态 type=2 当日去重人数）
  videos: number; // 录像数量（成绩采集下一期接入，恒 0）
  videosToday: number; // 今日新增录像（动态 type=4 当日合并行去重比赛——行数口径）
  prizeTotal: number; // 累计奖金（全站总奖金之和）
}

// 60s 缓存（2026-11-28 全站 502 事故收尾）：全站统计一天变不了几次，原实现每请求实时算——
// 其中「参赛人数」`video.findMany({ tournamentId: { not: null } })` 在 4.4 万行挂接录像上
// IS NOT NULL 全表扫，生产实测恒 3.4s，是 /tournaments 列表页恒定 3s+ 的底噪（此前被
// getTourMyStats 的 10-37s 盖住，后者修掉后才露出）。今日增量（绿括号）60s 内可见够用。
const fetchTourGlobalStatsCached = unstable_cache(
  async () => getTourGlobalStatsImpl(),
  ["tour-global-stats-v1"],
  { revalidate: 60 }
);
export async function getTourGlobalStats(): Promise<TourGlobalStats> {
  return fetchTourGlobalStatsCached();
}
async function getTourGlobalStatsImpl(): Promise<TourGlobalStats> {
  const dayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const [tournaments, tournamentsToday, participants, todayJoiners, prizeAgg, videos, todayVideoComps] = await Promise.all([
    prisma.tournament.count(),
    // 今日新增比赛数：动态 type=1（报名开始，发起比赛时写入一条/场）
    prisma.tournamentEvent.count({ where: { type: 1, createTime: { gte: dayStart } } }),
    // 参赛人数=实际传过比赛录像的去重用户（2026-11-21 张老师报「参赛人数怎么可能是 0」）：
    // 报名表 11-13 才上线（历届 GSC 全是 0 行），历史参赛者只存在于 video.competition_id
    // 挂接——与详情页 getTourDetailStats 的 entries 口径一致（distinct 持有者）。
    prisma.video.findMany({
      where: { tournamentId: { not: null }, status: { not: 0 } },
      select: { user: true },
      distinct: ["user"],
    }).then((rows) => rows.length),
    // 今日新增参赛者：动态 type=2（玩家报名参加）当日写入的去重用户
    prisma.tournamentEvent.findMany({
      where: { type: 2, createTime: { gte: dayStart }, userId: { not: BigInt(0) } },
      select: { userId: true },
      distinct: ["userId"],
    }).then((rows) => rows.length),
    prisma.tournament.aggregate({ _sum: { prizeTotal: true } }),
    // 挂接到比赛的录像数（2026-11-13 二期起有真实数据源：后台手动挂接）
    prisma.video.count({ where: { tournamentId: { not: null }, status: { not: 0 } } }),
    // 今日新增录像：动态 type=4（玩家更新成绩）当日合并行数（该玩家该时刻一批
    // 可能多盘——事件行数≈「有更新」次数，与首页「今日有新增才显示」的语义一致）
    prisma.tournamentEvent.count({ where: { type: 4, createTime: { gte: dayStart } } }),
  ]);
  return {
    tournaments,
    tournamentsToday,
    participants,
    participantsToday: todayJoiners,
    videos,
    videosToday: todayVideoComps,
    prizeTotal: prizeAgg._sum.prizeTotal ?? 0,
  };
}

export interface TourMyStats {
  joined: number; // 参加比赛次数（已报名数）
  /** 最高排名（2026-11-24 张老师需求：参赛记录不再恒「—」）——
   *  我报名的全部比赛中按各场排行榜同口径（getTourRanking 同源排序的 index+1）
   *  算出的最好名次。2026-11-28 起改读 tournament_rank_snapshot 落盘快照。 */
  bestRank: number | null;
  prize: number; // 累计奖金（成绩采集下一期接入）
}

/** 快照惰性重建的 TTL 兜底（秒）：写点漏 bump 时最长这么久后自愈。
 *  正常路径靠 bumpTourRankRev 即时打脏；TTL 只兜「脚本直灌库/未知旁路」的写入。 */
const TOUR_RANK_SNAPSHOT_TTL_SEC = 60;

/** 单飞表：同一场比赛的快照重建并发只跑一次（两个登录用户同时打开 /tournaments
 *  且快照恰好过期时，不重复付全量算分）。key=cid，value=进行中的 Promise。 */
const tourRankRebuilding = new Map<number, Promise<void>>();

/** 给录像 id 集合补 video_info / video_metrics（比赛算分输入）——分块 IN 查询。
 *  ⚠️ 单条 IN 的元素个数必须封顶（2026-11-28 全站 502 事故）：金羊杯单场 1.1 万盘，
 *  原实现把全部录像 id 塞进一条 `WHERE id IN (…35017 个…)`——MySQL 对超长 IN 列表
 *  放弃 PRIMARY 走全表扫描（Rows_examined 38.7 万），单条 SQL 文本数百 KB，
 *  慢日志实测单次 36.9s。分块后每条都是 PK range 点查。 */
const TOUR_IN_CHUNK = 1000;
async function tourInfosByIds(ids: bigint[]) {
  const out: { id: bigint; realTime: number; board3bv: number; noRecord: boolean }[] = [];
  for (let i = 0; i < ids.length; i += TOUR_IN_CHUNK) {
    const chunk = ids.slice(i, i + TOUR_IN_CHUNK);
    out.push(
      ...(await prisma.videoInfo.findMany({
        where: { id: { in: chunk } },
        select: { id: true, realTime: true, board3bv: true, noRecord: true },
      }))
    );
  }
  return out;
}
async function tourMetricsByIds(ids: bigint[]) {
  const out: { id: bigint; bvs: number; ioe: number; thrp: number; cp: number }[] = [];
  for (let i = 0; i < ids.length; i += TOUR_IN_CHUNK) {
    const chunk = ids.slice(i, i + TOUR_IN_CHUNK);
    out.push(
      ...(await prisma.videoMetrics.findMany({
        where: { id: { in: chunk } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      }))
    );
  }
  return out;
}

/** 比赛算分输入（getTourRanking 与排名快照共用的唯一加载口径）。
 *  录像集：FORCE INDEX(video_competition_id_create_time_idx)——优化器对大赛
 *  `competition_id IN (…)` 常判全表扫更划算（EXPLAIN type=ALL rows=387521，
 *  2026-11-28 生产实证），这里语义就是「按比赛取录像」，强制走索引。
 *  判窗口径与 getTourRanking 原实现逐行一致（集体赛不过滤；窗口赛有会话才按会话窗）。 */
interface TourScoreInputRow {
  id: bigint;
  user: bigint;
  level: string;
  createTime: bigint;
}
async function loadTourScoreInput(cid: bigint) {
  const comp = await prisma.tournament.findUnique({
    where: { id: cid },
    select: { scoreMode: true, scoreConfig: true, windowHours: true, includeLevels: true },
  });
  if (!comp) return null;
  const rows = await prisma.$queryRawUnsafe<TourScoreInputRow[]>(
    "SELECT v.id, v.user, v.level, v.create_time AS createTime FROM video v FORCE INDEX (video_competition_id_create_time_idx) WHERE v.competition_id = ? AND v.status <> 0",
    cid
  );
  // 窗口赛（windowHours>0 且存在个人会话记录）按玩家各自的会话窗口收录像。
  // ⚠️ 会话表为空的 windowHours>0 比赛（历届导入带默认值 2）按集体赛处理，
  // 否则全部录像被判窗外＝金羊杯排行榜/图表清空事故
  const sessionWindows = comp.windowHours
    ? await prisma.tournamentWindowSession.findMany({
        where: { tournamentId: cid },
        select: { userId: true, startTime: true, endTime: true },
      })
    : [];
  const sessByUser = new Map(sessionWindows.map((s) => [Number(s.userId), s]));
  const useSessWindow = !!comp.windowHours && sessionWindows.length > 0;
  const inWindow = useSessWindow
    ? rows.filter((r) => {
        const sw = sessByUser.get(Number(r.user));
        const t = Number(r.createTime);
        return !!sw && t >= Number(sw.startTime) && t <= Number(sw.endTime);
      })
    : rows;
  const ids = inWindow.map((r) => r.id);
  const metric = parseScoreConfig(comp.scoreMode, comp.scoreConfig)?.metric ?? "time";
  const needsMetrics = metric !== "time" && metric !== "3bv";
  const [infos, metricsRows] = await Promise.all([
    tourInfosByIds(ids),
    needsMetrics ? tourMetricsByIds(ids) : Promise.resolve([]),
  ]);
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const metricsMap = new Map(metricsRows.map((m) => [m.id, m]));
  /** 单盘 metric 值（score 域；无效 0）——与 getTourEventsPage.metricValueOf 同口径 */
  const metricValueOf = (vid: bigint): number => {
    if (metric === "time") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.realTime : 0;
    }
    if (metric === "3bv") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.board3bv * 1000 : 0;
    }
    const m = metricsMap.get(vid);
    if (!m) return 0;
    const raw = metric === "3bvs" ? m.bvs : metric === "ioe" ? m.ioe : metric === "thrp" ? m.thrp : m.cp;
    return raw > 0 ? raw * 1000 : 0;
  };
  return {
    comp,
    inWindow,
    infoMap,
    metricValueOf,
    tourVids: inWindow.map((r) => ({
      user: r.user,
      level: r.level,
      value: metricValueOf(r.id),
      noRecord: infoMap.get(r.id)?.noRecord ?? false,
      t: Number(r.createTime), // 同分决胜用：总分出现时刻（2026-11-27 张老师定）
    })),
  };
}

/** 比赛全体玩家排序结果（名次口径唯一来源）：总分为主，同分按总分出现先后排
 *  （先出现者排前，compareTourScores+scoreAppearTimes，2026-11-27 张老师定）。
 *  返回 [uid, score] 有序数组，名次 = index+1（不合并并列）。 */
async function rankTourPlayers(cid: bigint) {
  const input = await loadTourScoreInput(cid);
  if (!input) return null;
  const includeLv = input.comp.includeLevels.split(",").map((x) => x.trim()).filter(Boolean);
  const scores = computePlayerScores(input.comp.scoreMode, input.comp.scoreConfig, input.tourVids, includeLv);
  if (!scores.size) return [];
  const tMap = scoreAppearTimes(input.comp.scoreMode, input.comp.scoreConfig, input.tourVids, includeLv);
  return [...scores.entries()].sort((a, b) => compareTourScores(a[1], b[1], parseScoreConfig(input.comp.scoreMode, input.comp.scoreConfig)?.desc ?? false, tMap.get(a[0]), tMap.get(b[0])));
}

/** 重建一场比赛的排名快照（事务内原子）：推进 rank_rev → 删旧快照 → 插新快照，
 *  并把「快照对应的 rev + 重建时刻」记回 tournament.rank_snap_rev / rank_snap_at。
 *  过期判据只看 tournament 这两列（一次主键查询），不聚合快照表——空快照比赛
 *  （无人有有效录像）同样留下「已建过」痕迹，不会每次读都重建。 */
async function rebuildTourRankSnapshotNow(cid: bigint): Promise<void> {
  const sorted = await rankTourPlayers(cid);
  if (sorted === null) return; // 比赛已不存在
  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.$transaction(async (tx) => {
    const bumped = await tx.tournament.update({
      where: { id: cid },
      data: { rankRev: { increment: 1 } },
      select: { rankRev: true },
    });
    await tx.tournamentRankSnapshot.deleteMany({ where: { tournamentId: cid } });
    if (sorted.length) {
      await tx.tournamentRankSnapshot.createMany({
        data: sorted.map(([uid], i) => ({
          tournamentId: cid,
          userId: BigInt(uid),
          rank: i + 1,
          rev: bumped.rankRev,
          updateTime: now,
        })),
      });
    }
    await tx.tournament.update({
      where: { id: cid },
      data: { rankSnapRev: bumped.rankRev, rankSnapAt: now },
    });
  });
}

/** 惰性重建入口：tournament.rank_snap_rev 落后于 rank_rev（写点 bump 过）、或快照
 *  超过 TTL 即重建。单飞：同场并发请求共享同一次重建。 */
async function ensureTourRankSnapshot(cid: bigint): Promise<void> {
  const comp = await prisma.tournament.findUnique({
    where: { id: cid },
    select: { rankRev: true, rankSnapRev: true, rankSnapAt: true },
  });
  if (!comp) return;
  const stale =
    comp.rankSnapRev < comp.rankRev ||
    Number(comp.rankSnapAt) + TOUR_RANK_SNAPSHOT_TTL_SEC < Math.floor(Date.now() / 1000);
  if (!stale) return;
  let inflight = tourRankRebuilding.get(Number(cid));
  if (!inflight) {
    inflight = rebuildTourRankSnapshotNow(cid).finally(() => tourRankRebuilding.delete(Number(cid)));
    tourRankRebuilding.set(Number(cid), inflight);
  }
  await inflight;
}

/** 写点打脏（2026-11-28）：任一会改变某场比赛名次的写入后调用——只推进 rank_rev，
 *  不算名次（算分昂贵且写点在请求路径上）；下一个读到该场快照的请求惰性重建。
 *  失败只告警不抛：打脏失败由快照 TTL 兜底自愈，不能拖垮主业务写入。 */
export async function bumpTourRankRev(tournamentId: bigint | number): Promise<void> {
  try {
    await prisma.tournament.update({
      where: { id: BigInt(tournamentId) },
      data: { rankRev: { increment: 1 } },
    });
  } catch (e) {
    // P2025（比赛已不存在，如并发删除）是预期内，静默；其余才告警
    if ((e as { code?: string })?.code !== "P2025") {
      console.warn("[tournament] bumpTourRankRev 失败", String(tournamentId), e);
    }
  }
}

/** 「参赛记录」：参赛次数 + 最高排名。2026-11-28 起最高排名改读落盘快照——
 *  原实现每次请求拉「我报名的全部比赛」的全部录像再巨型 IN 回查（每人 1~3 条
 *  全表扫、10-37s、独占一条连接），5 连接的 Prisma 池被几名登录用户同时打开
 *  列表页即占满 → P2024 → 全站 502。现在：报名行（索引点查）→ 每场快照的
 *  rev 校验（tournament 主键一次查询）→ 快照行按 (场,uid) 唯一点查。快照过期才付一次重建，
 *  且重建走 FORCE INDEX + 分块 IN。 */
export async function getTourMyStats(uid: number): Promise<TourMyStats> {
  const entries = await prisma.tournamentEntry.findMany({
    where: { userId: BigInt(uid) },
    select: { tournamentId: true },
  });
  let bestRank: number | null = null;
  for (const cid of new Set(entries.map((e) => e.tournamentId))) {
    await ensureTourRankSnapshot(cid);
    const row = await prisma.tournamentRankSnapshot.findUnique({
      where: { tournamentId_userId: { tournamentId: cid, userId: BigInt(uid) } },
      select: { rank: true },
    });
    if (row && (bestRank === null || row.rank < bestRank)) bestRank = row.rank;
  }
  return { joined: entries.length, bestRank, prize: 0 };
}

// ---------- 动态（2026-11-13 二期：详情页「动态」板块）----------

export const TOUR_EVENT_JOIN_OPEN = 1; // 报名开始
export const TOUR_EVENT_PLAYER_JOIN = 2; // 玩家报名参加
export const TOUR_EVENT_STARTED = 3; // 比赛正式开始
export const TOUR_EVENT_SCORE = 4; // 玩家更新成绩
export const TOUR_EVENT_ENDED = 5; // 比赛正式结束
export const TOUR_EVENT_FINISHED = 6; // 玩家完赛（窗口赛个人窗口结束，2026-11-22 张老师定）

/** 比赛动态筛选（2026-11-23 张老师需求）：全部 / 完赛（只看 type=6）/ 关注（只看我关注的人的参赛动态） */
export type TourEventsFilter = "all" | "finished" | "follow";

export function parseTourEventsFilter(raw?: string | null): TourEventsFilter {
  return raw === "finished" || raw === "follow" ? raw : "all";
}

/** 动态事件文案（type → 展示文本；主体玩家名由行渲染拼接）。
    详情页 RSC 与 TourEventsFeed 客户端壳共用（2026-11-13 五轮翻页改版）。
    2026-11-19 张老师定：type=1 报名开始动态废弃（存量不再展示——渲染端过滤，
    写入点保留类型编号存档）；「正式」两字去掉（「比赛开始/比赛结束」）。 */
export function compEventText(type: number): string {
  switch (type) {
    case TOUR_EVENT_JOIN_OPEN:
      return "报名开始"; // 废弃类型：渲染端已过滤不再展示（存量数据仍在库）
    case TOUR_EVENT_PLAYER_JOIN:
      return "报名参加了比赛";
    case TOUR_EVENT_STARTED:
      return "比赛开始";
    case TOUR_EVENT_SCORE:
      return "更新了成绩";
    case TOUR_EVENT_ENDED:
      return "比赛结束";
    case TOUR_EVENT_FINISHED:
      return "已完赛";
    default:
      return "";
  }
}

/** 写一条动态（报名/挂录像走此入口；开始/结束走 ensureTourLifecycleEvents 惰性补写） */
export async function addTourEvent(
  tournamentId: number,
  type: number,
  userId = 0,
  /** 缺省=现在；存量/补报名回溯场景传业务时刻（2026-11-22 挂接补报名） */
  createTimeSec?: number
): Promise<void> {
  await prisma.tournamentEvent.create({
    data: {
      tournamentId: BigInt(tournamentId),
      type,
      userId: BigInt(userId),
      createTime: BigInt(createTimeSec ?? Math.floor(Date.now() / 1000)),
    },
  });
}

/**
 * 挂接补报名（2026-11-22 张老师定口径）：有成绩就该有报名记录。
 * · 窗口赛（windowHours>0）＝点「开始比赛」拿到个人标识时就补报名——报名动态
 *   createTime 取窗口会话 start_time（报名动作的真实时刻）；
 * · 统一计时赛（windowHours=0）＝第一个挂接成功的录像时补报名——先写报名动态
 *   再写成绩动态（报名 createTime=挂接时刻，与成绩动态同秒，排序 (createTime,id)
 *   天然保证报名行在前；个人动态 type=58 同理）。
 * 幂等：唯一索引 (competition_id,user_id) 兜底，已报名直接返回；补写动态亦只在
 * 真正新建报名行时发生（已报名者重复挂接不会刷报名动态）。
 * 三处调用：上传自动挂接 / 后台单条挂接 / 后台批量挂接。先查后插 + catch 吸收
 * P2002 并发双挂，调用方无需 try。
 */
export async function ensureTourEntry(
  tournamentId: number,
  userId: number,
  opts?: { /** 窗口赛传窗口开始时刻；统一计时赛不传=现在 */
    windowStartSec?: number;
  }
): Promise<void> {
  const entryTime = BigInt(opts?.windowStartSec ?? Math.floor(Date.now() / 1000));
  const existed = await prisma.tournamentEntry.findUnique({
    where: {
      tournamentId_userId: {
        tournamentId: BigInt(tournamentId),
        userId: BigInt(userId),
      },
    },
    select: { id: true },
  });
  if (existed) return; // 已报名：幂等返回，不刷动态
  try {
    await prisma.tournamentEntry.create({
      data: {
        tournamentId: BigInt(tournamentId),
        userId: BigInt(userId),
        createTime: entryTime,
      },
    });
  } catch {
    return; // P2002 并发双挂：另一请求已补，本请求不重复写动态
  }
  // 比赛动态 type=2「报名参加了比赛」（详情页动态板块）
  await addTourEvent(tournamentId, TOUR_EVENT_PLAYER_JOIN, userId, Number(entryTime));
  // 个人动态 type=58「报名参加了 XXX」（个人主页+关注流；reference=比赛 id）
  await publishNews({
    type: NEWS_TYPE.TOUR_JOIN,
    userId,
    reference: tournamentId,
    createTime: Number(entryTime),
  });
}

/**
 * 惰性补写「比赛正式开始 / 比赛正式结束」动态：now 越过起止时刻且该事件尚不存在时补一条。
 * 列表页与详情页渲染期各调一次（行数 ≤ 页内比赛数，两次 findFirst 走 (tournament_id,id)
 * 索引，开销可忽略）——不依赖定时器，重启/停机不漏事件。
 * 2026-11-22 张老师定：窗口赛（windowHours>0）个人窗口结束再补「玩家完赛」动态
 * （比赛侧 type=6「已完赛」+ 个人侧 type=59「已完赛！最终成绩：xxx」）——惰性补写：
 * 个人窗口 endTime < now 且该玩家尚无 type=6 事件时补。「一人一赛只能开一次」
 * （2026-11-22 防御）保证每玩家至多一个窗口=至多一条完赛动态。最终成绩=个人窗口内
 * computePlayerScores 总分口径（与排行榜/我的成绩同源）；无有效成绩只补比赛侧动态、
 * 个人动态照发但不带成绩数值。完赛动态 createTime 锚定窗口 endTime（同「比赛开始/
 * 结束」展示时刻锚定口径：事件补写时刻没有意义，业务时刻才是真相）。
 */
/** 惰性补写结果（2026-11-23 定时任务用）：started/ended=本轮新补的开始/结束事件；
 *  finishEvents=新补的比赛侧完赛事件（type=6）数；finishNews=新发的个人完赛动态
 *  （type=59）数——>0 时调用方（定时任务）可据此触发首页缓存刷新等后续动作。 */
export interface TourLifecyclePatchResult {
  started: boolean;
  ended: boolean;
  finishEvents: number;
  finishNews: number;
}

export async function ensureTourLifecycleEvents(
  c: {
    id: bigint | number | string;
    startTime: bigint | number;
    endTime: bigint | number;
    /** 完赛动态补写所需字段（调用方传全量行即可；缺省跳过完赛补写） */
    windowHours?: bigint | number | null;
    scoreMode?: string;
    scoreConfig?: string;
    includeLevels?: string;
  },
  now: number
): Promise<TourLifecyclePatchResult> {
  const cid = BigInt(c.id);
  const start = Number(c.startTime);
  const end = Number(c.endTime);
  // 补写计数（2026-11-23 定时任务用：finishNews>0 表示本轮新发了个人完赛动态）
  const result: TourLifecyclePatchResult = { started: false, ended: false, finishEvents: 0, finishNews: 0 };
  if (now >= start) {
    const hit = await prisma.tournamentEvent.findFirst({
      where: { tournamentId: cid, type: TOUR_EVENT_STARTED },
      select: { id: true },
    });
    if (!hit) {
      await addTourEvent(Number(c.id), TOUR_EVENT_STARTED);
      result.started = true;
    }
    // 统一标识自动生成（2026-11-19 张老师定：比赛开始时标识还留空则随机生成）。
    // 5 位数字+大小写字母（同后台 genUniqueTourCode 形态），唯一索引兜底重试。
    // 只在「进行中」首次发现时生成一次：已生成（code 非空）即跳过，恒定 O(1)。
    const comp = await prisma.tournament.findUnique({
      where: { id: cid },
      select: { code: true },
    });
    if (comp && !comp.code) {
      const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
      for (let attempt = 0; attempt < 5; attempt++) {
        let code = "";
        for (let i = 0; i < 5; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
        try {
          await prisma.tournament.update({ where: { id: cid }, data: { code } });
          break;
        } catch {
          // P2002 唯一冲突 → 重抽
        }
      }
    }
  }
  if (now >= end) {
    const hit = await prisma.tournamentEvent.findFirst({
      where: { tournamentId: cid, type: TOUR_EVENT_ENDED },
      select: { id: true },
    });
    if (!hit) {
      await addTourEvent(Number(c.id), TOUR_EVENT_ENDED);
      result.ended = true;
    }
  }
  // 窗口赛完赛动态补写（2026-11-22 张老师定，惰性）：全部已过期且尚无 type=6 的
  // 个人会话一次循环补齐。⚠️ 分支条件只看 windowHours>0——个人窗口结束通常早于
  // 比赛整场结束（本地验证实证：比赛 11-27 才结束，玩家窗口今天凌晨已完），
  // 若叠加 now>=end 会把完赛动态憋到比赛结束才发；已过期会话查询本身就筛掉了
  // 进行中的窗口。行数=参赛窗口数（十量级），每轮两条 INSERT 可忽略。
  // ⚠️ 计分口径（scoreMode/scoreConfig/includeLevels）绝不信任调用方传参——
  // 列表页调用不带这些字段（生产实证：先访问列表页触发的补写全部 details={}，
  // metric 回退 time 算不出 crossings 总分），缺哪个字段此处自查库兜底。
  if (Number(c.windowHours ?? 0) > 0) {
    const needScoreMeta = !c.scoreMode || !c.scoreConfig || !c.includeLevels;
    const compMeta = needScoreMeta
      ? await prisma.tournament.findUnique({
          where: { id: cid },
          select: { scoreMode: true, scoreConfig: true, includeLevels: true },
        })
      : null;
    const scoreMeta = {
      scoreMode: c.scoreMode || compMeta?.scoreMode,
      scoreConfig: c.scoreConfig || compMeta?.scoreConfig,
      includeLevels: c.includeLevels || compMeta?.includeLevels,
    };
    const sessions = await prisma.tournamentWindowSession.findMany({
      where: { tournamentId: cid, endTime: { lt: BigInt(now) } },
      select: { id: true, userId: true, startTime: true, endTime: true },
      orderBy: { id: "asc" },
    });
    const doneSet = new Set(
      (
        await prisma.tournamentEvent.findMany({
          where: { tournamentId: cid, type: TOUR_EVENT_FINISHED },
          select: { userId: true },
        })
      ).map((e) => e.userId.toString()),
    );
    for (const s of sessions) {
      if (doneSet.has(s.userId.toString())) continue;
      // 个人窗口内录像按比赛口径算总分（排行榜同源；窗口过滤与 getTourRanking 一致）
      const vids = await prisma.video.findMany({
        where: {
          tournamentId: cid,
          user: s.userId,
          status: { not: 0 },
          createTime: { gte: s.startTime, lte: s.endTime },
        },
        select: { id: true, user: true, level: true, createTime: true },
      });
      const win = vids.length ? await computeWindowScore(cid, s.userId, vids, scoreMeta) : null;
      await addTourEvent(Number(c.id), TOUR_EVENT_FINISHED, Number(s.userId), Number(s.endTime));
      result.finishEvents += 1;
      // 完赛动态落库（2026-11-22 首页口径改造）：
      // · 有成绩（含保底补足的总分）→ details={score, floorOnly}——floorOnly=true 表示
      //   总分全是保底凑的（实盘 0 局），渲染照常带成绩但首页新闻流按此标记过滤；
      // · 无成绩（win=null 或 score=null，杨鼎判例：窗口内一盘有效录像都没有）
      //   → 个人动态不再发（比赛侧 type=6 事件照写）——此前发 details={} 的
      //   「已完赛{简称}！」空行没有信息量，个人页/关注流也不需要它。
      //   存量 details={} 行由 scripts/backfill-finish-flooronly.py 回填标记/删除。
      if (win?.score !== null && win?.score !== undefined) {
        await publishNews({
          type: NEWS_TYPE.TOUR_FINISH,
          userId: Number(s.userId),
          reference: Number(c.id),
          createTime: Number(s.endTime),
          details: { score: win.score, floorOnly: win.floorOnly },
        });
        result.finishNews += 1;
      }
    }
  }
  return result;
}

/** 窗口赛个人总分（完赛动态用）：与 getTourRanking / getTourMyResult 完全同口径——
 *  比赛收录级别闸门 + computePlayerScores（score 域：time=毫秒，其余 ×1000）。
 *  无有效成绩 score=null。calc=计算过程明细（2026-11-22 动态成绩气泡用；
 *  同一次 computePlayerScores 本就产出，一起返回零额外成本）。 */
async function computeWindowScore(
  cid: bigint,
  uid: bigint,
  vids: { id: bigint; level: string }[],
  c: { scoreMode?: string; scoreConfig?: string; includeLevels?: string }
): Promise<{ score: number | null; calc: PlayerScore["calc"] | null; floorOnly: boolean }> {
  const metric = parseScoreConfig(c.scoreMode ?? "", c.scoreConfig ?? "")?.metric ?? "time";
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: vids.map((v) => v.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const needsMetrics = metric !== "time" && metric !== "3bv";
  const metricsRows = needsMetrics
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: vids.map((v) => v.id) } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      })
    : [];
  const metricsMap = new Map(metricsRows.map((m) => [m.id, m]));
  const valueOf = (vid: bigint): number => {
    if (metric === "time") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.realTime : 0;
    }
    if (metric === "3bv") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.board3bv * 1000 : 0;
    }
    const m = metricsMap.get(vid);
    if (!m) return 0;
    const raw = metric === "3bvs" ? m.bvs : metric === "ioe" ? m.ioe : metric === "thrp" ? m.thrp : m.cp;
    return raw > 0 ? raw * 1000 : 0;
  };
  const scores = computePlayerScores(
    c.scoreMode ?? "",
    c.scoreConfig ?? "",
    vids.map((v) => ({
      user: uid,
      level: v.level,
      value: valueOf(v.id),
      noRecord: infoMap.get(v.id)?.noRecord ?? false,
    })),
    (c.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const mine = scores.get(Number(uid));
  // 纯保底判定（2026-11-22 张老师定：完赛动态全是保底凑的分不进首页新闻流）：
  // sum_topn 下所有收录级别的实盘局数 real=0（一盘有效录像都没有，总分全靠保底凑）；
  // target_diff 无保底语义恒 false；无成绩（mine 缺失）按 false（无成绩走 score=null 口径）
  const floorOnly = mine
    ? mine.calc.length > 0 && mine.calc.every((c) => c.real === 0 && c.fill > 0)
    : false;
  return { score: mine?.score ?? null, calc: mine?.calc.length ? mine.calc : null, floorOnly };
}

export interface TourEventRow {
  id: number;
  type: number;
  userName: string | null; // 全站事件（1/3/5）为 null
  userId: number | null;
  createTime: number;
  /** 事件主体玩家展示信息（type=2/4 有；性别标志+军衔，2026-11-18 晚张老师定同首页动态） */
  sex: number;
  englishName: string;
  title: string;
  classic: { name: string; color: string } | null;
  /** type=4 合并行：该玩家本比赛全部成绩动态合并后的盘数 */
  count: number;
  /** type=4 合并行：该玩家当时（≤本批时刻）的比赛总成绩（computePlayerScores 同口径 score 域：time=毫秒，其余=落库×1000） */
  totalMs: number | null;
  /** type=4 合并行：本批新盘中最好单盘成绩（score 域） */
  batchBestMs: number | null;
  /** type=4 合并行：上一行总成绩（提升方向按比赛 metric/desc 解释；null=首次成绩动态） */
  prevTotalMs: number | null;
  /** 计算过程明细（2026-11-22 张老师需求：动态成绩数字 hover 出计算过程气泡，
   *  与排行榜前10同款）——type=4/6 行带（computePlayerScores.calc 原样透传，
   *  本来就算出只是此前丢弃，服务端零新增计算）；null=不挂气泡 */
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[] | null;
  /** type=6 完赛行：窗口到点但没有任何有效录像=弃赛（2026-11-23 张老师定：
   *  动态显示暗灰「已弃赛」而非金色「已完赛」）；其余类型恒 false */
  abandoned: boolean;
}

/** 比赛动态分页（2026-11-18 深夜张老师四轮定版）：
 *  · 新在上老在下
 *  · type=4 按玩家合并成一行（整段比赛的所有成绩动态并成一条，截图里 20 行全是
 *    同一人批量传盘的碎片）——行显示：本批（相邻 60 秒窗口）盘数 ×N、本批最好单盘、
 *    **当时比赛总成绩**（computePlayerScores 同口径，各级别最好 N 局+保底），非首行
 *    再带提升幅度（金色 ▼差值，同首页新闻破纪录）
 *  · 带出玩家性别/军衔（同首页动态行）
 *  total 口径：合并后的行数 */
export async function getTourEventsPage(
  tournamentId: number,
  page: number,
  pageSize = 20,
  /** 2026-11-23 张老师需求：动态筛选；viewerId 仅 follow 用，服务端从 session 取。
   *  2026-11-26 张老师需求：userId=按玩家搜索（URL eauthor），查询层限定该玩家的动态 */
  options: { filter?: TourEventsFilter; viewerId?: number; userId?: number } = {}
): Promise<{ rows: TourEventRow[]; total: number; page: number; pageSize: number }> {
  const cid = BigInt(tournamentId);
  const filter = options.filter ?? "all";
  // 关注筛选：先取我关注的人（未登录/无关注即空集，查询直接返回空，不回退全部）。
  let followeeIds: number[] = [];
  if (filter === "follow" && options.viewerId) {
    const fs = await prisma.userFollow.findMany({
      where: { follower: BigInt(options.viewerId) },
      select: { followee: true },
    });
    followeeIds = fs.map((r) => Number(r.followee));
  }
  // 筛选在查询层生效（不是切片后再前端过滤）：total / 分页都按筛选后的结果算，
  // 完赛只看 type=6；关注只看关注对象的参赛动态（官方事件主体 user_id=0 自然排除）；
  // 按玩家搜索限定 user_id=该玩家（官方事件天然排除）。
  const eventWhere: {
    tournamentId: bigint;
    type: number | { not: number };
    userId?: { in: bigint[] };
  } = filter === "finished"
    ? { tournamentId: cid, type: TOUR_EVENT_FINISHED }
    : { tournamentId: cid, type: { not: TOUR_EVENT_JOIN_OPEN } };
  if (filter === "follow") eventWhere.userId = { in: followeeIds.map((uid) => BigInt(uid)) };
  // 玩家搜索与「关注」是 AND 关系（搜索的人不在关注列表即空结果，不静默退回全部）；
  // 无关注筛选时直接限定单个 uid。
  if (options.userId && options.userId > 0) {
    const uid = BigInt(options.userId);
    eventWhere.userId = {
      in: eventWhere.userId ? eventWhere.userId.in.filter((x) => x === uid) : [uid],
    };
  }
  // 全量取出本比赛动态（比赛量级十场、单场动态几千条，内存归并最直白；
  // 跨批合并/总成绩进度都无法在 SQL 一层表达）。
  // 2026-11-19 张老师定：type=1 报名开始动态废弃——查询层直接排除（每场一条无信息量）
  const all = await prisma.tournamentEvent.findMany({
    where: eventWhere,
    orderBy: [{ createTime: "asc" }, { id: "asc" }],
  });
  const scoreEv = all.filter((e) => e.type === TOUR_EVENT_SCORE);
  const uids = [...new Set(scoreEv.map((e) => Number(e.userId)).filter((x) => x > 0))];
  // 一次取全部成绩动态玩家的录像（总成绩进度计算的数据源）。
  // 2026-11-21 张老师反馈（niu1）：动态总成绩必须与排行榜**完全同口径**——
  // 集体赛不做上传时间过滤（管理员挂接即视为参赛成绩，窗外补挂的历史盘同样有效）；
  // 窗口赛以个人会话窗口为准（upload route 挂接时已按会话窗校验）。
  // 计分层用比赛收录级别闸门（computePlayerScores includeLevels）兜底，
  // 未收录级别的录像自然不进总分
  const compRow = await prisma.tournament.findUnique({
    where: { id: cid },
    select: {
      scoreMode: true,
      scoreConfig: true,
      windowHours: true,
      startTime: true,
      endTime: true,
      includeLevels: true,
    },
  });
  // 窗口赛判定（2026-11-21 二次修正）：windowHours>0 **且存在个人会话记录**才按
  // 会话窗过滤——历届导入的旧比赛 window_hours 带着历史默认值 2，但会话表恒空，
  // 按会话窗过滤会把全部录像判窗外＝排行榜/图表/动态全空（金羊杯事故）。
  const sessWhere = compRow?.windowHours
    ? await prisma.tournamentWindowSession.findMany({
        where: { tournamentId: cid },
        select: { userId: true, startTime: true, endTime: true },
      })
    : [];
  const sessByUser = new Map(sessWhere.map((s) => [Number(s.userId), s]));
  const useSessWindow = !!compRow?.windowHours && sessWhere.length > 0;
  const vids = uids.length
    ? await prisma.video.findMany({
        where: {
          tournamentId: cid,
          status: { not: 0 },
          user: { in: uids.map((s) => BigInt(s)) },
        },
        select: { id: true, user: true, level: true, createTime: true },
      })
    : [];
  const vidsInWindow = useSessWindow
    ? vids.filter((v) => {
        const s = sessByUser.get(Number(v.user));
        const t = Number(v.createTime);
        return !!s && t >= Number(s.startTime) && t <= Number(s.endTime);
      })
    : vids;
  const comp = compRow;
  // 计分数据项取值（2026-11-21 多数据项改造）：先解析出 metric，再按项取数——
  // time → video_info.real_time；3bv → video_info.board_3bv；
  // 3bvs/ioe/thrp/crossings → video_metrics.bvs/ioe/thrp/cp（缺失行 value=0 计分时自动跳过）
  const tourConf = parseScoreConfig(comp?.scoreMode ?? "", comp?.scoreConfig ?? "");
  const metric = tourConf?.metric ?? "time";
  const infos = vids.length
    ? await prisma.videoInfo.findMany({
        where: { id: { in: vids.map((v) => v.id) } },
        select: { id: true, realTime: true, board3bv: true, noRecord: true },
      })
    : [];
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const needsMetrics = metric !== "time" && metric !== "3bv";
  const metricsRows = vids.length
    ? await (needsMetrics
        ? prisma.videoMetrics.findMany({
            where: { id: { in: vids.map((v) => v.id) } },
            select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
          })
        : Promise.resolve([] as { id: bigint; bvs: number; ioe: number; thrp: number; cp: number }[]))
    : [];
  const metricsMap = new Map(metricsRows.map((m) => [m.id, m]));
  /** 单盘在该比赛 metric 上的 score 域值（time=毫秒原值，其余 ×1000；无效 0） */
  const metricValueOf = (vid: bigint): number => {
    if (metric === "time") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.realTime : 0;
    }
    if (metric === "3bv") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.board3bv * 1000 : 0;
    }
    const m = metricsMap.get(vid);
    if (!m) return 0;
    const raw = metric === "3bvs" ? m.bvs : metric === "ioe" ? m.ioe : metric === "thrp" ? m.thrp : m.cp;
    return raw > 0 ? raw * 1000 : 0;
  };
  // 按玩家归并：每条成绩动态 → 该玩家截至该时刻的录像集（窗口赛按个人会话窗过滤）
  const vidsByUser = new Map<number, typeof vidsInWindow>();
  for (const v of vidsInWindow) {
    const uid = Number(v.user);
    if (!vidsByUser.has(uid)) vidsByUser.set(uid, []);
    vidsByUser.get(uid)!.push(v);
  }
  // 成绩动态合并：同人相邻事件间隔 ≤ 600 秒视为同一批（连传）；批内取最新时刻为行时刻
  const BATCH_WINDOW_SEC = 600;
  type Merged = {
    userId: number;
    /** 行时刻 = 批内新盘最大上传时刻（无新盘回退批末事件时刻） */
    createTime: number;
    /** 批内事件数（动态条数） */
    evCount: number;
    /** 批内新盘 id 集（时刻落在 (批首事件−窗口, 批末事件] 的录像） */
    batchVideoIds: number[];
    /** 批首事件时刻（总成绩进度取「批末事件时刻」口径） */
    firstTime: number;
    /** 批末事件时刻 */
    lastTime: number;
    /** 行展示时刻 = 批内新盘最大上传时间（张老师 2026-11-21 定） */
    rowTime: number;
    minId: number;
  };
  const merged: Merged[] = [];
  {
    let cur: Merged | null = null;
    for (const e of scoreEv) {
      const uid = Number(e.userId);
      const t = Number(e.createTime);
      if (cur && cur.userId === uid && t - cur.lastTime <= BATCH_WINDOW_SEC) {
        cur.lastTime = t;
        cur.createTime = t;
        cur.evCount += 1;
      } else {
        if (cur) merged.push(cur);
        cur = { userId: uid, createTime: t, evCount: 1, batchVideoIds: [], firstTime: t, lastTime: t, rowTime: t, minId: Number(e.id) };
      }
    }
    if (cur) merged.push(cur);
  }
  // 批内新盘（2026-11-21 张老师二次反馈改口径）：**截至本批事件时刻**该玩家的
  // 全部录像中，总成绩进度**尚未计入**的盘（=本批新纳入的盘），行展示时刻=这批
  // 新盘的最大上传时间——批量补挂时挂接事件时刻远晚于录像上传时刻（600 秒
  // 连传窗口罩不住），按「进度差集」取盘才能把新盘找全；无新盘回退批末事件时刻。
  {
    const countedBy = new Map<number, Set<number>>(); // uid → 已计入总成绩的盘 id 集
    for (const m of merged) {
      const seen = countedBy.get(m.userId) ?? new Set<number>();
      const pool = vidsByUser.get(m.userId) ?? [];
      const upto = pool.filter((v) => Number(v.createTime) <= m.lastTime);
      m.batchVideoIds = upto.filter((v) => !seen.has(Number(v.id))).map((v) => Number(v.id));
      for (const v of m.batchVideoIds) seen.add(v);
      countedBy.set(m.userId, seen);
      m.minId = Math.min(m.minId, ...m.batchVideoIds.slice(0, 1), m.minId);
      m.rowTime = m.batchVideoIds.length
        ? Math.max(...pool.filter((v) => m.batchVideoIds.includes(Number(v.id))).map((v) => Number(v.createTime)))
        : m.lastTime;
    }
  }
  // 总成绩进度：截至每批 lastTime 的录像按比赛设定算总分（含收录级别闸门）
  const tourLevels = (compRow?.includeLevels ?? "beg,int,exp")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const progressBy = new Map<string, { total: number | null; batchBest: number | null; calc: PlayerScore["calc"] | null }>();
  for (const m of merged) {
    const pool = vidsByUser.get(m.userId) ?? [];
    const upto = pool.filter((v) => Number(v.createTime) <= m.lastTime);
    const scores = computePlayerScores(
      comp?.scoreMode ?? "",
      comp?.scoreConfig ?? "",
      upto.map((v) => ({
        user: v.user,
        level: v.level,
        value: metricValueOf(v.id),
        noRecord: infoMap.get(v.id)?.noRecord ?? false,
      })),
      tourLevels,
    );
    const mine = scores.get(m.userId);
    // 批内最好单盘（按 metric/方向）：desc=true 取最大，否则取最小；无效行 0 跳过
    const batchVals = m.batchVideoIds.map((vid) => metricValueOf(vid as unknown as bigint)).filter((t) => t > 0);
    progressBy.set(`${m.userId}@${m.lastTime}`, {
      total: mine ? mine.score : null,
      batchBest: batchVals.length ? (tourConf?.desc ? Math.max(...batchVals) : Math.min(...batchVals)) : null,
      calc: mine ? mine.calc : null,
    });
  }
  // 官方/报名事件行也并入时间线（与合并后的成绩行一起排序）。
  // 2026-11-21 张老师定（niu1 反馈）：「比赛开始/比赛结束」动态的展示时刻必须
  // **严格等于比赛起止时间**——事件行写入时刻（首次页面访问晚于实际起止）没有意义，
  // 展示层直接锚定 tournament.start_time / end_time（补写逻辑不动，只改展示锚点）
  const otherRows = all
    .filter((e) => e.type !== TOUR_EVENT_SCORE)
    .map((e) => ({
      userId: Number(e.userId),
      createTime: Number(e.createTime),
      evCount: 1,
      type: e.type,
      minId: Number(e.id),
    }));
  const type3At = compRow ? Number(compRow.startTime) : 0;
  const type5At = compRow ? Number(compRow.endTime) : 0;
  // type=6 完赛行的最终成绩：按该玩家参赛录像现算（computeWindowScore 同排行榜口径）。
  // 窗口赛的 wv 已按个人会话窗过滤；统一计时赛（历届金羊杯，无会话记录）wv 即全部
  // 挂接录像——两种赛制都能直接算分。2026-11-24 修复：此前以「有个人会话」为算分
  // 前提，金羊杯等统一计时赛 s=null 被直接判 null，完赛动态只剩「已完赛」无成绩。
  // 会话表一次带出按 uid 索引；仅完赛行触发逐人计算（十量级，可忽略）
  const finishSessions = compRow?.windowHours
    ? await prisma.tournamentWindowSession.findMany({
        where: { tournamentId: cid },
        select: { userId: true, startTime: true, endTime: true },
      })
    : [];
  const finishSessByUser = new Map(finishSessions.map((s) => [Number(s.userId), s]));
  // 完赛行成绩+计算过程（2026-11-22 动态气泡）：一次 computeWindowScore 同时拿两样，
  // 按 uid 缓存避免同玩家多行重复查询
  const finishWinCache = new Map<
    number,
    { score: number | null; calc: PlayerScore["calc"] | null; abandoned: boolean }
  >();
  const finishWinFor = async (
    uid: number
  ): Promise<{ score: number | null; calc: PlayerScore["calc"] | null; abandoned: boolean }> => {
    if (finishWinCache.has(uid)) return finishWinCache.get(uid)!;
    const s = finishSessByUser.get(uid);
    const wv = await prisma.video.findMany({
      where: {
        tournamentId: cid,
        user: BigInt(uid),
        status: { not: 0 },
        // 窗口赛按个人会话窗；统一计时赛（历届金羊杯等无会话表）按本比赛全部挂接录像
        // ——弃赛判据只看「有没有参赛录像」，与是否有成绩（保底补足）无关
        createTime: s ? { gte: s.startTime, lte: s.endTime } : undefined,
      },
      select: { id: true, level: true },
    });
    const win = wv.length
      ? await computeWindowScore(
          cid,
          BigInt(uid),
          wv,
          { scoreMode: compRow?.scoreMode, scoreConfig: compRow?.scoreConfig, includeLevels: compRow?.includeLevels },
        )
      : { score: null, calc: null };
    const out = { score: win.score, calc: win.calc, abandoned: wv.length === 0 };
    finishWinCache.set(uid, out);
    return out;
  };
  type Row = {
    sortKey: number;
    type: number;
    userId: number;
    createTime: number;
    evCount: number;
    minId: number;
    total: number | null;
    batchBest: number | null;
    prevTotal: number | null;
    calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[] | null;
    abandoned: boolean;
  };
  const rows: Row[] = [];
  // 成绩合并行 + 提升幅度（与该玩家上一批的总成绩比）
  // 2026-11-19 张老师定：成绩持平不发动态（新盘没进各级别最好 N 局=总分不变，无信息量）；
  // 2026-11-22 张老师定（crossings1 张一零判例「不应该吞动态」）：成绩**下降也发**——
  // 只有总分与上一批持平或本批无有效成绩才吞行；下降行 prevTotal 带旧总分，
  // 前端按 metric 方向渲染反向灰箭头（.delta.worse）
  const lastTotalBy = new Map<number, number | null>();
  for (const m of merged) {
    const key = `${m.userId}@${m.lastTime}`;
    const prog = progressBy.get(key)!;
    const prev = lastTotalBy.get(m.userId);
    const firstEver = prev === undefined;
    const changed =
      prog.total !== null &&
      (firstEver || prev === null || prog.total !== prev);
    if (!changed) {
      // 总分持平/本批无有效成绩 → 不发动态行；仍要维护 lastTotal 口径
      if (!firstEver) lastTotalBy.set(m.userId, prog.total ?? prev ?? null);
      else lastTotalBy.set(m.userId, prog.total);
      continue;
    }
    rows.push({
      sortKey: m.rowTime,
      type: TOUR_EVENT_SCORE,
      userId: m.userId,
      createTime: m.rowTime,
      evCount: m.evCount,
      minId: m.minId,
      total: prog.total,
      batchBest: prog.batchBest,
      prevTotal: prev === undefined ? null : prev,
      calc: prog.calc,
      abandoned: false,
    });
    lastTotalBy.set(m.userId, prog.total);
  }
  for (const o of otherRows) {
    // type=6 完赛行一次算出三样（最终成绩/气泡明细/是否弃赛），避免重复查询
    const fw = o.type === TOUR_EVENT_FINISHED ? await finishWinFor(o.userId) : null;
    rows.push({
      sortKey: o.type === TOUR_EVENT_STARTED ? type3At : o.type === TOUR_EVENT_ENDED ? type5At : o.createTime,
      type: o.type,
      userId: o.userId,
      createTime: o.type === TOUR_EVENT_STARTED ? type3At : o.type === TOUR_EVENT_ENDED ? type5At : o.createTime,
      evCount: o.evCount,
      minId: o.minId,
      // type=6 完赛事件带最终成绩（窗口总分，补写时按会话窗口现算落 details？
      // ——不落库，此处按「该玩家截至窗口结束」总分现算：与成绩进度同池不同窗，
      // 完赛动态成绩=个人窗口内总分（排行榜同源），见 computeWindowScore 同口径
      total: fw?.score ?? null,
      batchBest: null,
      prevTotal: null,
      // 完赛行也挂计算过程气泡（2026-11-22 张老师需求「包括最终成绩数字」）：
      // computeWindowScore 内部本就产出 calc，同次计算透传（无成绩/未参赛=null 不挂）
      calc: fw?.calc ?? null,
      abandoned: fw?.abandoned ?? false,
    });
  }
  rows.sort((a, b) => {
    // 「比赛结束」钉死最顶（2026-11-22 张老师定）：补挂场景成绩上传时刻晚于比赛
    // 结束时刻，纯 sortKey 排序会把结束动态压到成绩行下面（niu1 判例）。
    // 「比赛开始」不钉死（2026-11-22 二次反馈 crossings1 判例）：开赛动态锚定
    // tournament.start_time 参与纯时间倒序——刚开赛时它是最新事件，钉底会错压到
    // 更早的报名动态下面；开赛后成绩行时刻均晚于开赛时刻，自然沉到成绩行之下。
    const aEnded = a.type === TOUR_EVENT_ENDED ? 1 : 0;
    const bEnded = b.type === TOUR_EVENT_ENDED ? 1 : 0;
    if (aEnded !== bEnded) return bEnded - aEnded;
    return b.sortKey - a.sortKey || b.minId - a.minId;
  });
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(page, 1), totalPages);
  const pageRows = rows.slice((p - 1) * pageSize, p * pageSize);
  const rowUids = [...new Set(pageRows.map((r) => r.userId).filter((x) => x > 0))];
  const [users, scoreRows] = rowUids.length
    ? await Promise.all([
        prisma.user.findMany({
          where: { id: { in: rowUids.map((s) => BigInt(s)) } },
          select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
        }),
        prisma.userScores.findMany({
          where: { id: { in: rowUids.map((s) => BigInt(s)) } },
          select: { id: true, expTime: true },
        }),
      ])
    : [[], []];
  const userMap = new Map(users.map((u) => [Number(u.id), u]));
  const expMap = new Map(scoreRows.map((s) => [s.id.toString(), s.expTime ?? 0]));
  const titlePairs = users.length
    ? await dualTitles(
        users.map((u) => ({
          userId: Number(u.id),
          expTime: expMap.get(u.id.toString()) ?? 0,
          ranked: u.status === 0,
          sex: u.sex,
        })),
      )
    : [];
  const titleMap = new Map(users.map((u, i) => [Number(u.id), titlePairs[i]]));
  return {
    rows: pageRows.map((r) => {
      const u = r.userId > 0 ? userMap.get(r.userId) : undefined;
      const pair = r.userId > 0 ? titleMap.get(r.userId) : undefined;
      return {
        id: r.minId,
        type: r.type,
        userName: r.userId > 0 ? u?.chineseName ?? `UID ${r.userId}` : null,
        userId: r.userId > 0 ? r.userId : null,
        createTime: r.createTime,
        sex: u?.sex ?? 1,
        englishName: u?.englishName ?? "",
        title: pair?.m ?? "",
        classic: pair?.c ?? null,
        count: r.evCount,
        totalMs: r.total,
        batchBestMs: r.batchBest,
        prevTotalMs: r.prevTotal,
        calc: r.calc,
        abandoned: r.abandoned,
      };
    }),
    total,
    page: p,
    pageSize,
  };
}

// ---------- 参赛录像与排名（2026-11-21 起成绩＝比赛配置 metric 的 score 域值，
//            管理员后台挂接；旧口径成绩＝video_info.real_time）----------

export interface TourRankRow {
  rank: number;
  uid: number;
  name: string;
  englishName: string;
  sex: number;
  /** 军衔制称号（TitleBadge 主渲染） */
  title: string;
  /** 旧版称号备选（观看者偏好旧体系时 TitleBadge 渲染此套） */
  classic: { name: string; color: string } | null;
  /** 玩家总成绩（score 域：time=毫秒，其余=落库×1000）：
   *  sum_topn=各级别最好N局加总+保底补足；target_diff=最小误差 */
  time: number;
  /** 代表盘录像 ID（总成绩对应不了单盘时＝该玩家最好一局，供链接跳详情） */
  videoId: number;
  /** sum_topn 各级别补保底局数（前端展示「含保底 x 局」） */
  filled: Record<string, number>;
  /** 计算过程明细（2026-11-18 晚张老师定：hover 成绩出气泡展示，各级别分色；
   *  sum_topn 每级别一条 real+fill，target_diff 为 null） */
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[] | null;
}

/** 列表页图表单场数据（2026-11-27 张老师定「列表页改 TOP30」）：散点取前 30 名 +
 *  最好成绩行（=第一名，总分口径）。与详情页 getTournamentDetail 全量口径分开——
 *  getTourRanking 的 limit 只裁最终名次行，四表全量扫描（金羊杯 21 届 1.1 万盘级
 *  巨型 IN 回查，单条 SQL 295KB/返回 3 万行）发生在函数内部，靠 limit 治不了根；
 *  真正的降载靠下方 unstable_cache：每场 300s 只付一次全量算分，翻页/加载更多命中缓存 */
export interface TourListChartData {
  /** 图表散点（rank 1..30，score 秒） */
  points: TourRow["chartPoints"];
  /** 最好成绩行（第一名；无成绩 null）——at 恒 0（列表形态不查「创造于」） */
  best: TourRow["bestLine"];
}

export async function getTourListChart(compId: number): Promise<TourListChartData> {
  const list = await getTourRanking(compId, 30);
  const first = list[0];
  return {
    points: list.map((x) => ({
      rank: x.rank,
      score: x.time / 1000,
      name: x.name,
      uid: x.uid,
      englishName: x.englishName,
      sex: x.sex,
      title: x.title,
      classic: x.classic,
    })),
    best: first
      ? {
          score: first.time,
          name: first.name,
          englishName: first.englishName,
          sex: first.sex,
          title: first.title,
          uid: first.uid,
          at: 0, // 列表形态不查「创造于」精确时刻（多一次查询单场比赛），渲染端 at=0 时不显示时刻段
        }
      : null,
  };
}

/** 300s 缓存包装（键=compId）：比赛页列表每行一张图表，翻页/加载更多/多人访问
 *  命中同一键——金羊杯四场合计每次渲染 3-5 个巨型 IN 降至 300s 一次。
 *  60→300（2026-11-28 张老师定）：11-27 巡检实证残余巨型 IN 仍 ~5 条/时（60s 缓存
 *  重建本底），赛期首屏多 4 分钟延迟可接受。口径未变（纯 TTL），键前缀维持 v2。
 *  v2 键前缀：改口径（如 TOP30→TOP50）必须升版本换键 */
const fetchTourListChartCached = (compId: number) => {
  const cached = unstable_cache(
    async (cid: number) => getTourListChart(cid),
    ["tour-list-chart-v2", String(compId)],
    { revalidate: 300 }
  );
  return cached(compId);
};

/** 排行榜（张老师 2026-11-18 定：按比赛设定计算成绩排序，不再按单盘最好成绩）——
 *  sum_topn：窗口内录像按 computePlayerScores 同口径算总分（不足 N 局补保底），
 *  videoId 取该玩家窗口内最好一局（按 metric/方向取「最好」）；target_diff 同口径取最小误差。
 *  排序：总分为主，desc=true 越大越好（总分降序），否则升序；同分按总分出现
 *  先后排（先出现者排前，compareTourScores+scoreAppearTimes，2026-11-27 张老师定）。 */
/** limit=null 表示不截断（图表用全部有成绩参赛者）；数字仍按名次取前 N（右栏排行榜用 10）。 */
export async function getTourRanking(compId: number, limit: number | null = 10): Promise<TourRankRow[]> {
  const cid = BigInt(compId);
  const input = await loadTourScoreInput(cid);
  if (!input) return [];
  const conf = parseScoreConfig(input.comp.scoreMode, input.comp.scoreConfig);
  const desc = conf?.desc ?? false;
  const includeLv = input.comp.includeLevels.split(",").map((x) => x.trim()).filter(Boolean);
  const scores = computePlayerScores(input.comp.scoreMode, input.comp.scoreConfig, input.tourVids, includeLv);
  if (!scores.size) return [];
  // 总分出现时刻（同分决胜：总分相同按出现先后排，先出现者排前）
  const tMap = scoreAppearTimes(input.comp.scoreMode, input.comp.scoreConfig, input.tourVids, includeLv);
  // 代表盘 = 该玩家窗口内最好一局（按 metric/方向；总成绩是多盘合成，链接供看最好盘）
  const bestBy = new Map<number, { time: number; videoId: number }>();
  for (const r of input.inWindow) {
    const v = input.metricValueOf(r.id);
    if (!v) continue;
    const uid = Number(r.user);
    const prev = bestBy.get(uid);
    if (!prev || (desc ? v > prev.time : v < prev.time)) bestBy.set(uid, { time: v, videoId: Number(r.id) });
  }
  // 排序：总分为主，同分按总分出现先后排（先出现者排前，2026-11-27 张老师定）
  const sorted = [...scores.entries()].sort((a, b) => compareTourScores(a[1], b[1], desc, tMap.get(a[0]), tMap.get(b[0])));
  const ranked = limit === null ? sorted : sorted.slice(0, limit);
  const uids = ranked.map(([uid]) => BigInt(uid));
  const [users, scoreRows] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: uids } },
      select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
    }),
    prisma.userScores.findMany({
      where: { id: { in: uids } },
      select: { id: true, expTime: true },
    }),
  ]);
  const userMap = new Map(users.map((u) => [Number(u.id), u]));
  const expMap = new Map(scoreRows.map((s) => [s.id.toString(), s.expTime ?? 0]));
  // 双体系称号一次评定（行序与 users 对齐；ranked=当前在榜）
  const titlePairs = users.length
    ? await dualTitles(
        users.map((u) => ({
          userId: Number(u.id),
          expTime: expMap.get(u.id.toString()) ?? 0,
          ranked: u.status === 0,
          sex: u.sex,
        })),
      )
    : [];
  const titleMap = new Map(users.map((u, i) => [Number(u.id), titlePairs[i]]));
  return ranked.map(([uid, s], i) => ({
    rank: i + 1,
    uid,
    name: userMap.get(uid)?.chineseName ?? `UID ${uid}`,
    englishName: userMap.get(uid)?.englishName ?? "",
    sex: userMap.get(uid)?.sex ?? 1,
    title: titleMap.get(uid)?.m ?? "",
    classic: titleMap.get(uid)?.c ?? null,
    time: s.score,
    videoId: bestBy.get(uid)?.videoId ?? 0,
    filled: s.filled,
    calc: s.calc,
  }));
}

// ---------- 自动绑定（张老师 2026-11-18：上传/开源网导入按标识自动挂比赛）----------
//
// 严格时间窗口口径（张老师 2026-11-18 晚定）：race 命中与签名末尾命中都要求
// 上传时间在比赛窗口内——时间过后玩家会忘了改标识。命中多场取 id 最小（奇异撞码极罕见）。

/** 按比赛标识匹配比赛（张老师 2026-11-18 晚定：**严格时间窗口**）——
 *  无论 race 命中还是签名末尾命中，都要求上传时间落在比赛窗口内：
 *  时间过后玩家会忘了改标识，race 命中不能豁免窗口。
 *  race 精确优先，退签名末尾（全等 → 「玩家名+标识」后缀枚举，2026-11-22
 *  411431 案）；都不在窗内 → 不绑定。 */
export async function matchTourByRace(
  race: string | null | undefined,
  signature: string,
  createTimeSec: number
): Promise<number | null> {
  const ts = BigInt(Math.floor(createTimeSec));
  const nowB = BigInt(Math.floor(Date.now() / 1000));
  // 窗口赛个人会话判据（2026-11-19 张老师定）：race 命中一个**未过期**的个人会话
  // 且上传时刻落在该会话窗口内 → 挂接该比赛；过期会话标识失效不再录入
  if (race) {
    const sess = await matchSession(race, ts, nowB);
    if (sess) return sess;
  }
  // 窗口条件对象（race 分支不带 code 条件，签名分支在外面拼）
  const windowWhere = {
    startTime: { lte: ts },
    endTime: { gte: ts },
  };
  if (race) {
    const hit = await prisma.tournament.findFirst({
      where: { code: race, ...windowWhere },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (hit) return Number(hit.id);
  }
  const sig = signature.trim();
  if (!sig) return null;
  // 签名后缀命中个人会话（2026-11-22 408465 案张老师定）：Arbiter 的 AVF 格式
  // 没有 race 字段，窗口赛玩家只能把个人标识（如 5VDLRP）写进署名末尾参加——
  // 判据与 race 字段完全同构（未过期会话 + 上传时刻在个人窗口内），挂在比赛
  // 共享 code 匹配**之前**（个人标识全局唯一，精确度高于 code 后缀，防二者
  // 恰好同时命中时错挂集体赛）。窗口赛计分按各玩家自己的会话窗过滤
  // （computePlayerScores），冒用他人窗口标识无计分收益，防冒充面不变。
  const sessHit = await matchSession(sig, ts, nowB);
  if (sessHit) return sessHit;
  // 签名「玩家名+个人标识」形态（2026-11-22 411431 案张老师定）：元扫雷等外部
  // 软件署名末尾是「名字 空格 标识」（如 "Wang Zi Cheng Yao Y3AQWS"），上面的
  // 全等查不到——再按会话表**实际 race 值**做签名后缀匹配（表极小=窗口赛玩家
  // 数级、race 唯一索引覆盖；个人标识全局唯一故无歧义）。命中后走同一窗口闸
  // （未过期+上传时刻在窗内），判据与集体赛 code endsWith 同构；全部候选都
  // 过不了窗口闸则继续往下走集体赛匹配。标识写在签名中间的形态不认（末尾口径）。
  try {
    const races = await prisma.tournamentWindowSession.findMany({ select: { race: true } });
    for (const r of races) {
      if (!sig.endsWith(r.race)) continue;
      const hit = await matchSession(r.race, ts, nowB);
      if (hit) return hit;
    }
  } catch { /* 后缀匹配失败不阻断，继续集体赛 code 匹配 */ }
  const candidates = await prisma.tournament.findMany({
    where: { ...windowWhere, code: { not: null } },
    select: { id: true, code: true },
    orderBy: { id: "asc" },
  });
  for (const c of candidates) {
    if (c.code && sig.endsWith(c.code)) return Number(c.id);
  }
  return null;
}

/** 比赛标识反查（**展示兜底专用**，2026-11-26 张老师定）：录像上传时刻必须落在
 *  比赛窗口内才认比赛——赛后玩家常忘改标识，窗外只显示原始标识文本，不识别成比赛录像。
 *  权威挂接关系（video.tournament_id）不走此兜底，后台手动挂接的窗外历史盘照常展示。 */
export async function findTourByCodeInWindow(
  code: string,
  createTimeSec: number
): Promise<{ id: bigint; shortName: string } | null> {
  const ts = BigInt(Math.floor(createTimeSec));
  return prisma.tournament.findFirst({
    where: { code, startTime: { lte: ts }, endTime: { gte: ts } },
    select: { id: true, shortName: true },
  });
}

/** 个人会话标识判据（共用）：race 命中**未过期**会话且上传时刻在会话窗内 → 返回比赛 id。
 *  抽出复用于两个入口（2026-11-22 408465 案张老师定）：race 字段（EVF 内嵌）+
 *  签名末尾（Arbiter AVF 无 race 字段，窗口赛玩家只能把个人标识写进署名末尾）。 */
async function matchSession(
  race: string,
  ts: bigint,
  nowB: bigint
): Promise<number | null> {
  const sess = await prisma.tournamentWindowSession.findUnique({
    where: { race },
    select: { tournamentId: true, startTime: true, endTime: true },
  });
  if (
    sess &&
    sess.endTime > nowB && // 会话未过期（标识失效判据）
    sess.startTime <= ts &&
    ts <= sess.endTime // 上传时刻在个人窗口内
  ) {
    return Number(sess.tournamentId);
  }
  return null;
}

export interface TourMyResult {
  joined: boolean;
  videos: number; // 我的参赛录像数
  bestTime: number | null; // 我的最好单盘（score 域，按 metric/方向取「最好」）
  /** 我的比赛总分（2026-11-22 张老师定：「最好成绩」行改总分口径，与排行榜/名次同源；
   *  null=无有效成绩。sum_topn=各级别最好 N 局加总+保底；target_diff=最小误差） */
  score: number | null;
  /** 总分计算过程（getTourMyResult 同款结构，hover 气泡逐行展示；target_diff 为 null） */
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[] | null;
  /** 各级别补保底局数（气泡「含保底」语境备用，本页未用） */
  filled: Record<string, number>;
  rank: number | null; // 在最新排名中的名次（全量排名内）
}

/** 我在这场比赛的成绩（详情页「我的成绩」板块）。
 *  成绩口径（张老师 2026-11-18）：bestTime=窗口内最好一局（单盘口径，按比赛
 *  metric/方向取「最好」）；score/rank=按比赛设定总分口径（与排行榜完全同源，
 *  同一 computePlayerScores 实例结果——2026-11-22 起「最好成绩」行展示 score 而非
 *  bestTime，单盘口径与总分气泡「总计」对不上且与图表头部「最好成绩」相悖）。 */
export async function getTourMyResult(compId: number, uid: number): Promise<TourMyResult> {
  const joined = await prisma.tournamentEntry.findFirst({
    where: { tournamentId: BigInt(compId), userId: BigInt(uid) },
    select: { id: true },
  });
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true, scoreMode: true, scoreConfig: true, windowHours: true, includeLevels: true },
  });
  const conf = parseScoreConfig(comp?.scoreMode ?? "", comp?.scoreConfig ?? "");
  const metric = conf?.metric ?? "time";
  const desc = conf?.desc ?? false;
  // 时间过滤口径与 getTourRanking 完全同源（2026-11-21 niu1）：集体赛不限上传时刻，
  // 窗口赛（windowHours>0 且有会话记录）按玩家个人会话窗口判窗
  const mySess =
    comp?.windowHours && (await prisma.tournamentWindowSession.count({ where: { tournamentId: BigInt(compId) } })) > 0
      ? await prisma.tournamentWindowSession.findFirst({
          where: { tournamentId: BigInt(compId), userId: BigInt(uid) },
          select: { startTime: true, endTime: true },
          orderBy: { endTime: "desc" },
        })
      : null;
  // Video/VideoInfo 无 relation，成绩字段分表取（同 getTourRanking）
  const rows = await prisma.video.findMany({
    where: {
      tournamentId: BigInt(compId),
      user: BigInt(uid),
      status: { not: 0 },
    },
    select: { id: true, createTime: true },
  });
  const myRows = mySess
    ? rows.filter((r) => {
        const t = Number(r.createTime);
        return t >= Number(mySess.startTime) && t <= Number(mySess.endTime);
      })
    : rows;
  const myInfos = await prisma.videoInfo.findMany({
    where: { id: { in: myRows.map((r) => r.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(myInfos.map((i) => [i.id, i]));
  const needsMetrics = metric !== "time" && metric !== "3bv";
  const myMetrics = needsMetrics
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: myRows.map((r) => r.id) } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      })
    : [];
  const myMetricsMap = new Map(myMetrics.map((m) => [m.id, m]));
  const metricValueOf = (vid: bigint): number => {
    if (metric === "time") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.realTime : 0;
    }
    if (metric === "3bv") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.board3bv * 1000 : 0;
    }
    const m = myMetricsMap.get(vid);
    if (!m) return 0;
    const raw = metric === "3bvs" ? m.bvs : metric === "ioe" ? m.ioe : metric === "thrp" ? m.thrp : m.cp;
    return raw > 0 ? raw * 1000 : 0;
  };
  let bestTime: number | null = null;
  for (const r of myRows) {
    const v = metricValueOf(r.id);
    if (!v) continue;
    if (bestTime === null || (desc ? v > bestTime : v < bestTime)) bestTime = v;
  }
  let rank: number | null = null;
  let myScore: PlayerScore | null = null;
  if (bestTime !== null) {
    // 名次按比赛设定总分（getTourRanking 全量版）：取全部玩家的 computePlayerScores，
    // desc=true 时「更好」= 严格更大，否则严格更小。
    // 时间过滤口径与 getTourRanking 同源（2026-11-21 niu1）：集体赛不滤时刻、窗口赛按会话窗
    const allVideos = await prisma.video.findMany({
      where: {
        tournamentId: BigInt(compId),
        status: { not: 0 },
      },
      select: { id: true, user: true, createTime: true },
    });
    const allSessions = comp?.windowHours
      ? await prisma.tournamentWindowSession.findMany({
          where: { tournamentId: BigInt(compId) },
          select: { userId: true, startTime: true, endTime: true },
        })
      : [];
    const sessBy = new Map(allSessions.map((s) => [Number(s.userId), s]));
    const all = allSessions.length > 0
      ? allVideos.filter((r) => {
          const s = sessBy.get(Number(r.user));
          const t = Number(r.createTime);
          return !!s && t >= Number(s.startTime) && t <= Number(s.endTime);
        })
      : allVideos;
    const allLevels = await prisma.video.findMany({
      where: { id: { in: all.map((r) => r.id) } },
      select: { id: true, level: true },
    });
    const levelMap = new Map(allLevels.map((l) => [l.id, l.level]));
    const allInfos = await prisma.videoInfo.findMany({
      where: { id: { in: all.map((r) => r.id) } },
      select: { id: true, realTime: true, board3bv: true, noRecord: true },
    });
    const infoById = new Map(allInfos.map((i) => [i.id, i]));
    const allNeedsMetrics = metric !== "time" && metric !== "3bv";
    const allMetrics = allNeedsMetrics
      ? await prisma.videoMetrics.findMany({
          where: { id: { in: all.map((r) => r.id) } },
          select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
        })
      : [];
    const allMetricsMap = new Map(allMetrics.map((m) => [m.id, m]));
    const allValueOf = (vid: bigint): number => {
      if (metric === "time") {
        const info = infoById.get(vid);
        return info && !info.noRecord ? info.realTime : 0;
      }
      if (metric === "3bv") {
        const info = infoById.get(vid);
        return info && !info.noRecord ? info.board3bv * 1000 : 0;
      }
      const m = allMetricsMap.get(vid);
      if (!m) return 0;
      const raw = metric === "3bvs" ? m.bvs : metric === "ioe" ? m.ioe : metric === "thrp" ? m.thrp : m.cp;
      return raw > 0 ? raw * 1000 : 0;
    };
    const allVids = all.map((r) => ({
      user: r.user,
      level: levelMap.get(r.id) ?? "",
      value: allValueOf(r.id),
      noRecord: infoById.get(r.id)?.noRecord ?? false,
      t: Number(r.createTime),
    }));
    const includeLv = (comp?.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean);
    const scores = computePlayerScores(comp?.scoreMode ?? "", comp?.scoreConfig ?? "", allVids, includeLv);
    const tMap = scoreAppearTimes(comp?.scoreMode ?? "", comp?.scoreConfig ?? "", allVids, includeLv);
    const mine = scores.get(uid);
    if (mine) {
      // 2026-11-22 张老师定：「最好成绩」行展示比赛总分（同排行榜排序口径），
      // hover 气泡展示与排行榜完全一致的计算过程（calc 由 computePlayerScores 产出）
      myScore = mine;
      // 名次=榜内「严格更好」人数+1（compareTourScores 同分决胜口径与排行榜一致：
      // 总分相同按总分出现先后排，先出现者排前，2026-11-27 张老师定）
      rank =
        1 + [...scores.entries()].filter(([u, s]) => compareTourScores(s, mine, desc, tMap.get(u), tMap.get(uid)) < 0).length;
    } else {
      rank = null;
    }
  }
  return {
    joined: !!joined,
    videos: myRows.length,
    bestTime,
    score: myScore ? myScore.score : null,
    calc: myScore && myScore.calc.length > 0 ? myScore.calc : null,
    filled: myScore?.filled ?? {},
    rank,
  };
}

/** 比赛窗口内全部参赛录像的算分底座（2026-11-22 练习页比赛模式两行统计需求）：
 *  判窗与 getTourRanking 完全同源（集体赛不过滤；窗口赛按**各玩家自己的**会话窗
 *  收录像）——sessWin 只是本人窗口的权威注入（race 归属调用方已校验），仅覆盖
 *  本人 uid 的判窗，绝不把本人窗套到全量行集上（2026-11-22 排名虚高 bug：旧写法
 *  拿本人窗滤了所有玩家的录像，全量 Map 只剩窗口重叠者，标题行「第 2」vs 详情页
 *  「第 18」案）；返回全量 PlayerScore Map + 本人明细——SSR 快照
 *  （getMyScoreSnapshot）与传盘后刷新接口（my-score route）共用，保证两路
 *  分数/名次口径恒一致。 */
export async function getMyScoreValues(
  compId: number,
  uid: number,
  sessWin?: { start: number; end: number } | null
): Promise<{
  /** vid → metric 值（score 域；供调试/复核用，客户端不消费） */
  values: Map<string, number>;
  /** 全部玩家算分结果（getTourRanking 同一实例口径） */
  scores: Map<number, PlayerScore>;
  /** 本人 PlayerScore（无有效成绩=undefined） */
  mine: PlayerScore | undefined;
  /** 本人 calc 过程（mine 存在时空数组也直传） */
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[];
  /** 本人各级别选入计分的实盘明细（2026-11-24，练习页统计格 hover） */
  detail: ScoreVideoDetail[];
  /** 本人各级别补保底局数 */
  filled: Record<string, number>;
  /** 各玩家「总分出现时刻」（同分决胜用，2026-11-27；uid→秒，纯保底玩家不在 Map） */
  times: Map<number, number>;
} | null> {
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { scoreMode: true, scoreConfig: true, includeLevels: true, windowHours: true },
  });
  if (!comp) return null;
  const conf = parseScoreConfig(comp.scoreMode ?? "", comp.scoreConfig ?? "");
  if (!conf) return null;
  // 判窗（getTourRanking 完全同源）：窗口赛有会话记录时**每个玩家按自己的会话窗**
  // 收录像；sessWin=本人窗口的权威注入（?race= 调用方已校验归属），只覆盖本人
  // uid 的窗——全量算分（名次分母）绝不能拿本人窗滤别人（2026-11-22 排名虚高案）
  const rows = await prisma.video.findMany({
    where: { tournamentId: BigInt(compId), status: { not: 0 } },
    select: { id: true, user: true, level: true, createTime: true },
  });
  let inWin = rows;
  // 会话窗全量拉取只看 windowHours（sessWin 场景同样需要别人的窗——本人窗由
  // sessWin 覆盖，绝不能因此短路掉全量会话查询，否则别人全部判窗外名次恒 1）
  const sessionWindows = comp.windowHours
    ? await prisma.tournamentWindowSession.findMany({
        where: { tournamentId: BigInt(compId) },
        select: { userId: true, startTime: true, endTime: true },
      })
    : [];
  if (sessWin || sessionWindows.length > 0) {
    const sessBy = new Map<number, { s: number; e: number }>(
      sessionWindows.map((s) => [Number(s.userId), { s: Number(s.startTime), e: Number(s.endTime) }])
    );
    inWin = rows.filter((r) => {
      const uidN = Number(r.user);
      // 本人：调用方注入的权威窗优先（唯一会话由 start 路由「一次开赛铁律」保证）
      const w = uidN === uid && sessWin ? { s: sessWin.start, e: sessWin.end } : sessBy.get(uidN);
      if (!w) return false;
      const t = Number(r.createTime);
      return t >= w.s && t <= w.e;
    });
  }
  const levelMap = new Map(inWin.map((r) => [r.id, r.level]));
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: inWin.map((r) => r.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const needsMetrics = conf.metric !== "time" && conf.metric !== "3bv";
  const metrics = needsMetrics
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: inWin.map((r) => r.id) } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      })
    : [];
  const metricMap = new Map(metrics.map((m) => [m.id, m]));
  const valueOf = (vid: bigint): number => {
    if (conf.metric === "time") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.realTime : 0;
    }
    if (conf.metric === "3bv") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.board3bv * 1000 : 0;
    }
    const m = metricMap.get(vid);
    if (!m) return 0;
    const raw = conf.metric === "3bvs" ? m.bvs : conf.metric === "ioe" ? m.ioe : conf.metric === "thrp" ? m.thrp : m.cp;
    return raw > 0 ? raw * 1000 : 0;
  };
  const values = new Map<string, number>();
  const vids = inWin.map((r) => {
    const v = valueOf(r.id);
    values.set(r.id.toString(), v);
    return {
      user: r.user,
      level: levelMap.get(r.id) ?? "",
      value: v,
      noRecord: infoMap.get(r.id)?.noRecord ?? false,
      vid: Number(r.id), // 逐盘明细用（2026-11-24）
      t: Number(r.createTime), // 同分决胜用：总分出现时刻（2026-11-27 张老师定）
    };
  });
  const includeLv = (comp.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean);
  const scores = computePlayerScores(comp.scoreMode ?? "", comp.scoreConfig ?? "", vids, includeLv);
  // 总分出现时刻（同分决胜：总分相同按出现先后排，先出现者排前）
  const times = scoreAppearTimes(comp.scoreMode ?? "", comp.scoreConfig ?? "", vids, includeLv);
  let mine = scores.get(uid);
  /* 纯保底补算（2026-11-22 张老师定「保底成绩也应该显示成绩和排名」）：
     computePlayerScores 只为有有效录像的玩家产出（byUserLevel 遍历 valid）——
     报名/开赛但 0 有效盘的玩家不在 Map，标题行显「—」。本人无 Map 行时按
     同一公式就地补算全保底总分（fill=n×floorScore 逐级别加总），只补本人
     一行、不进全量 Map（排行榜现口径「无有效录像不上榜」不动）；名次由
     调用方（my-score 路由）拿此分数与全量 Map 严格比较得出。 */
  if (!mine) {
    const includeLevels = (comp.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean);
    let sum = 0;
    const parts: Record<string, number> = {};
    const filled: Record<string, number> = {};
    const calc: PlayerScore["calc"] = [];
    let any = false;
    for (const lv of ["beg", "int", "exp"] as const) {
      const n = conf.topn[lv] ?? 0;
      if (n <= 0 || !includeLevels.includes(lv)) continue;
      const floorScore = conf.floor[lv] ?? 0;
      const fill = floorScore > 0 ? n : 0; // 无保底配置的级别无从补（fill=0 与主算分一致）
      parts[lv] = 0;
      filled[lv] = fill;
      sum += fill * floorScore;
      calc.push({ lv, n, real: 0, fill, floorScore });
      if (n > 0) any = true;
    }
    if (any) mine = { score: sum, parts, filled, calc, detail: [] };
  }
  return {
    values,
    scores,
    mine,
    calc: mine ? mine.calc : [],
    detail: mine ? mine.detail : [],
    filled: mine ? mine.filled : {},
    times,
  };
}

/** 练习页比赛模式标题行「成绩」行数据（2026-11-22 张老师需求）：本人总分快照
 *  + 当前名次（SSR 下发首屏即显，不等 30s tick——张老师 22:37 截图反馈「纯保底
 *  也应该显示排名」实测是首屏窗口缺排名）。无成绩返回 null。getMyScoreValues
 *  薄封装；名次口径与 my-score 接口同源（榜内严格更好人数+1）。 */
export async function getMyScoreSnapshot(
  compId: number,
  uid: number,
  sessWin?: { start: number; end: number } | null
): Promise<{
  score: number;
  rank: number;
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[];
  /** 各级别选入计分的实盘明细（2026-11-24 练习页统计格 hover） */
  detail: ScoreVideoDetail[];
  filled: Record<string, number>;
} | null> {
  const r = await getMyScoreValues(compId, uid, sessWin);
  if (!r?.mine) return null;
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { scoreMode: true, scoreConfig: true },
  });
  const desc = comp ? parseScoreConfig(comp.scoreMode, comp.scoreConfig)?.desc ?? false : false;
  // 名次=榜内「严格更好」人数+1（compareTourScores 同分决胜，与排行榜口径一致：
  // 总分相同按总分出现先后排，先出现者排前；纯保底本人无出现时刻恒排有盘玩家后）
  const rank =
    1 + [...r.scores.entries()].filter(([u, s]) => compareTourScores(s, r.mine!, desc, r.times.get(u), r.times.get(uid)) < 0).length;
  return { score: r.mine.score, rank, calc: r.mine.calc, detail: r.mine.detail, filled: r.mine.filled };
}

/** 比赛破纪录预演（2026-11-22 张老师需求：练习页比赛模式「完成一盘→破纪录气泡」）：
 *  把「本盘上传后」虚拟并入本人窗口内录像集再算一次总分——新旧总分按方向严格
 *  比较，有提升才返回（old=当前总分，null=暂无成绩；score=并入后的新总分）。
 *  为什么不能客户端拍脑袋算：sum_topn 按方向取各级别最好 N 局+保底补足，新盘能否
 *  进榜取决于它在本级别现有盘里的排位（desc=true 替换最小实盘、asc 替换最大实盘、
 *  有空位顶掉保底），只有把本盘虚拟并入重跑 computePlayerScores（唯一计分事实源）
 *  才能得出正确新总分——旧算术直加对 desc 方向恒错。
 *  · value=本盘在该比赛 metric 上的 score 域值（time=毫秒，其余=落库×1000）——
 *    客户端结算面板同引擎（replayCounts）统计透传；上传落库后由 video_metrics
 *    权威重算，预演值仅供气泡展示（±0.001 级舍入差可接受，标题行刷新以落库为准）；
 *  · 窗口判据与 getMyScoreValues 完全同源（sessWin 归属校验在调用方 pb 路由；
 *    集体赛不过滤、窗口赛有会话记录按本人会话窗）；
 *  · 比赛不在进行中 / 无计分配置 / value 无效（≤0；noRecord 盘调用方先闸）/
 *    级别不在收录（includeLevels/topn 由 computePlayerScores 天然过滤）/
 *    并入后无提升 → 恒 null，调用方不弹气泡不拦重开。 */
export async function getTourScorePreview(
  compId: number,
  uid: number,
  level: string,
  value: number,
  sessWin?: { start: number; end: number } | null
): Promise<{ old: number | null; score: number } | null> {
  if (!Number.isFinite(value) || value <= 0) return null;
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { scoreMode: true, scoreConfig: true, includeLevels: true, windowHours: true, startTime: true, endTime: true },
  });
  if (!comp) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(comp.startTime) || now >= Number(comp.endTime)) return null;
  const conf = parseScoreConfig(comp.scoreMode ?? "", comp.scoreConfig ?? "");
  if (!conf) return null;
  const levels = (comp.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean);
  // 本人窗口内录像（getMyScoreValues 同判窗；总分按玩家独立计算，行集收敛到
  // 本人结果等价且省查——computePlayerScores 各玩家互不依赖）
  const rows = await prisma.video.findMany({
    where: { tournamentId: BigInt(compId), user: BigInt(uid), status: { not: 0 } },
    select: { id: true, level: true, createTime: true },
  });
  let inWin = rows;
  if (sessWin) {
    inWin = rows.filter((r) => {
      const t = Number(r.createTime);
      return t >= sessWin.start && t <= sessWin.end;
    });
  } else if (comp.windowHours) {
    const sess = await prisma.tournamentWindowSession.findFirst({
      where: { tournamentId: BigInt(compId), userId: BigInt(uid) },
      orderBy: { endTime: "desc" },
      select: { startTime: true, endTime: true },
    });
    if (sess) {
      inWin = rows.filter((r) => {
        const t = Number(r.createTime);
        return t >= Number(sess.startTime) && t <= Number(sess.endTime);
      });
    }
  }
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: inWin.map((r) => r.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const needsMetrics = conf.metric !== "time" && conf.metric !== "3bv";
  const metrics = needsMetrics
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: inWin.map((r) => r.id) } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      })
    : [];
  const metricMap = new Map(metrics.map((m) => [m.id, m]));
  const valueOf = (vid: bigint): number => {
    if (conf.metric === "time") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.realTime : 0;
    }
    if (conf.metric === "3bv") {
      const info = infoMap.get(vid);
      return info && !info.noRecord ? info.board3bv * 1000 : 0;
    }
    const m = metricMap.get(vid);
    if (!m) return 0;
    const raw = conf.metric === "3bvs" ? m.bvs : conf.metric === "ioe" ? m.ioe : conf.metric === "thrp" ? m.thrp : m.cp;
    return raw > 0 ? raw * 1000 : 0;
  };
  const vidsOf = (extra?: { level: string; value: number }) => {
    const list = inWin.map((r) => ({
      user: BigInt(uid),
      level: r.level,
      value: valueOf(r.id),
      noRecord: infoMap.get(r.id)?.noRecord ?? false,
    }));
    if (extra) list.push({ user: BigInt(uid), level: extra.level, value: extra.value, noRecord: false });
    return list;
  };
  const base = computePlayerScores(comp.scoreMode ?? "", comp.scoreConfig ?? "", vidsOf(), levels).get(uid);
  const withNew = computePlayerScores(comp.scoreMode ?? "", comp.scoreConfig ?? "", vidsOf({ level, value }), levels).get(uid);
  if (!withNew) return null; // 本盘无效（级别不收录/未配 topn）→ 无提升可言
  const oldScore = base ? base.score : null;
  if (oldScore === null && withNew.score <= 0) return null; // 首盘即 0 分（target_diff 正中靶心）无从「提升」
  const better = comp.scoreMode === "target_diff"
    ? oldScore === null || withNew.score < oldScore // target_diff 恒越小越好
    : conf.desc
      ? oldScore === null || withNew.score > oldScore
      : oldScore === null || withNew.score < oldScore;
  if (!better) return null;
  return { old: oldScore, score: withNew.score };
}

/** 比赛详情页统计（张老师 2026-11-19 定：报名人数与参赛人数分开统计，不冲突）——
 *  registrations=报名人数（tournament_entry 去重 user；为 0 时前台整行不显示，
 *  历届导入的旧比赛不存在统计误差）；entries=参赛人数＝实际传了录像的持有者数
 *  （distinct user）；videos=参赛录像数（挂接且未屏蔽）；
 *  finishers=完赛人数（2026-11-22 张老师需求）：所有级别录像数量都满足要求、
 *  无任何保底成绩的人数——按 computePlayerScores 批量算分后数 filled 全 0 的玩家
 *  （sum_topn=各级别有效录像数 ≥ N；target_diff 无级别数量要求，有有效成绩即算）。
 *  收录窗口与时间过滤判据与 getTourRanking 同源（集体赛不过滤；窗口赛有会话记录时
 *  按各玩家会话窗收录像）。 */
export async function getTourDetailStats(
  compId: number
): Promise<{ registrations: number; entries: number; videos: number; finishers: number }> {
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { scoreMode: true, scoreConfig: true, includeLevels: true, windowHours: true },
  });
  const [regRows, rows] = await Promise.all([
    prisma.tournamentEntry.findMany({
      where: { tournamentId: BigInt(compId) },
      select: { userId: true },
    }),
    prisma.video.findMany({
      where: { tournamentId: BigInt(compId), status: { not: 0 } },
      select: { id: true, user: true, level: true, createTime: true },
    }),
  ]);
  // 完赛人数：有比赛计分配置才算（无配置=0）
  const conf = comp ? parseScoreConfig(comp.scoreMode ?? "", comp.scoreConfig ?? "") : null;
  let finishers = 0;
  if (comp && conf) {
    const sessionWindows = comp.windowHours
      ? await prisma.tournamentWindowSession.findMany({
          where: { tournamentId: BigInt(compId) },
          select: { userId: true, startTime: true, endTime: true },
        })
      : [];
    const sessByUser = new Map(sessionWindows.map((s) => [Number(s.userId), s]));
    const useSessWindow = !!comp.windowHours && sessionWindows.length > 0;
    const inWin = useSessWindow
      ? rows.filter((r) => {
          const s = sessByUser.get(Number(r.user));
          const t = Number(r.createTime);
          return !!s && t >= Number(s.startTime) && t <= Number(s.endTime);
        })
      : rows;
    const levelMap = new Map(inWin.map((r) => [r.id, r.level]));
    const infos = await prisma.videoInfo.findMany({
      where: { id: { in: inWin.map((r) => r.id) } },
      select: { id: true, realTime: true, board3bv: true, noRecord: true },
    });
    const infoMap = new Map(infos.map((i) => [i.id, i]));
    const needsMetrics = conf.metric !== "time" && conf.metric !== "3bv";
    const metrics = needsMetrics
      ? await prisma.videoMetrics.findMany({
          where: { id: { in: inWin.map((r) => r.id) } },
          select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
        })
      : [];
    const metricMap = new Map(metrics.map((m) => [m.id, m]));
    const valueOf = (vid: bigint): number => {
      if (conf.metric === "time") {
        const info = infoMap.get(vid);
        return info && !info.noRecord ? info.realTime : 0;
      }
      if (conf.metric === "3bv") {
        const info = infoMap.get(vid);
        return info && !info.noRecord ? info.board3bv * 1000 : 0;
      }
      const m = metricMap.get(vid);
      if (!m) return 0;
      const raw = conf.metric === "3bvs" ? m.bvs : conf.metric === "ioe" ? m.ioe : conf.metric === "thrp" ? m.thrp : m.cp;
      return raw > 0 ? raw * 1000 : 0;
    };
    const scores = computePlayerScores(
      comp.scoreMode ?? "",
      comp.scoreConfig ?? "",
      inWin.map((r) => ({
        user: r.user,
        level: levelMap.get(r.id) ?? "",
        value: valueOf(r.id),
        noRecord: infoMap.get(r.id)?.noRecord ?? false,
      })),
      (comp.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean),
    );
    // 完赛判定核心（filled 全 0，见 finisherUidsOf）
    finishers = finisherUidsOf(conf, scores).length;
  }
  return {
    registrations: new Set(regRows.map((r) => r.userId.toString())).size,
    entries: new Set(rows.map((r) => r.user.toString())).size,
    videos: rows.length,
    finishers,
  };
}

/** 完赛判定核心（2026-11-22 张老师需求）：所有计分级别录像数量都满足要求、
 *  无任何保底成绩的玩家 uid 列表——sum_topn 按 filled 全 0 判（收录级别之外的
 *  级别不参与计分，filled 无该项视为满足）；target_diff 无级别数量要求，
 *  有有效成绩即算（topn 为空 → every 恒真）。 */
function finisherUidsOf(conf: ParsedScoreConfig, scores: Map<number, PlayerScore>): number[] {
  const topnLevels = (["beg", "int", "exp"] as const).filter((lv) => (conf.topn[lv] ?? 0) > 0);
  const list: number[] = [];
  for (const [uid, s] of scores) {
    if (topnLevels.every((lv) => (s.filled[lv] ?? 0) === 0)) list.push(uid);
  }
  return list;
}

/** 后台比赛清单批量完赛统计（2026-11-22 张老师需求）：返回 Map<compId, 完赛 uid 列表>。
 *  与 getTourDetailStats.finishers 同口径（finisherUidsOf）；一次取齐比赛/录像/
 *  会话/明细四表后按比赛分组算分，当前页 10 场共 5 个查询，不逐场 N×5。 */
export async function getTourFinishersBulk(
  compIds: number[]
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (compIds.length === 0) return out;
  const bigIds = [...new Set(compIds)].map((n) => BigInt(n));
  const [comps, vids, sessions] = await Promise.all([
    prisma.tournament.findMany({
      where: { id: { in: bigIds } },
      select: { id: true, scoreMode: true, scoreConfig: true, includeLevels: true, windowHours: true },
    }),
    prisma.video.findMany({
      where: { tournamentId: { in: bigIds }, status: { not: 0 } },
      select: { id: true, tournamentId: true, user: true, level: true, createTime: true },
    }),
    prisma.tournamentWindowSession.findMany({
      where: { tournamentId: { in: bigIds } },
      select: { tournamentId: true, userId: true, startTime: true, endTime: true },
    }),
  ]);
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: vids.map((v) => v.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const metrics = vids.length
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: vids.map((v) => v.id) } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      })
    : [];
  const metricMap = new Map(metrics.map((m) => [m.id, m]));
  for (const comp of comps) {
    const conf = parseScoreConfig(comp.scoreMode, comp.scoreConfig);
    if (!conf) {
      out.set(Number(comp.id), []);
      continue;
    }
    // 时间过滤判据与 getTourRanking 同源：集体赛不过滤；窗口赛有会话记录时按各玩家会话窗
    const compSess = sessions.filter((s) => String(s.tournamentId) === String(comp.id));
    const useSess = !!comp.windowHours && compSess.length > 0;
    const sessBy = new Map(compSess.map((s) => [Number(s.userId), s]));
    const inWin = useSess
      ? vids.filter((r) => {
          if (String(r.tournamentId) !== String(comp.id)) return false;
          const s = sessBy.get(Number(r.user));
          const t = Number(r.createTime);
          return !!s && t >= Number(s.startTime) && t <= Number(s.endTime);
        })
      : vids.filter((r) => String(r.tournamentId) === String(comp.id));
    const valueOf = (vid: bigint): number => {
      if (conf.metric === "time") {
        const info = infoMap.get(vid);
        return info && !info.noRecord ? info.realTime : 0;
      }
      if (conf.metric === "3bv") {
        const info = infoMap.get(vid);
        return info && !info.noRecord ? info.board3bv * 1000 : 0;
      }
      const m = metricMap.get(vid);
      if (!m) return 0;
      const raw = conf.metric === "3bvs" ? m.bvs : conf.metric === "ioe" ? m.ioe : conf.metric === "thrp" ? m.thrp : m.cp;
      return raw > 0 ? raw * 1000 : 0;
    };
    const scores = computePlayerScores(
      comp.scoreMode,
      comp.scoreConfig,
      inWin.map((r) => ({
        user: r.user,
        level: r.level,
        value: valueOf(r.id),
        noRecord: infoMap.get(r.id)?.noRecord ?? false,
      })),
      (comp.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean),
    );
    out.set(Number(comp.id), finisherUidsOf(conf, scores));
  }
  return out;
}

/** 比赛录像分页（详情页「录像」板块）：默认按上传时间逆序（新在前，2026-11-22 张老师定），
 *  展示形式与首页录像流一致（VideoRows 行渲染），但按比赛过滤、不去重。
 *  2026-11-22 张老师需求：支持级别筛选（仅比赛收录级别，初/中/高级）与表头排序
 *  （成绩/3BV/计分项等，同 /video 列表口径——time 排序滤运气盘、3bvs/stnb 限界、
 *  comments/clicks 仅 >0）。查询从 Prisma findMany 改统一 join raw SQL：
 *  排序键分布在 video_info/video_metrics/video_stat 三张表，Prisma 无跨表 orderBy */
export async function getTourVideosPage(
  compId: number,
  page: number,
  pageSize = 20,
  opts?: {
    /** 作者筛选（用户 id，比赛范围搜索 2026-11-18 晚张老师定） */
    author?: number;
    /** 时间成绩搜索（秒，前缀匹配语义同 /video 列表页：>=该值的实盘成绩） */
    time?: number;
    /** 3BV 搜索（整数） */
    bv?: number;
    /** 级别筛选（2026-11-22 张老师需求）：仅比赛收录级别，缺省=全部级别 */
    level?: VideoLevel;
    /** 表头排序（2026-11-22 张老师需求）：缺省=id（上传时间倒序）；dir 缺省=该列默认方向 */
    order?: VideoListOrder;
    dir?: VideoListDir;
  }
): Promise<{ videos: VideoListItem[]; total: number; page: number; pageSize: number }> {
  const level = opts?.level;
  const order: VideoListOrder = opts?.order ?? "id";
  const dir: VideoListDir = opts?.dir ?? VIDEO_LIST_DEFAULT_DIR[order];
  const asc = dir === "asc";
  const D = asc ? "ASC" : "DESC";
  const hasSearch = !!(opts?.time || opts?.bv);
  // 默认排序（id=上传时间序）且无成绩/3BV 搜索：Prisma 原路径（video 表直查，行为不变）。
  // 带搜索时走下方 join 路径——旧实现「videoInfo.findMany 取 id → IN 过滤」在搜索命中
  // 行数多时超 MySQL 65535 占位符上限直接 500（Prepared statement contains too many
  // placeholders），2026-11-22 本地 vtime=12 实证；搜索条件下沉 join 后自然消除
  if (order === "id" && !hasSearch) {
    const base: Record<string, unknown> = { tournamentId: BigInt(compId), status: { not: 0 } };
    if (opts?.author) base.user = BigInt(opts.author);
    if (level) base.level = level;
    const where = base as { tournamentId: bigint; status: { not: 0 } };
    const total = await prisma.video.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(Math.max(page, 1), totalPages);
    const ids =
      total === 0
        ? []
        : (
            await prisma.video.findMany({
              where,
              select: { id: true },
              orderBy: [{ createTime: D.toLowerCase() as "asc" | "desc" }, { id: D.toLowerCase() as "asc" | "desc" }],
              skip: (p - 1) * pageSize,
              take: pageSize,
            })
          ).map((r) => Number(r.id));
    return { videos: await getVideosByIds(ids), total, page: p, pageSize };
  }

  // 其余排序：统一 join（同 getVideoList videoListConds 口径）——
  // 驱动表恒 video（比赛范围小，无需 FORCE INDEX 优化），按排序键选 join 表
  const needVi = order === "time" || order === "3bv" || order === "3bvs" || order === "stnb" || order === "crossings" || order === "thrp";
  const needVs = order === "comments" || order === "clicks";
  const needVm = order === "ioe" || order === "stnb" || order === "crossings" || order === "thrp";
  // 裸拼 SQL 护栏 v2：值一律 ? 占位符（compId/author/level/time/bv 均为运行期值）；
  // 标识符（列名/ASC·DESC）才是插值合法域——assertVideoLevel 只作运行时白名单断言
  const conds: string[] = [
    // 列名暂留 competition_id（2026-11-18 competition→tournament 改名未 RENAME，schema 注释同口径）
    `v.competition_id = ?`,
    `v.status <> 0`,
  ];
  const condVals: (string | number | bigint)[] = [compId];
  if (opts?.author) {
    conds.push(`v.user = ?`);
    condVals.push(BigInt(opts.author));
  }
  if (level) {
    conds.push(`v.level = ?`);
    condVals.push(assertVideoLevel(level));
  }
  if (opts?.time) {
    conds.push(`vi.real_time >= ?`);
    condVals.push(Math.round(opts.time * 1000));
  }
  if (opts?.bv) {
    conds.push(`vi.board_3bv >= ?`);
    condVals.push(opts.bv);
  }
  // 排序口径同 /video 列表（2026-11-22 比赛录像区沿用）：
  // time/3bvs/stnb 排序滤运气盘（no_record=1 成绩划线无效）；3bvs/stnb 排序限界内才有效；
  // comments/clicks 排序仅出 >0 的行（同 /video 原 >0 过滤口径）
  if (order === "time" || order === "3bvs" || order === "stnb") {
    conds.push(`vi.real_time > 0`, `vi.no_record = 0`);
  }
  if (order === "3bvs" || order === "stnb") {
    conds.push(
      `vi.board_3bv >= CASE v.level WHEN 'beg' THEN ${MIN_3BV_FOR_3BVS.beg} WHEN 'int' THEN ${MIN_3BV_FOR_3BVS.int} ELSE ${MIN_3BV_FOR_3BVS.exp} END`
    );
  }
  if (order === "comments") conds.push(`vs.comments > 0`);
  if (order === "clicks") conds.push(`vs.clicks > 0`);
  const joins = `FROM video v JOIN video_info vi ON vi.id = v.id${
    needVs ? " JOIN video_stat vs ON vs.id = v.id" : ""
  }${needVm ? " JOIN video_metrics vm ON vm.id = v.id" : ""}`;
  const orderBy =
    order === "id"
      ? `v.create_time ${D}` // id+搜索路径：上传时间序（同 /video 默认排序口径）
      : order === "time"
        ? `vi.real_time ${D}`
        : order === "3bv"
          ? `vi.board_3bv ${D}`
          : order === "3bvs"
            ? `(vi.board_3bv * 1000000 / vi.real_time) ${D}`
            : order === "ioe"
              ? `vm.ioe ${D}`
              : order === "stnb"
                ? `vm.stnb ${D}`
                : order === "crossings"
                  ? `vm.cp ${D}`
                  : order === "thrp"
                    ? `vm.thrp ${D}`
                    : `vs.comments ${D}`; // comments（clicks 由下方同式覆盖）
  const orderExpr = order === "clicks" ? `vs.clicks ${D}` : orderBy;
  const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const totalRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) AS c ${joins} ${whereSql}`,
    ...condVals
  );
  const total = Number(totalRows[0]?.c ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(page, 1), totalPages);
  // LIMIT/OFFSET 为服务端整数（pageSize 常量、p 经 clamp），插值合法域
  const idRows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
    `SELECT v.id AS id ${joins} ${whereSql} ORDER BY ${orderExpr}, v.id ${D} LIMIT ${pageSize} OFFSET ${(p - 1) * pageSize}`,
    ...condVals
  );
  const ids = idRows.map((r) => Number(r.id));
  return { videos: await getVideosByIds(ids), total, page: p, pageSize };
}

// 首页录像流行类型（VideoRows 渲染入参）

// ---------- 详情（2026-11-13 二期：/tournaments/[id]）----------

/** 单场比赛完整行（与列表 TourRow 同构，详情页顶部板块复用 TourBlock 渲染） */
/** 详情页路由参数解析（2026-11-19 张老师定）：/tournaments/<id> 或 /tournaments/<alias>。
 *  纯数字 → 按 id；否则按比赛代号 alias 查（gsc13 → 21）；查不到 → null（notFound）。 */
export async function resolveTourIdParam(raw: string): Promise<number | null> {
  const n = parseInt(raw, 10);
  if (/^\d+$/.test(raw) && Number.isInteger(n) && n > 0) return n;
  const hit = await prisma.tournament.findUnique({
    where: { alias: raw },
    select: { id: true },
  });
  return hit ? Number(hit.id) : null;
}

export async function getTournamentDetail(
  id: number,
  uid?: number
): Promise<TourRow | null> {
  const c = await prisma.tournament.findUnique({ where: { id: BigInt(id) } });
  if (!c) return null;
  const now = Math.floor(Date.now() / 1000);
  const [entryCount, finisherMap, creator, scoreRow, joined] = await Promise.all([
    prisma.tournamentEntry.count({ where: { tournamentId: c.id } }),
    getTourFinishersBulk([id]),
    prisma.user.findUnique({
      where: { id: c.creatorId },
      select: { chineseName: true, englishName: true, sex: true, status: true },
    }),
    prisma.userScores.findUnique({ where: { id: c.creatorId }, select: { expTime: true } }),
    uid
      ? prisma.tournamentEntry.findFirst({
          where: { tournamentId: c.id, userId: BigInt(uid) },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  // 双体系称号评定（与列表同口径：ranked=当前在榜）
  const [pair] = await dualTitles([
    {
      userId: Number(c.creatorId),
      expTime: scoreRow?.expTime ?? 0,
      ranked: creator?.status === 0,
      sex: creator?.sex ?? 1,
    },
  ]);
  // 收录级别解析（容错同列表：非法键剔除，全空回退全级别）
  const levelSet = new Set(
    c.includeLevels
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Level => (LEVELS as readonly string[]).includes(s)),
  );
  // 纪录图表数据（2026-11-18 晚张老师问「已结束为什么没数据」）：按比赛设定总分
  // 排名的散点——复用 getTourRanking 全量口径，展示全部有成绩参赛者（score 秒）；
  // 无成绩比赛为空。图表上方「最好成绩」行 = 第一名（总分口径）
  const rankRows =
    c.startTime <= now
      ? await getTourRanking(id, null)
      : [];
  const chartPoints = rankRows.map((r) => ({
    rank: r.rank,
    score: r.time / 1000,
    name: r.name,
    uid: r.uid,
    englishName: r.englishName,
    sex: r.sex,
    title: r.title,
    classic: r.classic,
  }));
  const first = rankRows[0];
  const bestLine = first
    ? {
        score: first.time,
        name: first.name,
        englishName: first.englishName,
        sex: first.sex,
        title: first.title,
        uid: first.uid,
        // 「创造于」= 该玩家参赛录像（挂接口径同排行榜：集体赛不限上传时刻）中
        // 最早一盘的上传时刻
        at: await (async () => {
          const v = await prisma.video.findFirst({
            where: {
              tournamentId: BigInt(id),
              user: BigInt(first.uid),
              status: { not: 0 },
            },
            select: { createTime: true },
            orderBy: { createTime: "asc" },
          });
          return Number(v?.createTime ?? c.startTime);
        })(),
      }
    : null;
  // 计分口径透传（2026-11-21 多数据项：TourBlock 最好成绩行/图表按 metric 格式化、
  // 按方向标注「越大越好」）
  const tourConf = parseScoreConfig(c.scoreMode, c.scoreConfig);
  return {
    id: c.id.toString(),
    alias: c.alias ?? "",
    name: c.name,
    shortName: c.shortName,
    status: tourStatus(c.startTime, c.endTime, now),
    start: Number(c.startTime),
    end: Number(c.endTime),
    rules: c.rules,
    creatorName: creator?.chineseName ?? `UID ${c.creatorId}`,
    prizeTotal: c.prizeTotal,
    prizeLines: parsePrizePlan(c.prizePlan),
    code: c.code ?? "",
    windowHours: c.windowHours ?? 0,
    // 我的窗口（窗口赛已手动开赛；登录态查询）。2026-11-22 张老师定「一人一赛只能开
    // 一次」：取最早一次会话为本人参赛窗口（18875 双会话事故前的存量行兼容——
    // 历史双会话只会把成绩窗判给错误窗口，展示/计分恒认首次开赛窗口）；
    // finished=该窗口已结束（右栏显示「已完赛」不可再开赛）
    mySession: uid
      ? await (async () => {
          const s = await prisma.tournamentWindowSession.findFirst({
            where: { tournamentId: c.id, userId: BigInt(uid) },
            select: { race: true, startTime: true, endTime: true },
            orderBy: { startTime: "asc" },
          });
          return s
            ? { race: s.race, start: Number(s.startTime), end: Number(s.endTime), finished: Number(s.endTime) <= now }
            : null;
        })()
      : null,
    entryCount,
    finishedCount: finisherMap.get(id)?.length ?? 0,
    joined: !!joined,
    levels: levelSet.size ? LEVELS.filter((l) => levelSet.has(l)) : [...LEVELS],
    creatorId: Number(c.creatorId),
    creatorEnglishName: creator?.englishName ?? "",
    creatorSex: creator?.sex ?? 1,
    creatorTitle: pair?.m ?? "",
    creatorClassic: pair?.c ?? null,
    scoreMetric: tourConf?.metric ?? "time",
    scoreDesc: tourConf?.desc ?? false,
    scoreMode: c.scoreMode,
    scoreConfig: c.scoreConfig,
    chartPoints,
    bestLine,
  };
}

// ---------- 成绩计算（2026-11-13 四期 张老师定；2026-11-18 保底补足+排行榜按总分排序；
//            2026-11-21 多数据项改造：time/3bvs/ioe/thrp/crossings/3bv + 方向可选） ----------
//
// 计算方式可扩展：score_mode + score_config(JSON) 落库，新增方式加分支即可。
// 口径（2026-11-21 起）：
// · 数据项 metric（张老师 2026-11-21 定）：time / 3bvs / ioe / thrp / crossings / 3bv
//   六选一，注册表见 lib/tour-metric.ts（单 Key、中文名、单位、默认方向）；
// · 方向 desc（同日定）：desc=true 越大越好 / false 越小越好，缺省按项默认
//   （time/crossings 越小越好，3bvs/ioe/thrp/3bv 越大越好）。
// · sum_topn 成绩加总：玩家成绩 = 各收录级别最好/最差 N 局按方向取后加总，
//   内部 score 域统一「落库值×1000」（time=毫秒，其余项 ×1000 保 0.001 精度）；
//   某级别不足 N 局用「保底成绩」补足（保底配置值与 metric 同单位，内部同 ×1000）——
//   config={"metric":"time","desc":false,"beg":20,...,"floor":{"beg":10000,...}}
//   （floor score 域毫秒，缺省回退默认；n=0 该级别不计，也不补保底）。
//   兼容旧形态 {"beg":20,...}（无 metric → time；无 floor → 回默认保底）。
//   方向语义（desc=true）：取各级别**最好**（最大值）N 局，保底必须**小于**实盘
//   最小值才不倒挂；desc=false 与旧口径一致（最小 N 局，保底大于实盘最差）。
// · target_diff 目标求差：config={"metric":..,"desc":..,"target":8.88}（target
//   人类单位，内部 ×1000），玩家成绩 = 所有有效局中 |value − target| 最小一局的
//   误差（score 域），**恒越小越好**（打靶赛；方向只影响「哪局算最好」展示语义）。
// · 成绩只认 status!=0 且 no_record=0 且 value>0 的录像（同前台排名口径；
//   3bv/crossings 取 0/缺失的行视作无效自动跳过）。

import {
  fmtTourScore,
  parseTourDesc,
  parseTourMetric,
  TOUR_METRICS,
  type TourMetricKey,
} from "@/lib/tour-metric";

export type TournamentScoreMode = "" | "sum_topn" | "target_diff";

export const SCORE_MODE_LABELS: Record<string, string> = {
  "": "未配置（暂不计成绩）",
  sum_topn: "成绩加总（各级别最好 N 局求和）",
  target_diff: "目标成绩求差（与指定目标的最小误差）",
};

/** sum_topn 各级别保底成绩默认值——score 内部域（×1000）。
 *  time 惯例沿用 2026-11-18 定的 初 10s / 中 60s / 高 240s；其余项（值域完全
 *  不同的数据项）没有合理通配默认，回退「不补保底」（floor=0 → fill 不加值）。 */
const DEFAULT_SCORE_FLOOR_SCORE: Record<string, Record<string, number>> = {
  time: { beg: 10_000, int: 60_000, exp: 240_000 },
};

/** 数据项中文名 + 方向短语（描述/表单共用） */
function metricDirText(metric: TourMetricKey, desc: boolean): string {
  const name = TOUR_METRICS[metric].name;
  return `${name}（${desc ? "越大越好" : "越小越好"}）`;
}

export interface ParsedScoreConfig {
  /** 计分数据项（2026-11-21 起新增；旧配置回退 time） */
  metric: TourMetricKey;
  /** desc=true 越大越好（2026-11-21 起新增；缺省按项默认） */
  desc: boolean;
  topn: Record<string, number>;
  /** 保底成绩（score 内部域 = 落库×1000；time=毫秒）；仅 sum_topn 使用 */
  floor: Record<string, number>;
  /** target_diff 的目标（人类单位：time 秒 / 其余项原值） */
  target?: number;
}

/** 解析 score_config，非法/与 mode 不符回退 null（展示与计算共用入口）。
 *  兼容旧形态 {"beg":20,...}（无 metric → time；无 floor → 回默认保底） */
export function parseScoreConfig(mode: string, cfg: string): ParsedScoreConfig | null {
  if (!mode) return null;
  try {
    const o = JSON.parse(cfg) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return null;
    const metric = parseTourMetric(o.metric);
    const desc = parseTourDesc(metric, o.desc);
    if (mode === "sum_topn") {
      const topn: Record<string, number> = {};
      let any = false;
      for (const lv of ["beg", "int", "exp"]) {
        const n = Number(o[lv]);
        topn[lv] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        if (topn[lv] > 0) any = true;
      }
      if (!any) return null;
      const rawFloor = (o.floor ?? {}) as Record<string, unknown>;
      const floor: Record<string, number> = {};
      for (const lv of ["beg", "int", "exp"]) {
        const f = Number(rawFloor[lv]);
        floor[lv] =
          Number.isFinite(f) && f > 0
            ? Math.round(f)
            : (DEFAULT_SCORE_FLOOR_SCORE[metric]?.[lv] ?? 0);
      }
      return { metric, desc, topn, floor };
    }
    if (mode === "target_diff") {
      const t = Number(o.target);
      return Number.isFinite(t) && t > 0 ? { metric, desc, topn: {}, floor: {}, target: t } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** 计算方式人话描述（后台基本信息块/表单回显用） */
export function scoreModeDesc(mode: string, cfg: string): string {
  const c = parseScoreConfig(mode, cfg);
  if (mode === "sum_topn" && c) {
    // 两个方向下取的都是该方向上的**最好** N 局（computePlayerScores 按方向排序取最优端）
    const parts = (["beg", "int", "exp"] as const)
      .filter((lv) => c.topn[lv] > 0)
      .map((lv) => `${LEVEL_NAMES[lv]}${c.topn[lv]}局`);
    const floors = (["beg", "int", "exp"] as const)
      .filter((lv) => c.topn[lv] > 0)
      .map((lv) =>
        c.floor[lv]! > 0
          ? `${LEVEL_NAMES[lv]}保底${fmtTourScore(c.metric, c.floor[lv]!)}`
          : `${LEVEL_NAMES[lv]}不补保底`,
      );
    return `成绩加总：按${metricDirText(c.metric, c.desc)}取各级别最好 N 局求和 —— ${parts.length ? parts.join(" + ") : "未配置级别"}（${floors.join("，")}）`;
  }
  if (mode === "target_diff" && c) {
    return `目标求差：${metricDirText(c.metric, c.desc)}，目标 ${fmtTourScore(c.metric, c.target! * 1000)}，取误差最小一局`;
  }
  return SCORE_MODE_LABELS[mode] ?? "未配置";
}

/** 比赛成绩输入行：一张录像参加计分所需的全部数据。
 *  value=该录像在本比赛 metric 上的原值（score 内部域：time 毫秒，其余 ×1000），
 *  noRecord=运气盘标记，valid 与否由 computePlayerScores 统一判。 */
export interface TourScoreVideo {
  user: bigint | number;
  level: string;
  /** 计分数据项原值（score 域；time=毫秒，其余=落库×1000） */
  value: number;
  noRecord: boolean;
  /** 录像 id（2026-11-24 练习页比赛统计格逐盘 hover 用；可选——排行榜等调用点
   *  不消费明细，不传亦可；仅 getMyScoreValues 透传真实 id） */
  vid?: number;
}

/** 旧字段名兼容别名：realTime → value（历史调用点迁移期共存） */
export type TourScoreVideoLegacy = TourScoreVideo;

/** 比赛统计格逐盘明细（2026-11-24 张老师需求）：每级别选入计分的实盘，
 *  按成绩从好到差排序（与 sum_topn 取 N 盘完全同源）——练习页底部统计格
 *  默认展示「该级别成绩最好的 N 盘」，hover 显示该盘成绩。
 *  ⚠️ 与 calc[].real 严格一致：videos.length === real（运气盘/限界外已过滤）。 */
export interface ScoreVideoDetail {
  lv: string;
  videos: { vid: number; value: number }[];
}

export interface PlayerScore {
  /** 总成绩（score 内部域；desc=true 时「越大越好」——展示/排序端按 conf.desc 解释）；
   *  target_diff 恒为最小误差（越小越好） */
  score: number;
  /** sum_topn 明细：各级别实盘加总（0=无实盘）与补保底盘数 */
  parts: Record<string, number>;
  /** 各级别补保底局数（实盘数 < N 时） */
  filled: Record<string, number>;
  /** 计算过程（2026-11-18 晚张老师定：hover 成绩气泡展示；每级别一条） */
  calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[];
  /** 逐盘明细（2026-11-24；仅练习页比赛统计格消费；target_diff/纯保底恒空） */
  detail: ScoreVideoDetail[];
}

/** 批量计算玩家成绩：Map<uid, PlayerScore>，无有效录像且无需保底的玩家不在 Map。
 *  sum_topn：各级别按方向取 N 局求和（desc=true 取最大 N 局，否则最小 N 局）；
 *  不足 N 局用保底成绩补足差额局数——desc=false 时保底恒**大于**实盘最差、
 *  desc=true 时保底恒**小于**实盘最差才有意义（方向倒挂会让补足反向拉低总分），
 *  配置端须保证；value≤0 视为无效行跳过。
 *  includeLevels（2026-11-21 张老师 niu1 反馈「成绩无法解释」根治）：比赛收录级别之外的
 *  级别**完全不参与计分**（不取实盘、不补保底）——旧配置常带表单默认 beg:1/exp:1，
 *  比赛只收中级时初级/高级一盘都不可能有，却按保底凭空加 10s+240s＝总分不可解释。 */
export function computePlayerScores(
  mode: string,
  cfg: string,
  vids: TourScoreVideo[],
  includeLevels?: readonly string[]
): Map<number, PlayerScore> {
  const conf = parseScoreConfig(mode, cfg);
  const out = new Map<number, PlayerScore>();
  if (!conf) return out;
  const lvAllowed = includeLevels ? new Set(includeLevels) : null;
  const lvOn = (lv: string): boolean => !lvAllowed || lvAllowed.has(lv);
  const valid = vids.filter((v) => v.value > 0 && !v.noRecord && lvOn(v.level));
  if (mode === "sum_topn") {
    const desc = conf.desc;
    // 各级别最好/最差 N 局加总（跨级别累加），不足 N 局补保底
    // 逐盘保留 vid（2026-11-24）：与 value 成对，排序取 N 后产出明细；
    // 无 vid 的调用点（排行榜等不消费明细）用 0 占位，不影响算分
    const byUserLevel = new Map<number, Map<string, { value: number; vid: number }[]>>();
    for (const v of valid) {
      const n = conf.topn[v.level] ?? 0;
      if (n <= 0) continue;
      const uid = Number(v.user);
      if (!byUserLevel.has(uid)) byUserLevel.set(uid, new Map());
      const m = byUserLevel.get(uid)!;
      if (!m.has(v.level)) m.set(v.level, []);
      m.get(v.level)!.push({ value: v.value, vid: v.vid ?? 0 });
    }
    for (const [uid, levels] of byUserLevel) {
      let sum = 0;
      const parts: Record<string, number> = {};
      const filled: Record<string, number> = {};
      const calc: PlayerScore["calc"] = [];
      const detail: ScoreVideoDetail[] = [];
      for (const lv of ["beg", "int", "exp"] as const) {
        const n = conf.topn[lv] ?? 0;
        if (n <= 0 || !lvOn(lv)) continue;
        const vals = (levels.get(lv) ?? []).slice().sort((a, b) => (desc ? b.value - a.value : a.value - b.value));
        const picked = vals.slice(0, n); // 选入计分的 N 盘（按成绩从好到差）
        const real = picked.reduce((a, b) => a + b.value, 0);
        const fill = Math.max(n - vals.length, 0);
        parts[lv] = real;
        filled[lv] = fill;
        const floorScore = conf.floor[lv] ?? 0;
        sum += real + fill * floorScore;
        calc.push({ lv, n, real, fill, floorScore });
        detail.push({ lv, videos: picked.map((v) => ({ vid: v.vid, value: v.value })) });
      }
      out.set(uid, { score: sum, parts, filled, calc, detail });
    }
    return out;
  }
  if (mode === "target_diff") {
    const targetScore = (conf.target ?? 0) * 1000;
    for (const v of valid) {
      const uid = Number(v.user);
      const err = Math.abs(v.value - targetScore);
      if (!out.has(uid) || err < out.get(uid)!.score) {
        out.set(uid, { score: err, parts: {}, filled: {}, calc: [], detail: [] });
      }
    }
    return out;
  }
  return out;
}

/** 各玩家「当前总分出现时刻」（同分决胜用，2026-11-27 张老师定：总分相同按总分
 *  出现先后排，先出现者排前——后打出者理论准备时间更充分，先打出的含金量更高）。
 *  sum_topn/target_diff 的总分都随有效盘单调向好收敛，当前总分首次出现的时刻＝
 *  最后一次总分变化的录像上传时刻。逐人按时间序做前缀算分、从后向前找最后一个
 *  改变总分的盘（比赛规模小，逐人 O(n²) 可忽略）。无有效盘（纯保底补算）的玩家
 *  不在 Map——决胜时由 compareTourScores 视为排在所有有盘玩家之后。 */
export function scoreAppearTimes(
  mode: string,
  cfg: string,
  vids: (TourScoreVideo & { t: number })[],
  includeLevels?: readonly string[]
): Map<number, number> {
  const out = new Map<number, number>();
  if (!parseScoreConfig(mode, cfg)) return out;
  const lvAllowed = includeLevels ? new Set(includeLevels) : null;
  const lvOn = (lv: string): boolean => !lvAllowed || lvAllowed.has(lv);
  const byUser = new Map<number, (TourScoreVideo & { t: number })[]>();
  for (const v of vids) {
    if (!(v.value > 0) || v.noRecord || !lvOn(v.level)) continue;
    const uid = Number(v.user);
    const list = byUser.get(uid);
    if (list) list.push(v);
    else byUser.set(uid, [v]);
  }
  for (const [uid, list] of byUser) {
    const asc = list.slice().sort((a, b) => a.t - b.t);
    const final = computePlayerScores(mode, cfg, asc, includeLevels).get(uid);
    if (!final) continue;
    for (let k = asc.length; k >= 1; k--) {
      const s = computePlayerScores(mode, cfg, asc.slice(0, k), includeLevels).get(uid);
      if (s && s.score !== final.score) {
        out.set(uid, asc[k]!.t); // 下标 k 的盘是最后一个改变总分的盘
        break;
      }
    }
    if (!out.has(uid)) out.set(uid, asc[0]!.t); // 首盘即达最终总分
  }
  return out;
}

/** 排行同分决胜比较器（2026-11-27 张老师定）：总分相同按**总分出现先后**排——
 *  先出现者排前（后打出者理论准备时间更充分，先打出的含金量更高）；出现时刻
 *  也相同（同秒批量导入等极端情形）视为并列，不再比级别分量（张老师 19:04 定：
 *  中高级比拼多余且耗性能，已删）。
 *  ta/tb=双方总分出现时刻（scoreAppearTimes 产出）；undefined=纯保底无盘玩家，
 *  恒排在有盘玩家之后。返回负数=a 排前。排行榜/我的名次/参赛记录最高名次/
 *  后台玩家列表全部走此函数（单一口径）。 */
export function compareTourScores(
  a: PlayerScore,
  b: PlayerScore,
  desc: boolean,
  ta?: number,
  tb?: number
): number {
  if (a.score !== b.score) return desc ? b.score - a.score : a.score - b.score;
  if (ta === undefined && tb === undefined) return 0; // 双方都无盘（纯保底）→ 并列
  if (ta === undefined) return 1; // 本人无盘（纯保底）→ 排后
  if (tb === undefined) return -1;
  return ta - tb; // 总分出现早者排前；同秒并列
}

/** 成绩展示（2026-11-21 起按 metric 折算；兼容旧签名 fmtScoreMs(ms)＝time 口径） */
export function fmtScoreMs(ms: number): string {
  const str = (ms / 1000).toFixed(3).replace(/\.?0+$/, "");
  return `${str}s`;
}

/** 旧调用点兼容：TourScoreVideo.realTime 访问器已移除——构造处统一改名 value。
 *  （本函数仅为类型层提示保留，无运行时行为） */
export const _TOUR_SCORE_VALUE_FIELD = "value";
