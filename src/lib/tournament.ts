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
import { getVideosByIds, type VideoListItem } from "@/lib/queries";
import { dualTitles } from "@/lib/title-system";
import { LEVELS, LEVEL_NAMES, type Level } from "@/lib/config";

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
  joined: boolean; // 当前登录用户是否已报名
  levels: Level[]; // 收录录像级别（张老师 2026-11-13：可多选，默认初中高都有）
  /** 自选窗口时长（小时，0=同期集体赛；>0=窗口赛，张老师 2026-11-19） */
  windowHours: number;
  /** 我的进行中窗口会话（窗口赛已手动开赛；null=未开赛/无窗口） */
  mySession: { race: string; start: number; end: number } | null;
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
  /** 纪录图表散点（详情页形态填充：按比赛设定总分排名前 30，score 秒；列表形态为空数组） */
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
  // 当前页每场已开赛的比赛取排名前 30 散点（带我的名次标记数据），并行拉取
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(page, 1), totalPages);
  const pageRows = rows.slice((p - 1) * size, p * size);
  const chartTargets = pageRows.filter((r) => r.status !== "upcoming");
  const chartList = await Promise.all(chartTargets.map((r) => getTourRanking(Number(r.id), 30)));
  const chartMap = new Map<string, { rank: number; score: number; name?: string; uid?: number; englishName?: string; sex?: number; title?: string; classic?: { name: string; color: string } | null }[]>();
  const bestMap = new Map<string, TourRow["bestLine"]>();
  chartTargets.forEach((r, i) => {
    const list = chartList[i];
    chartMap.set(
      r.id,
      list.map((x) => ({
        rank: x.rank,
        score: x.time / 1000,
        name: x.name,
        uid: x.uid,
        englishName: x.englishName,
        sex: x.sex,
        title: x.title,
        classic: x.classic,
      })),
    );
    const first = list[0];
    bestMap.set(
      r.id,
      first
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
      const nowB = BigInt(now);
      const sessions = await prisma.tournamentWindowSession.findMany({
        where: { tournamentId: { in: pageWindowIds }, userId: BigInt(uid), endTime: { gt: nowB } },
        select: { tournamentId: true, race: true, startTime: true, endTime: true },
        orderBy: { endTime: "desc" },
      });
      const sessMap = new Map(sessions.map((s) => [s.tournamentId.toString(), s]));
      for (const r of pageRows) {
        const s = sessMap.get(r.id);
        if (s) r.mySession = { race: s.race, start: Number(s.startTime), end: Number(s.endTime) };
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
  participants: number; // 参赛人数（去重用户）
  videos: number; // 录像数量（成绩采集下一期接入，恒 0）
  prizeTotal: number; // 累计奖金（全站总奖金之和）
}

export async function getTourGlobalStats(): Promise<TourGlobalStats> {
  const [tournaments, participants, prizeAgg, videos] = await Promise.all([
    prisma.tournament.count(),
    prisma.tournamentEntry.groupBy({ by: ["userId"], where: {} }).then((g) => g.length),
    prisma.tournament.aggregate({ _sum: { prizeTotal: true } }),
    // 挂接到比赛的录像数（2026-11-13 二期起有真实数据源：后台手动挂接）
    prisma.video.count({ where: { tournamentId: { not: null }, status: { not: 0 } } }),
  ]);
  return {
    tournaments,
    participants,
    videos,
    prizeTotal: prizeAgg._sum.prizeTotal ?? 0,
  };
}

export interface TourMyStats {
  joined: number; // 参加比赛次数（已报名数）
  bestRank: number | null; // 最高排名（成绩采集下一期接入）
  prize: number; // 累计奖金（成绩采集下一期接入）
}

export async function getTourMyStats(uid: number): Promise<TourMyStats> {
  const joined = await prisma.tournamentEntry.count({ where: { userId: BigInt(uid) } });
  return { joined, bestRank: null, prize: 0 }; // TODO 成绩采集期接入：bestRank / prize
}

// ---------- 动态（2026-11-13 二期：详情页「动态」板块）----------

export const TOUR_EVENT_JOIN_OPEN = 1; // 报名开始
export const TOUR_EVENT_PLAYER_JOIN = 2; // 玩家报名参加
export const TOUR_EVENT_STARTED = 3; // 比赛正式开始
export const TOUR_EVENT_SCORE = 4; // 玩家更新成绩
export const TOUR_EVENT_ENDED = 5; // 比赛正式结束

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
    default:
      return "";
  }
}

/** 写一条动态（报名/挂录像走此入口；开始/结束走 ensureTourLifecycleEvents 惰性补写） */
export async function addTourEvent(
  tournamentId: number,
  type: number,
  userId = 0
): Promise<void> {
  await prisma.tournamentEvent.create({
    data: {
      tournamentId: BigInt(tournamentId),
      type,
      userId: BigInt(userId),
      createTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
}

/**
 * 惰性补写「比赛正式开始 / 比赛正式结束」动态：now 越过起止时刻且该事件尚不存在时补一条。
 * 列表页与详情页渲染期各调一次（行数 ≤ 页内比赛数，两次 findFirst 走 (tournament_id,id)
 * 索引，开销可忽略）——不依赖定时器，重启/停机不漏事件。
 */
export async function ensureTourLifecycleEvents(
  c: { id: bigint | number | string; startTime: bigint | number; endTime: bigint | number },
  now: number
): Promise<void> {
  const cid = BigInt(c.id);
  const start = Number(c.startTime);
  const end = Number(c.endTime);
  if (now >= start) {
    const hit = await prisma.tournamentEvent.findFirst({
      where: { tournamentId: cid, type: TOUR_EVENT_STARTED },
      select: { id: true },
    });
    if (!hit) await addTourEvent(Number(c.id), TOUR_EVENT_STARTED);
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
    if (!hit) await addTourEvent(Number(c.id), TOUR_EVENT_ENDED);
  }
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
  pageSize = 20
): Promise<{ rows: TourEventRow[]; total: number; page: number; pageSize: number }> {
  const cid = BigInt(tournamentId);
  // 全量取出本比赛动态（比赛量级十场、单场动态几千条，内存归并最直白；
  // 跨批合并/总成绩进度都无法在 SQL 一层表达）。
  // 2026-11-19 张老师定：type=1 报名开始动态废弃——查询层直接排除（每场一条无信息量）
  const all = await prisma.tournamentEvent.findMany({
    where: { tournamentId: cid, type: { not: TOUR_EVENT_JOIN_OPEN } },
    orderBy: [{ createTime: "asc" }, { id: "asc" }],
  });
  const scoreEv = all.filter((e) => e.type === TOUR_EVENT_SCORE);
  const uids = [...new Set(scoreEv.map((e) => Number(e.userId)).filter((x) => x > 0))];
  // 一次取全部成绩动态玩家的窗口内录像（总成绩进度计算的数据源）
  const vids = uids.length
    ? await prisma.video.findMany({
        where: { tournamentId: cid, status: { not: 0 }, user: { in: uids.map((s) => BigInt(s)) } },
        select: { id: true, user: true, level: true, createTime: true },
      })
    : [];
  const comp = await prisma.tournament.findUnique({
    where: { id: cid },
    select: { scoreMode: true, scoreConfig: true },
  });
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
  // 按玩家归并：每条成绩动态 → 该玩家截至该时刻的录像集
  const vidsByUser = new Map<number, typeof vids>();
  for (const v of vids) {
    const uid = Number(v.user);
    if (!vidsByUser.has(uid)) vidsByUser.set(uid, []);
    vidsByUser.get(uid)!.push(v);
  }
  // 成绩动态合并：同人相邻事件间隔 ≤ 600 秒视为同一批（连传）；批内取最新时刻为行时刻
  const BATCH_WINDOW_SEC = 600;
  type Merged = {
    userId: number;
    /** 行时刻 = 批内最新事件时刻 */
    createTime: number;
    /** 批内事件数（动态条数） */
    evCount: number;
    /** 批内新盘 id 集（时刻落在 (批首事件−窗口, 批末事件] 的录像） */
    batchVideoIds: number[];
    /** 批首事件时刻（总成绩进度取「批末事件时刻」口径） */
    firstTime: number;
    /** 批末事件时刻 */
    lastTime: number;
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
        cur = { userId: uid, createTime: t, evCount: 1, batchVideoIds: [], firstTime: t, lastTime: t, minId: Number(e.id) };
      }
    }
    if (cur) merged.push(cur);
  }
  // 批内新盘：该玩家录像中上传时刻 ∈ (上一批 lastTime, 本批 lastTime]
  for (const m of merged) {
    const prev = merged.find((x) => x.userId === m.userId && x.lastTime < m.lastTime);
    const from = prev ? prev.lastTime : m.firstTime - BATCH_WINDOW_SEC - 1;
    const pool = vidsByUser.get(m.userId) ?? [];
    m.batchVideoIds = pool
      .filter((v) => Number(v.createTime) > from && Number(v.createTime) <= m.lastTime)
      .map((v) => Number(v.id));
    m.minId = Math.min(m.minId, ...m.batchVideoIds.slice(0, 1), m.minId);
  }
  // 总成绩进度：截至每批 lastTime 的窗口内录像按比赛设定算总分
  const progressBy = new Map<string, { total: number | null; batchBest: number | null }>();
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
    );
    const mine = scores.get(m.userId);
    // 批内最好单盘（按 metric/方向）：desc=true 取最大，否则取最小；无效行 0 跳过
    const batchVals = m.batchVideoIds.map((vid) => metricValueOf(vid as unknown as bigint)).filter((t) => t > 0);
    progressBy.set(`${m.userId}@${m.lastTime}`, {
      total: mine ? mine.score : null,
      batchBest: batchVals.length ? (tourConf?.desc ? Math.max(...batchVals) : Math.min(...batchVals)) : null,
    });
  }
  // 官方/报名事件行也并入时间线（与合并后的成绩行一起排序）
  const otherRows = all
    .filter((e) => e.type !== TOUR_EVENT_SCORE)
    .map((e) => ({
      userId: Number(e.userId),
      createTime: Number(e.createTime),
      evCount: 1,
      type: e.type,
      minId: Number(e.id),
    }));
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
  };
  const rows: Row[] = [];
  // 成绩合并行 + 提升幅度（与该玩家上一批的总成绩比）
  // 2026-11-19 张老师定：成绩不变不发动态——该批上传后总成绩与上一批相同（无新有效成绩
  // 或新盘都没进各级别最好 N 局）则整行吞掉；×N 盘数标注废弃（没有信息量）
  const lastTotalBy = new Map<number, number | null>();
  for (const m of merged) {
    const key = `${m.userId}@${m.lastTime}`;
    const prog = progressBy.get(key)!;
    const prev = lastTotalBy.get(m.userId);
    const firstEver = prev === undefined;
    const improved =
      prog.total !== null && (firstEver || prev === null || prog.total < prev);
    if (!improved) {
      // 成绩不变/退步（理论上不会退）→ 不发动态行；仍要维护 lastTotal 口径
      if (!firstEver) lastTotalBy.set(m.userId, prog.total ?? prev ?? null);
      else lastTotalBy.set(m.userId, prog.total);
      continue;
    }
    rows.push({
      sortKey: m.lastTime,
      type: TOUR_EVENT_SCORE,
      userId: m.userId,
      createTime: m.lastTime,
      evCount: m.evCount,
      minId: m.minId,
      total: prog.total,
      batchBest: prog.batchBest,
      prevTotal: prev === undefined ? null : prev,
    });
    lastTotalBy.set(m.userId, prog.total);
  }
  for (const o of otherRows) {
    rows.push({
      sortKey: o.createTime,
      type: o.type,
      userId: o.userId,
      createTime: o.createTime,
      evCount: o.evCount,
      minId: o.minId,
      total: null,
      batchBest: null,
      prevTotal: null,
    });
  }
  rows.sort((a, b) => b.sortKey - a.sortKey || b.minId - a.minId);
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

/** 排行榜（张老师 2026-11-18 定：按比赛设定计算成绩排序，不再按单盘最好成绩）——
 *  sum_topn：窗口内录像按 computePlayerScores 同口径算总分（不足 N 局补保底），
 *  videoId 取该玩家窗口内最好一局（按 metric/方向取「最好」）；target_diff 同口径取最小误差。
 *  排序：desc=true 越大越好（总分降序），否则升序。 */
export async function getTourRanking(compId: number, limit = 10): Promise<TourRankRow[]> {
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true, scoreMode: true, scoreConfig: true },
  });
  if (!comp) return [];
  const conf = parseScoreConfig(comp.scoreMode, comp.scoreConfig);
  const metric = conf?.metric ?? "time";
  const desc = conf?.desc ?? false;
  // Video/VideoInfo 同 id 1:1 但 schema 无 relation，成绩字段分表取
  const rows = await prisma.video.findMany({
    where: {
      tournamentId: BigInt(compId),
      status: { not: 0 },
      createTime: { gte: comp.startTime, lte: comp.endTime },
    },
    select: { id: true, user: true, level: true },
  });
  if (!rows.length) return [];
  const levelMap = new Map(rows.map((r) => [r.id, r.level]));
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const needsMetrics = metric !== "time" && metric !== "3bv";
  const metricsRows = needsMetrics
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: { id: true, bvs: true, ioe: true, thrp: true, cp: true },
      })
    : [];
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
  const scores = computePlayerScores(
    comp.scoreMode,
    comp.scoreConfig,
    rows.map((r) => ({
      user: r.user,
      level: levelMap.get(r.id) ?? "",
      value: metricValueOf(r.id),
      noRecord: infoMap.get(r.id)?.noRecord ?? false,
    })),
  );
  if (!scores.size) return [];
  // 代表盘 = 该玩家窗口内最好一局（按 metric/方向；总成绩是多盘合成，链接供看最好盘）
  const bestBy = new Map<number, { time: number; videoId: number }>();
  for (const r of rows) {
    const v = metricValueOf(r.id);
    if (!v) continue;
    const uid = Number(r.user);
    const prev = bestBy.get(uid);
    if (!prev || (desc ? v > prev.time : v < prev.time)) bestBy.set(uid, { time: v, videoId: Number(r.id) });
  }
  const sorted = [...scores.entries()]
    .sort((a, b) => (desc ? b[1].score - a[1].score : a[1].score - b[1].score))
    .slice(0, limit);
  const uids = sorted.map(([uid]) => BigInt(uid));
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
  return sorted.map(([uid, s], i) => ({
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
 *  race 精确优先，退签名末尾；都不在窗内 → 不绑定。 */
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
  // 签名后缀命中（同一窗口判据）
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

export interface TourMyResult {
  joined: boolean;
  videos: number; // 我的参赛录像数
  bestTime: number | null; // 我的最好单盘（score 域，按 metric/方向取「最好」）
  rank: number | null; // 在最新排名中的名次（全量排名内）
}

/** 我在这场比赛的成绩（详情页「我的成绩」板块）。
 *  成绩口径（张老师 2026-11-18）：bestTime=窗口内最好一局（单盘口径，按比赛
 *  metric/方向取「最好」）；rank=按比赛设定总分口径的名次（与排行榜同口径）。 */
export async function getTourMyResult(compId: number, uid: number): Promise<TourMyResult> {
  const joined = await prisma.tournamentEntry.findFirst({
    where: { tournamentId: BigInt(compId), userId: BigInt(uid) },
    select: { id: true },
  });
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true, scoreMode: true, scoreConfig: true },
  });
  const conf = parseScoreConfig(comp?.scoreMode ?? "", comp?.scoreConfig ?? "");
  const metric = conf?.metric ?? "time";
  const desc = conf?.desc ?? false;
  // Video/VideoInfo 无 relation，成绩字段分表取（同 getTourRanking）
  const rows = await prisma.video.findMany({
    where: {
      tournamentId: BigInt(compId),
      user: BigInt(uid),
      status: { not: 0 },
      ...(comp ? { createTime: { gte: comp.startTime, lte: comp.endTime } } : {}),
    },
    select: { id: true },
  });
  const myInfos = await prisma.videoInfo.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true, realTime: true, board3bv: true, noRecord: true },
  });
  const infoMap = new Map(myInfos.map((i) => [i.id, i]));
  const needsMetrics = metric !== "time" && metric !== "3bv";
  const myMetrics = needsMetrics
    ? await prisma.videoMetrics.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
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
  for (const r of rows) {
    const v = metricValueOf(r.id);
    if (!v) continue;
    if (bestTime === null || (desc ? v > bestTime : v < bestTime)) bestTime = v;
  }
  let rank: number | null = null;
  if (bestTime !== null) {
    // 名次按比赛设定总分（getTourRanking 全量版）：取全部玩家的 computePlayerScores，
    // desc=true 时「更好」= 严格更大，否则严格更小
    const all = await prisma.video.findMany({
      where: {
        tournamentId: BigInt(compId),
        status: { not: 0 },
        ...(comp ? { createTime: { gte: comp.startTime, lte: comp.endTime } } : {}),
      },
      select: { id: true, user: true },
    });
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
    const scores = computePlayerScores(
      comp?.scoreMode ?? "",
      comp?.scoreConfig ?? "",
      all.map((r) => ({
        user: r.user,
        level: levelMap.get(r.id) ?? "",
        value: allValueOf(r.id),
        noRecord: infoById.get(r.id)?.noRecord ?? false,
      })),
    );
    const mine = scores.get(uid);
    rank = mine
      ? 1 + [...scores.values()].filter((s) => (desc ? s.score > mine.score : s.score < mine.score)).length
      : null;
  }
  return { joined: !!joined, videos: rows.length, bestTime, rank };
}

/** 比赛详情页统计（张老师 2026-11-19 定：报名人数与参赛人数分开统计，不冲突）——
 *  registrations=报名人数（tournament_entry 去重 user；为 0 时前台整行不显示，
 *  历届导入的旧比赛不存在统计误差）；entries=参赛人数＝实际传了录像的持有者数
 *  （distinct user）；videos=参赛录像数（挂接且未屏蔽） */
export async function getTourDetailStats(
  compId: number
): Promise<{ registrations: number; entries: number; videos: number }> {
  const [regRows, holders] = await Promise.all([
    prisma.tournamentEntry.findMany({
      where: { tournamentId: BigInt(compId) },
      select: { userId: true },
    }),
    prisma.video.findMany({
      where: { tournamentId: BigInt(compId), status: { not: 0 } },
      select: { user: true },
    }),
  ]);
  const videos = holders.length;
  return {
    registrations: new Set(regRows.map((r) => r.userId.toString())).size,
    entries: new Set(holders.map((h) => h.user.toString())).size,
    videos,
  };
}

/** 比赛录像分页（详情页「录像」板块）：按时间正序（早在前，张老师 14:45 口径「按时间顺序」），
 *  展示形式与首页录像流一致（VideoRows 行渲染），但按比赛过滤、不去重 */
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
  }
): Promise<{ videos: VideoListItem[]; total: number; page: number; pageSize: number }> {
  const base: Record<string, unknown> = { tournamentId: BigInt(compId), status: { not: 0 } };
  if (opts?.author) base.user = BigInt(opts.author);
  // 成绩/3BV 搜索需要关联 video_info——先按 info 表筛 id（同 /video 列表口径）
  let idFilter: bigint[] | null = null;
  if (opts?.time || opts?.bv) {
    const infoWhere: Record<string, unknown> = {};
    if (opts.time) infoWhere.realTime = { gte: Math.round(opts.time * 1000) };
    if (opts.bv) infoWhere.board3bv = { gte: opts.bv };
    const hits = await prisma.videoInfo.findMany({
      where: infoWhere,
      select: { id: true },
    });
    idFilter = hits.map((h) => h.id);
    base.id = { in: idFilter };
  }
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
            orderBy: [{ createTime: "asc" }, { id: "asc" }],
            skip: (p - 1) * pageSize,
            take: pageSize,
          })
        ).map((r) => Number(r.id));
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
  const [entryCount, creator, scoreRow, joined] = await Promise.all([
    prisma.tournamentEntry.count({ where: { tournamentId: c.id } }),
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
  // 排名的散点——复用 getTourRanking 全量口径，取前 30 名（score 秒）；无成绩比赛为空。
  // 图表上方「最好成绩」行 = 第一名（总分口径）
  const rankRows =
    c.startTime <= now
      ? await getTourRanking(id, 30)
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
        // 「创造于」= 该玩家窗口内最早一盘的上传时刻
        at: await (async () => {
          const v = await prisma.video.findFirst({
            where: {
              tournamentId: BigInt(id),
              user: BigInt(first.uid),
              status: { not: 0 },
              createTime: { gte: c.startTime, lte: c.endTime },
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
    // 我的进行中窗口（窗口赛已手动开赛；登录态查询）
    mySession: uid
      ? await (async () => {
          const nowB = BigInt(now);
          const s = await prisma.tournamentWindowSession.findFirst({
            where: { tournamentId: c.id, userId: BigInt(uid), endTime: { gt: nowB } },
            select: { race: true, startTime: true, endTime: true },
            orderBy: { endTime: "desc" },
          });
          return s ? { race: s.race, start: Number(s.startTime), end: Number(s.endTime) } : null;
        })()
      : null,
    entryCount,
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
}

/** 旧字段名兼容别名：realTime → value（历史调用点迁移期共存） */
export type TourScoreVideoLegacy = TourScoreVideo;

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
}

/** 批量计算玩家成绩：Map<uid, PlayerScore>，无有效录像且无需保底的玩家不在 Map。
 *  sum_topn：各级别按方向取 N 局求和（desc=true 取最大 N 局，否则最小 N 局）；
 *  不足 N 局用保底成绩补足差额局数——desc=false 时保底恒**大于**实盘最差、
 *  desc=true 时保底恒**小于**实盘最差才有意义（方向倒挂会让补足反向拉低总分），
 *  配置端须保证；value≤0 视为无效行跳过。 */
export function computePlayerScores(
  mode: string,
  cfg: string,
  vids: TourScoreVideo[]
): Map<number, PlayerScore> {
  const conf = parseScoreConfig(mode, cfg);
  const out = new Map<number, PlayerScore>();
  if (!conf) return out;
  const valid = vids.filter((v) => v.value > 0 && !v.noRecord);
  if (mode === "sum_topn") {
    const desc = conf.desc;
    // 各级别最好/最差 N 局加总（跨级别累加），不足 N 局补保底
    const byUserLevel = new Map<number, Map<string, number[]>>();
    for (const v of valid) {
      const n = conf.topn[v.level] ?? 0;
      if (n <= 0) continue;
      const uid = Number(v.user);
      if (!byUserLevel.has(uid)) byUserLevel.set(uid, new Map());
      const m = byUserLevel.get(uid)!;
      if (!m.has(v.level)) m.set(v.level, []);
      m.get(v.level)!.push(v.value);
    }
    for (const [uid, levels] of byUserLevel) {
      let sum = 0;
      const parts: Record<string, number> = {};
      const filled: Record<string, number> = {};
      const calc: PlayerScore["calc"] = [];
      for (const lv of ["beg", "int", "exp"] as const) {
        const n = conf.topn[lv] ?? 0;
        if (n <= 0) continue;
        const vals = (levels.get(lv) ?? []).sort((a, b) => (desc ? b - a : a - b));
        const real = vals.slice(0, n).reduce((a, b) => a + b, 0);
        const fill = Math.max(n - vals.length, 0);
        parts[lv] = real;
        filled[lv] = fill;
        const floorScore = conf.floor[lv] ?? 0;
        sum += real + fill * floorScore;
        calc.push({ lv, n, real, fill, floorScore });
      }
      out.set(uid, { score: sum, parts, filled, calc });
    }
    return out;
  }
  if (mode === "target_diff") {
    const targetScore = (conf.target ?? 0) * 1000;
    for (const v of valid) {
      const uid = Number(v.user);
      const err = Math.abs(v.value - targetScore);
      if (!out.has(uid) || err < out.get(uid)!.score) {
        out.set(uid, { score: err, parts: {}, filled: {}, calc: [] });
      }
    }
    return out;
  }
  return out;
}

/** 成绩展示（2026-11-21 起按 metric 折算；兼容旧签名 fmtScoreMs(ms)＝time 口径） */
export function fmtScoreMs(ms: number): string {
  const str = (ms / 1000).toFixed(3).replace(/\.?0+$/, "");
  return `${str}s`;
}

/** 旧调用点兼容：TourScoreVideo.realTime 访问器已移除——构造处统一改名 value。
 *  （本函数仅为类型层提示保留，无运行时行为） */
export const _TOUR_SCORE_VALUE_FIELD = "value";
