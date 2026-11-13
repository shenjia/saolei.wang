// 比赛业务层（2026-11-13 张老师需求：前台「比赛」页 + 后台「比赛管理」）
//
// 口径备忘：
// · 状态不落库，由起止时间对 now 推导（未开始/进行中/已结束）；
// · 列表排序＝进行中 → 未开始 → 已结束（张老师 13:12 定）；同状态内：
//   进行中按结束时间升序（先结束的在前）、未开始按开始时间升序、已结束按结束时间倒序；
// · 比赛总量小（十场量级），列表整表取回内存排序 + 切页，避免 CASE WHEN 裸拼 SQL；
// · 比赛标识 code 创建时即生成，前台开始前显示「待定」；
// · 成绩采集为下一期口径：本期图表无数据源，渲染占位；全网统计「录像数量」恒 0。

import { prisma } from "@/lib/db";
import { getVideosByIds, type VideoListItem } from "@/lib/queries";
import { dualTitles } from "@/lib/title-system";
import { LEVELS, type Level } from "@/lib/config";

export type CompetitionStatus = "upcoming" | "active" | "ended";

export const COMP_PAGE_SIZE = 5; // 张老师：一页最多同时显示 5 个比赛

export function compStatus(
  start: bigint | number,
  end: bigint | number,
  now: number
): CompetitionStatus {
  const s = Number(start);
  const e = Number(end);
  if (now < s) return "upcoming";
  if (now < e) return "active";
  return "ended";
}

const STATUS_ORDER: Record<CompetitionStatus, number> = { active: 0, upcoming: 1, ended: 2 };

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

/** 起止日期小标：11月11日 ~ 12月3日（跨年带年份） */
export function fmtDateRange(start: bigint | number, end: bigint | number): string {
  const s = new Date(Number(start) * 1000);
  const e = new Date(Number(end) * 1000);
  const f = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
  const year = s.getFullYear() === e.getFullYear() ? "" : `${s.getFullYear()}年`;
  return `(${year}${f(s)} ~ ${f(e)})`;
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

/** 6 位数字+大小写字母随机标识（创建时生成，唯一性靠重试） */
export function genCompCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export async function genUniqueCompCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = genCompCode();
    const hit = await prisma.competition.findFirst({ where: { code }, select: { id: true } });
    if (!hit) return code;
  }
  return `${Date.now().toString(36)}`.slice(-6); // 兜底：碰撞概率极低，仍保证可写
}

// ---------- 列表查询 ----------

export interface CompRow {
  id: string;
  name: string;
  shortName: string;
  status: CompetitionStatus;
  start: number;
  end: number;
  rules: string;
  creatorName: string;
  prizeTotal: number;
  prizeLines: string[];
  code: string;
  entryCount: number;
  joined: boolean; // 当前登录用户是否已报名
  levels: Level[]; // 收录录像级别（张老师 2026-11-13：可多选，默认初中高都有）
  creatorId: number; // 发起人（图表下方玩家卡片式名字展示：性别+军衔）
  creatorEnglishName: string;
  creatorSex: number;
  creatorTitle: string; // 军衔制称号
  creatorClassic: { name: string; color: string } | null; // 旧版称号备选
}

export interface CompPage {
  rows: CompRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 比赛列表：状态排序 → 内存切页。uid 传入时带「是否已报名」标记。
 *  pageSize 供「加载更多」大批量取数（82ff927 口径：size 只是本批行数 take） */
export async function getCompetitionPage(page: number, uid?: number, pageSize?: number): Promise<CompPage> {
  const now = Math.floor(Date.now() / 1000);
  const size = Math.min(Math.max(pageSize ?? COMP_PAGE_SIZE, 1), 100);
  const all = await prisma.competition.findMany({
    orderBy: { startTime: "asc" },
  });

  // 报名数一次聚合
  const counts = await prisma.competitionEntry.groupBy({
    by: ["competitionId"],
    _count: { competitionId: true },
  });
  const countMap = new Map<string, number>(counts.map((c) => [c.competitionId.toString(), c._count.competitionId]));

  // 我的报名集合
  let mineSet = new Set<string>();
  if (uid) {
    const mine = await prisma.competitionEntry.findMany({
      where: { userId: BigInt(uid) },
      select: { competitionId: true },
    });
    mineSet = new Set(mine.map((m) => m.competitionId.toString()));
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

  const rows: CompRow[] = all.map((c) => {
    const cid = c.id.toString();
    return {
      id: cid,
      name: c.name,
      shortName: c.shortName,
      status: compStatus(c.startTime, c.endTime, now),
      start: Number(c.startTime),
      end: Number(c.endTime),
      rules: c.rules,
      creatorName: nameMap.get(c.creatorId.toString()) || `UID ${c.creatorId}`,
      prizeTotal: c.prizeTotal,
      prizeLines: parsePrizePlan(c.prizePlan),
      code: c.code,
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

export interface CompGlobalStats {
  competitions: number; // 比赛个数（全站）
  participants: number; // 参赛人数（去重用户）
  videos: number; // 录像数量（成绩采集下一期接入，恒 0）
  prizeTotal: number; // 累计奖金（全站总奖金之和）
}

export async function getCompGlobalStats(): Promise<CompGlobalStats> {
  const [competitions, participants, prizeAgg, videos] = await Promise.all([
    prisma.competition.count(),
    prisma.competitionEntry.groupBy({ by: ["userId"], where: {} }).then((g) => g.length),
    prisma.competition.aggregate({ _sum: { prizeTotal: true } }),
    // 挂接到比赛的录像数（2026-11-13 二期起有真实数据源：后台手动挂接）
    prisma.video.count({ where: { competitionId: { not: null }, status: { not: 0 } } }),
  ]);
  return {
    competitions,
    participants,
    videos,
    prizeTotal: prizeAgg._sum.prizeTotal ?? 0,
  };
}

export interface CompMyStats {
  joined: number; // 参加比赛次数（已报名数）
  bestRank: number | null; // 最高排名（成绩采集下一期接入）
  prize: number; // 累计奖金（成绩采集下一期接入）
}

export async function getCompMyStats(uid: number): Promise<CompMyStats> {
  const joined = await prisma.competitionEntry.count({ where: { userId: BigInt(uid) } });
  return { joined, bestRank: null, prize: 0 }; // TODO 成绩采集期接入：bestRank / prize
}

// ---------- 动态（2026-11-13 二期：详情页「动态」板块）----------

export const COMP_EVENT_JOIN_OPEN = 1; // 报名开始
export const COMP_EVENT_PLAYER_JOIN = 2; // 玩家报名参加
export const COMP_EVENT_STARTED = 3; // 比赛正式开始
export const COMP_EVENT_SCORE = 4; // 玩家更新成绩
export const COMP_EVENT_ENDED = 5; // 比赛正式结束

/** 动态事件文案（type → 展示文本；主体玩家名由行渲染拼接）。
    详情页 RSC 与 CompEventsFeed 客户端壳共用（2026-11-13 五轮翻页改版） */
export function compEventText(type: number): string {
  switch (type) {
    case COMP_EVENT_JOIN_OPEN:
      return "报名开始";
    case COMP_EVENT_PLAYER_JOIN:
      return "报名参加了比赛";
    case COMP_EVENT_STARTED:
      return "比赛正式开始";
    case COMP_EVENT_SCORE:
      return "更新了成绩";
    case COMP_EVENT_ENDED:
      return "比赛正式结束";
    default:
      return "";
  }
}

/** 写一条动态（报名/挂录像走此入口；开始/结束走 ensureCompLifecycleEvents 惰性补写） */
export async function addCompEvent(
  competitionId: number,
  type: number,
  userId = 0
): Promise<void> {
  await prisma.competitionEvent.create({
    data: {
      competitionId: BigInt(competitionId),
      type,
      userId: BigInt(userId),
      createTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
}

/**
 * 惰性补写「比赛正式开始 / 比赛正式结束」动态：now 越过起止时刻且该事件尚不存在时补一条。
 * 列表页与详情页渲染期各调一次（行数 ≤ 页内比赛数，两次 findFirst 走 (competition_id,id)
 * 索引，开销可忽略）——不依赖定时器，重启/停机不漏事件。
 */
export async function ensureCompLifecycleEvents(
  c: { id: bigint | number | string; startTime: bigint | number; endTime: bigint | number },
  now: number
): Promise<void> {
  const cid = BigInt(c.id);
  const start = Number(c.startTime);
  const end = Number(c.endTime);
  if (now >= start) {
    const hit = await prisma.competitionEvent.findFirst({
      where: { competitionId: cid, type: COMP_EVENT_STARTED },
      select: { id: true },
    });
    if (!hit) await addCompEvent(Number(c.id), COMP_EVENT_STARTED);
  }
  if (now >= end) {
    const hit = await prisma.competitionEvent.findFirst({
      where: { competitionId: cid, type: COMP_EVENT_ENDED },
      select: { id: true },
    });
    if (!hit) await addCompEvent(Number(c.id), COMP_EVENT_ENDED);
  }
}

export interface CompEventRow {
  id: number;
  type: number;
  userName: string | null; // 全站事件（1/3/5）为 null
  userId: number | null;
  createTime: number;
}

/** 比赛动态分页：最新在前（与全站动态流口径一致） */
export async function getCompEventsPage(
  competitionId: number,
  page: number,
  pageSize = 20
): Promise<{ rows: CompEventRow[]; total: number; page: number; pageSize: number }> {
  const cid = BigInt(competitionId);
  const total = await prisma.competitionEvent.count({ where: { competitionId: cid } });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(page, 1), totalPages);
  const events =
    total === 0
      ? []
      : await prisma.competitionEvent.findMany({
          where: { competitionId: cid },
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

export interface CompRankRow {
  rank: number;
  uid: number;
  name: string;
  time: number; // 最好成绩（毫秒，real_time）
  videoId: number;
}

/** 最新排名：挂接录像按玩家取最好成绩（real_time 最小），升序取前 limit 名。
 *  注意：跨级别混排的公平性口径待成绩采集期定，本期按 real_time 直接排序。 */
export async function getCompRanking(compId: number, limit = 10): Promise<CompRankRow[]> {
  // Video/VideoInfo 同 id 1:1 但 schema 无 relation，real_time/no_record 分表取
  const rows = await prisma.video.findMany({
    where: { competitionId: BigInt(compId), status: { not: 0 } },
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

export interface CompMyResult {
  joined: boolean;
  videos: number; // 我的参赛录像数
  bestTime: number | null; // 我的最好成绩（毫秒）
  rank: number | null; // 在最新排名中的名次（全量排名内）
}

/** 我在这场比赛的成绩（详情页「我的成绩」板块） */
export async function getCompMyResult(compId: number, uid: number): Promise<CompMyResult> {
  const joined = await prisma.competitionEntry.findFirst({
    where: { competitionId: BigInt(compId), userId: BigInt(uid) },
    select: { id: true },
  });
  // Video/VideoInfo 无 relation，real_time 分表取（同 getCompRanking）
  const rows = await prisma.video.findMany({
    where: { competitionId: BigInt(compId), user: BigInt(uid), status: { not: 0 } },
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
    // 名次＝real_time 严格更小的去重玩家数 + 1（与 getCompRanking 同口径的全量版）
    const all = await prisma.video.findMany({
      where: { competitionId: BigInt(compId), status: { not: 0 } },
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
export async function getCompDetailStats(
  compId: number
): Promise<{ entries: number; videos: number }> {
  const [entries, videos] = await Promise.all([
    prisma.competitionEntry.count({ where: { competitionId: BigInt(compId) } }),
    prisma.video.count({ where: { competitionId: BigInt(compId), status: { not: 0 } } }),
  ]);
  return { entries, videos };
}

/** 比赛录像分页（详情页「录像」板块）：按时间正序（早在前，张老师 14:45 口径「按时间顺序」），
 *  展示形式与首页录像流一致（VideoRows 行渲染），但按比赛过滤、不去重 */
export async function getCompVideosPage(
  compId: number,
  page: number,
  pageSize = 20
): Promise<{ videos: VideoListItem[]; total: number; page: number; pageSize: number }> {
  const where = { competitionId: BigInt(compId), status: { not: 0 } };
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

// ---------- 详情（2026-11-13 二期：/competitions/[id]）----------

/** 单场比赛完整行（与列表 CompRow 同构，详情页顶部板块复用 CompBlock 渲染） */
export async function getCompetitionDetail(
  id: number,
  uid?: number
): Promise<CompRow | null> {
  const c = await prisma.competition.findUnique({ where: { id: BigInt(id) } });
  if (!c) return null;
  const now = Math.floor(Date.now() / 1000);
  const [entryCount, creator, scoreRow, joined] = await Promise.all([
    prisma.competitionEntry.count({ where: { competitionId: c.id } }),
    prisma.user.findUnique({
      where: { id: c.creatorId },
      select: { chineseName: true, englishName: true, sex: true, status: true },
    }),
    prisma.userScores.findUnique({ where: { id: c.creatorId }, select: { expTime: true } }),
    uid
      ? prisma.competitionEntry.findFirst({
          where: { competitionId: c.id, userId: BigInt(uid) },
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
    status: compStatus(c.startTime, c.endTime, now),
    start: Number(c.startTime),
    end: Number(c.endTime),
    rules: c.rules,
    creatorName: creator?.chineseName ?? `UID ${c.creatorId}`,
    prizeTotal: c.prizeTotal,
    prizeLines: parsePrizePlan(c.prizePlan),
    code: c.code,
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
