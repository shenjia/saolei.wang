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
  creatorId: number; // 发起人（图表下方玩家卡片式名字展示：性别+军衔）
  creatorEnglishName: string;
  creatorSex: number;
  creatorTitle: string; // 军衔制称号
  creatorClassic: { name: string; color: string } | null; // 旧版称号备选
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
      entryCount: countMap.get(cid) ?? 0,
      joined: mineSet.has(cid),
      levels: parseLevels(c.includeLevels),
      creatorId: Number(c.creatorId),
      creatorEnglishName: creatorMap.get(c.creatorId.toString())?.englishName ?? "",
      creatorSex: creatorMap.get(c.creatorId.toString())?.sex ?? 1,
      creatorTitle: titleMap.get(c.creatorId.toString())?.m ?? "",
      creatorClassic: titleMap.get(c.creatorId.toString())?.c ?? null,
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

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(page, 1), totalPages);
  return {
    rows: rows.slice((p - 1) * size, p * size),
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
    详情页 RSC 与 TourEventsFeed 客户端壳共用（2026-11-13 五轮翻页改版） */
export function compEventText(type: number): string {
  switch (type) {
    case TOUR_EVENT_JOIN_OPEN:
      return "报名开始";
    case TOUR_EVENT_PLAYER_JOIN:
      return "报名参加了比赛";
    case TOUR_EVENT_STARTED:
      return "比赛正式开始";
    case TOUR_EVENT_SCORE:
      return "更新了成绩";
    case TOUR_EVENT_ENDED:
      return "比赛正式结束";
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
}

/** 比赛动态分页：最新在前（与全站动态流口径一致） */
export async function getTourEventsPage(
  tournamentId: number,
  page: number,
  pageSize = 20
): Promise<{ rows: TourEventRow[]; total: number; page: number; pageSize: number }> {
  const cid = BigInt(tournamentId);
  const total = await prisma.tournamentEvent.count({ where: { tournamentId: cid } });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(page, 1), totalPages);
  const events =
    total === 0
      ? []
      : await prisma.tournamentEvent.findMany({
          where: { tournamentId: cid },
          orderBy: [{ id: "desc" }],
          skip: (p - 1) * pageSize,
          take: pageSize,
        });
  const uids = [...new Set(events.map((e) => Number(e.userId)).filter((x) => x > 0))];
  const users = uids.length
    ? await prisma.user.findMany({
        where: { id: { in: uids.map((s) => BigInt(s)) } },
        select: { id: true, chineseName: true },
      })
    : [];
  const nameMap = new Map(users.map((u) => [Number(u.id), u.chineseName]));
  return {
    rows: events.map((e) => ({
      id: Number(e.id),
      type: e.type,
      userName: Number(e.userId) > 0 ? nameMap.get(Number(e.userId)) ?? `UID ${e.userId}` : null,
      userId: Number(e.userId) > 0 ? Number(e.userId) : null,
      createTime: Number(e.createTime),
    })),
    total,
    page: p,
    pageSize,
  };
}

// ---------- 参赛录像与排名（本期口径：成绩＝video_info.real_time，管理员后台挂接）----------

export interface TourRankRow {
  rank: number;
  uid: number;
  name: string;
  time: number; // 最好成绩（毫秒，real_time）
  videoId: number;
}

// ---------- 自动绑定（张老师 2026-11-18：上传/开源网导入按标识自动挂比赛）----------
//
// 与批量回填同口径：race=code（EVF 内嵌标识，硬证据，不限窗）；
// race 为空时退「签名末尾=code 且上传时间在比赛窗口内」。命中多场取 id 最小（奇异撞码极罕见）。

/** 按比赛标识匹配比赛：race 精确优先，退签名末尾+窗口。返回 tournament.id 或 null */
export async function matchTourByRace(
  race: string | null | undefined,
  signature: string,
  createTimeSec: number
): Promise<number | null> {
  if (race) {
    const hit = await prisma.tournament.findFirst({
      where: { code: race },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (hit) return Number(hit.id);
  }
  const sig = signature.trim();
  if (!sig) return null;
  // 签名后缀命中：窗口由 create_time 推导（上传时刻），与回填 SQL 同判据
  const candidates = await prisma.tournament.findMany({
    where: {
      code: { not: null },
      startTime: { lte: BigInt(Math.floor(createTimeSec)) },
      endTime: { gte: BigInt(Math.floor(createTimeSec)) },
    },
    select: { id: true, code: true },
    orderBy: { id: "asc" },
  });
  for (const c of candidates) {
    if (c.code && sig.endsWith(c.code)) return Number(c.id);
  }
  return null;
}

/** 最新排名：挂接录像按玩家取最好成绩（real_time 最小），升序取前 limit 名。
 *  注意：跨级别混排的公平性口径待成绩采集期定，本期按 real_time 直接排序。
 *  成绩口径（张老师 2026-11-18 批量绑定定）：只计上传时间落在比赛窗口内的录像——
 *  窗口外的赛后补传盘只展示不计成绩（绑定时 race 硬证据不受窗口限制）。 */
export async function getTourRanking(compId: number, limit = 10): Promise<TourRankRow[]> {
  // 窗口过滤需要比赛起止时刻（Video/VideoInfo 无 relation，起止从比赛行取）
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true },
  });
  if (!comp) return [];
  // Video/VideoInfo 同 id 1:1 但 schema 无 relation，real_time/no_record 分表取
  const rows = await prisma.video.findMany({
    where: {
      tournamentId: BigInt(compId),
      status: { not: 0 },
      createTime: { gte: comp.startTime, lte: comp.endTime },
    },
    select: { id: true, user: true },
  });
  const infos = await prisma.videoInfo.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true, realTime: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  type Best = { uid: number; time: number; videoId: number };
  const best = new Map<number, Best>();
  for (const r of rows) {
    const info = infoMap.get(r.id);
    const rt = info?.realTime ?? 0;
    if (!rt || info?.noRecord) continue; // 运气盘不计成绩（2026-11-02 口径）
    const uid = Number(r.user);
    const prev = best.get(uid);
    if (!prev || rt < prev.time) best.set(uid, { uid, time: rt, videoId: Number(r.id) });
  }
  const sorted = [...best.values()].sort((a, b) => a.time - b.time).slice(0, limit);
  if (!sorted.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: sorted.map((s) => BigInt(s.uid)) } },
    select: { id: true, chineseName: true },
  });
  const nameMap = new Map(users.map((u) => [Number(u.id), u.chineseName]));
  return sorted.map((s, i) => ({
    rank: i + 1,
    uid: s.uid,
    name: nameMap.get(s.uid) ?? `UID ${s.uid}`,
    time: s.time,
    videoId: s.videoId,
  }));
}

export interface TourMyResult {
  joined: boolean;
  videos: number; // 我的参赛录像数
  bestTime: number | null; // 我的最好成绩（毫秒）
  rank: number | null; // 在最新排名中的名次（全量排名内）
}

/** 我在这场比赛的成绩（详情页「我的成绩」板块）。
 *  成绩口径（张老师 2026-11-18）：只计窗口内录像（同 getTourRanking）。 */
export async function getTourMyResult(compId: number, uid: number): Promise<TourMyResult> {
  const joined = await prisma.tournamentEntry.findFirst({
    where: { tournamentId: BigInt(compId), userId: BigInt(uid) },
    select: { id: true },
  });
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true },
  });
  // Video/VideoInfo 无 relation，real_time 分表取（同 getTourRanking）
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
    select: { id: true, realTime: true, noRecord: true },
  });
  let bestTime: number | null = null;
  for (const info of myInfos) {
    const rt = info.realTime;
    if (!rt || info.noRecord) continue;
    if (bestTime === null || rt < bestTime) bestTime = rt;
  }
  let rank: number | null = null;
  if (bestTime !== null) {
    // 名次＝real_time 严格更小的去重玩家数 + 1（与 getTourRanking 同口径的全量版）
    const all = await prisma.video.findMany({
      where: {
        tournamentId: BigInt(compId),
        status: { not: 0 },
        ...(comp ? { createTime: { gte: comp.startTime, lte: comp.endTime } } : {}),
      },
      select: { id: true, user: true },
    });
    const allInfos = await prisma.videoInfo.findMany({
      where: { id: { in: all.map((r) => r.id) } },
      select: { id: true, realTime: true, noRecord: true },
    });
    const infoById = new Map(allInfos.map((i) => [i.id, i]));
    const bestBy = new Map<number, number>();
    for (const r of all) {
      const info = infoById.get(r.id);
      const rt = info?.realTime ?? 0;
      if (!rt || info?.noRecord) continue;
      const u = Number(r.user);
      if (!bestBy.has(u) || rt < bestBy.get(u)!) bestBy.set(u, rt);
    }
    rank = 1 + [...bestBy.values()].filter((t) => t < bestTime!).length;
  }
  return { joined: !!joined, videos: rows.length, bestTime, rank };
}

/** 比赛详情页统计（参赛人数=报名去重人数；录像数=挂接且未屏蔽） */
export async function getTourDetailStats(
  compId: number
): Promise<{ entries: number; videos: number }> {
  // 参赛人数口径（张老师 2026-11-18 详情页反馈）：＝录像持有者数量（distinct user）——
  // 历届金羊杯早已结束、报名表恒 0，报名数无意义；持有者与动态/排名自然一致
  const holders = await prisma.video.findMany({
    where: { tournamentId: BigInt(compId), status: { not: 0 } },
    select: { user: true },
  });
  const videos = holders.length;
  return { entries: new Set(holders.map((h) => h.user.toString())).size, videos };
}

/** 比赛录像分页（详情页「录像」板块）：按时间正序（早在前，张老师 14:45 口径「按时间顺序」），
 *  展示形式与首页录像流一致（VideoRows 行渲染），但按比赛过滤、不去重 */
export async function getTourVideosPage(
  compId: number,
  page: number,
  pageSize = 20
): Promise<{ videos: VideoListItem[]; total: number; page: number; pageSize: number }> {
  const where = { tournamentId: BigInt(compId), status: { not: 0 } };
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
  return {
    id: c.id.toString(),
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
    entryCount,
    joined: !!joined,
    levels: levelSet.size ? LEVELS.filter((l) => levelSet.has(l)) : [...LEVELS],
    creatorId: Number(c.creatorId),
    creatorEnglishName: creator?.englishName ?? "",
    creatorSex: creator?.sex ?? 1,
    creatorTitle: pair?.m ?? "",
    creatorClassic: pair?.c ?? null,
  };
}

// ---------- 成绩计算（2026-11-13 四期 张老师定） ----------
//
// 计算方式可扩展：score_mode + score_config(JSON) 落库，新增方式加分支即可。
// 口径（张老师 22:47 三问定）：
// · sum_topn 成绩加总：玩家成绩 = 各收录级别最好 N 局 time(real_time) 加总，越小越好；
//   某级别不足 N 局按已有局数计；config={"beg":2,"int":2,"exp":2}（n=0 该级别不计）。
// · target_diff 目标求差：config={"target":8.88}（秒），玩家成绩 = 所有有效局中
//   |time − target| 最小一局的误差（ms），越小越好（打靶赛）。
// · 成绩只认 status!=0 且 no_record=0 且 real_time>0 的录像（同前台排名口径）。

export type TournamentScoreMode = "" | "sum_topn" | "target_diff";

export const SCORE_MODE_LABELS: Record<string, string> = {
  "": "未配置（暂不计成绩）",
  sum_topn: "成绩加总（各级别最好 N 局 time 求和）",
  target_diff: "目标成绩求差（与指定 time 的最小误差）",
};

/** 解析 score_config，非法/与 mode 不符回退 null（展示与计算共用入口） */
export function parseScoreConfig(mode: string, cfg: string): Record<string, number> | null {
  if (!mode) return null;
  try {
    const o = JSON.parse(cfg) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return null;
    if (mode === "sum_topn") {
      const out: Record<string, number> = {};
      for (const lv of ["beg", "int", "exp"]) {
        const n = Number(o[lv]);
        out[lv] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      }
      return out;
    }
    if (mode === "target_diff") {
      const t = Number(o.target);
      return Number.isFinite(t) && t > 0 ? { target: t } : null;
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
    const parts = (["beg", "int", "exp"] as const)
      .filter((lv) => c[lv] > 0)
      .map((lv) => `${LEVEL_NAMES[lv]}${c[lv]}局`);
    return `成绩加总：${parts.length ? parts.join(" + ") : "未配置级别"}`;
  }
  if (mode === "target_diff" && c) {
    return `目标求差：time=${c.target}，取误差最小一局`;
  }
  return SCORE_MODE_LABELS[mode] ?? "未配置";
}

export interface TourScoreVideo {
  user: bigint | number;
  level: string;
  realTime: number;
  noRecord: boolean;
}

/** 批量计算玩家成绩：Map<uid, score(ms)>，无有效录像的玩家不在 Map。均为越小越好。 */
export function computePlayerScores(
  mode: string,
  cfg: string,
  vids: TourScoreVideo[]
): Map<number, number> {
  const conf = parseScoreConfig(mode, cfg);
  const out = new Map<number, number>();
  if (!conf) return out;
  const valid = vids.filter((v) => v.realTime > 0 && !v.noRecord);
  if (mode === "sum_topn") {
    // 各级别最好 N 局 time 加总（跨级别累加）
    const byUserLevel = new Map<number, Map<string, number[]>>();
    for (const v of valid) {
      const n = conf[v.level] ?? 0;
      if (n <= 0) continue;
      const uid = Number(v.user);
      if (!byUserLevel.has(uid)) byUserLevel.set(uid, new Map());
      const m = byUserLevel.get(uid)!;
      if (!m.has(v.level)) m.set(v.level, []);
      m.get(v.level)!.push(v.realTime);
    }
    for (const [uid, levels] of byUserLevel) {
      let sum = 0;
      for (const [lv, times] of levels) {
        times.sort((a, b) => a - b);
        sum += times.slice(0, conf[lv] ?? 0).reduce((a, b) => a + b, 0);
      }
      out.set(uid, sum);
    }
    return out;
  }
  if (mode === "target_diff") {
    const targetMs = conf.target * 1000;
    for (const v of valid) {
      const uid = Number(v.user);
      const err = Math.abs(v.realTime - targetMs);
      if (!out.has(uid) || err < out.get(uid)!) out.set(uid, err);
    }
    return out;
  }
  return out;
}

/** 成绩展示（ms → 秒，去尾零；sum_topn 与 target_diff 共用「越小越好」语义） */
export function fmtScoreMs(ms: number): string {
  const s = ms / 1000;
  const str = s.toFixed(3).replace(/\.?0+$/, "");
  return `${str}s`;
}
