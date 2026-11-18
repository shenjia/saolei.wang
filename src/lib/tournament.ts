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
  /** 纪录图表散点（详情页形态填充：按比赛设定总分排名前 30，score 秒；列表形态为空数组） */
  chartPoints: { rank: number; score: number; name?: string }[];
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
      chartPoints: [], // 列表形态不取图表数据（详情页才有）
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
  /** 事件主体玩家展示信息（type=2/4 有；性别标志+军衔，2026-11-18 晚张老师定同首页动态） */
  sex: number;
  englishName: string;
  title: string;
  classic: { name: string; color: string } | null;
  /** type=4 合并组：同刻连续动态条数（1=单条） */
  count: number;
  /** type=4 合并组内最好成绩（毫秒；无有效成绩 null） */
  scoreMs: number | null;
}

/** 比赛动态分页（2026-11-18 晚张老师定改版）：
 *  · 时间正序（老在前）
 *  · type=4 按 (user_id, create_time) 分组合并——同刻连续的同一人成绩动态合一行，
 *    显示「×N」与组内最好成绩（从 video 表按上传时刻精确关联取 real_time 最小值）
 *  · 带出玩家性别/军衔（同首页动态行）
 *  total 口径：合并后的行数（分页/滑轨都按它算） */
export async function getTourEventsPage(
  tournamentId: number,
  page: number,
  pageSize = 20
): Promise<{ rows: TourEventRow[]; total: number; page: number; pageSize: number }> {
  const cid = BigInt(tournamentId);
  // 合并聚合（原生 SQL：Prisma 无 groupBy 多键 + 关联取数的表达力）
  // 分组键 = (user_id, create_time)；type=4 之外每行自成一组（user_id=0 或各自时刻天然不同）
  const groups = await prisma.$queryRaw<
    {
      user_id: bigint | null;
      create_time: bigint;
      type: number;
      cnt: bigint;
      min_id: bigint;
      score_ms: number | null;
    }[]
  >`
    SELECT te.user_id, te.create_time, te.type, COUNT(*) AS cnt, MIN(te.id) AS min_id,
           MIN(te.competition_id) AS competition_id,
           (SELECT MIN(vi.real_time)
            FROM video v JOIN video_info vi ON vi.id = v.id
            WHERE v.competition_id = MIN(te.competition_id)
              AND v.status <> 0
              AND v.user = te.user_id
              AND v.create_time = te.create_time) AS score_ms
    FROM tournament_event te
    WHERE te.competition_id = ${cid}
    GROUP BY te.user_id, te.create_time, te.type
    ORDER BY te.create_time ASC, te.type ASC, min_id ASC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `;
  const totalRow = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) AS c FROM (
      SELECT 1 FROM tournament_event
      WHERE competition_id = ${cid}
      GROUP BY user_id, create_time, type
    ) t
  `;
  const total = Number(totalRow[0]?.c ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(page, 1), totalPages);
  const uids = [...new Set(groups.map((g) => Number(g.user_id)).filter((x) => x > 0))];
  const [users, scoreRows] = uids.length
    ? await Promise.all([
        prisma.user.findMany({
          where: { id: { in: uids.map((s) => BigInt(s)) } },
          select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
        }),
        prisma.userScores.findMany({
          where: { id: { in: uids.map((s) => BigInt(s)) } },
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
    rows: groups.map((g) => {
      const uid = Number(g.user_id);
      const u = uid > 0 ? userMap.get(uid) : undefined;
      const pair = uid > 0 ? titleMap.get(uid) : undefined;
      return {
        id: Number(g.min_id),
        type: g.type,
        userName: uid > 0 ? u?.chineseName ?? `UID ${uid}` : null,
        userId: uid > 0 ? uid : null,
        createTime: Number(g.create_time),
        sex: u?.sex ?? 1,
        englishName: u?.englishName ?? "",
        title: pair?.m ?? "",
        classic: pair?.c ?? null,
        count: Number(g.cnt),
        scoreMs: g.score_ms !== null ? Number(g.score_ms) : null,
      };
    }),
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
  englishName: string;
  sex: number;
  /** 军衔制称号（TitleBadge 主渲染） */
  title: string;
  /** 旧版称号备选（观看者偏好旧体系时 TitleBadge 渲染此套） */
  classic: { name: string; color: string } | null;
  /** 玩家总成绩（毫秒）：sum_topn=各级别最好N局加总+保底补足；target_diff=最小误差 */
  time: number;
  /** 代表盘录像 ID（总成绩对应不了单盘时＝该玩家最好一局，供链接跳详情） */
  videoId: number;
  /** sum_topn 各级别补保底局数（前端展示「含保底 x 局」） */
  filled: Record<string, number>;
  /** 计算过程明细（2026-11-18 晚张老师定：hover 成绩出气泡展示，各级别分色；
   *  sum_topn 每级别一条 real+fill，target_diff 为 null） */
  calc: { lv: string; n: number; real: number; fill: number; floorMs: number }[] | null;
}

/** 排行榜（张老师 2026-11-18 定：按比赛设定计算成绩排序，不再按单盘最好成绩）——
 *  sum_topn：窗口内录像按 computePlayerScores 同口径算总分（不足 N 局补保底），
 *  videoId 取该玩家窗口内最好一局；target_diff 同口径取最小误差。 */
export async function getTourRanking(compId: number, limit = 10): Promise<TourRankRow[]> {
  const comp = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true, scoreMode: true, scoreConfig: true },
  });
  if (!comp) return [];
  // Video/VideoInfo 同 id 1:1 但 schema 无 relation，real_time/no_record 分表取
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
    select: { id: true, realTime: true, noRecord: true },
  });
  const infoMap = new Map(infos.map((i) => [i.id, i]));
  const scores = computePlayerScores(
    comp.scoreMode,
    comp.scoreConfig,
    rows.map((r) => ({
      user: r.user,
      level: levelMap.get(r.id) ?? "",
      realTime: infoMap.get(r.id)?.realTime ?? 0,
      noRecord: infoMap.get(r.id)?.noRecord ?? false,
    })),
  );
  if (!scores.size) return [];
  // 代表盘 = 该玩家窗口内最好一局（总成绩是多盘合成，链接供看最好盘）
  const bestBy = new Map<number, { time: number; videoId: number }>();
  for (const r of rows) {
    const info = infoMap.get(r.id);
    const rt = info?.realTime ?? 0;
    if (!rt || info?.noRecord) continue;
    const uid = Number(r.user);
    const prev = bestBy.get(uid);
    if (!prev || rt < prev.time) bestBy.set(uid, { time: rt, videoId: Number(r.id) });
  }
  const sorted = [...scores.entries()]
    .sort((a, b) => a[1].score - b[1].score)
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
  bestTime: number | null; // 我的最好成绩（毫秒）
  rank: number | null; // 在最新排名中的名次（全量排名内）
}

/** 我在这场比赛的成绩（详情页「我的成绩」板块）。
 *  成绩口径（张老师 2026-11-18）：bestTime=窗口内最好一局（单盘口径）；
 *  rank=按比赛设定总分口径的名次（与排行榜 getTourRanking 全量同口径）。 */
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
    // 名次按比赛设定总分（getTourRanking 全量版）：取全部玩家的 computePlayerScores，
    // 我的 score 严格更小的去重玩家数 + 1
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
      select: { id: true, realTime: true, noRecord: true },
    });
    const infoById = new Map(allInfos.map((i) => [i.id, i]));
    const full = await prisma.tournament.findUnique({
      where: { id: BigInt(compId) },
      select: { scoreMode: true, scoreConfig: true },
    });
    const scores = computePlayerScores(
      full?.scoreMode ?? "",
      full?.scoreConfig ?? "",
      all.map((r) => ({
        user: r.user,
        level: levelMap.get(r.id) ?? "",
        realTime: infoById.get(r.id)?.realTime ?? 0,
        noRecord: infoById.get(r.id)?.noRecord ?? false,
      })),
    );
    const mine = scores.get(uid);
    rank = mine ? 1 + [...scores.values()].filter((s) => s.score < mine.score).length : null;
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
  // 纪录图表数据（2026-11-18 晚张老师问「已结束为什么没数据」）：按比赛设定总分
  // 排名的散点——复用 getTourRanking 全量口径，取前 30 名（score 秒）；无成绩比赛为空
  const rankRows =
    c.startTime <= now
      ? await getTourRanking(id, 30)
      : [];
  const chartPoints = rankRows.map((r) => ({
    rank: r.rank,
    score: r.time / 1000,
    name: r.name,
  }));
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
    chartPoints,
  };
}

// ---------- 成绩计算（2026-11-13 四期 张老师定；2026-11-18 保底补足+排行榜按总分排序） ----------
//
// 计算方式可扩展：score_mode + score_config(JSON) 落库，新增方式加分支即可。
// 口径：
// · sum_topn 成绩加总：玩家成绩 = 各收录级别最好 N 局 time(real_time) 加总，越小越好；
//   某级别不足 N 局用「保底成绩」补足（张老师 2026-11-18 定：默认初 10s / 中 60s / 高 240s，
//   后台可改）——config={"beg":20,"int":12,"exp":5,"floor":{"beg":10000,"int":60000,"exp":240000}}
//   （floor 毫秒，缺省回退默认；n=0 该级别不计，也不补保底）。
// · target_diff 目标求差：config={"target":8.88}（秒），玩家成绩 = 所有有效局中
//   |time − target| 最小一局的误差（ms），越小越好（打靶赛）。
// · 成绩只认 status!=0 且 no_record=0 且 real_time>0 的录像（同前台排名口径）。

export type TournamentScoreMode = "" | "sum_topn" | "target_diff";

export const SCORE_MODE_LABELS: Record<string, string> = {
  "": "未配置（暂不计成绩）",
  sum_topn: "成绩加总（各级别最好 N 局 time 求和）",
  target_diff: "目标成绩求差（与指定 time 的最小误差）",
};

/** sum_topn 各级别保底成绩（毫秒）默认值（张老师 2026-11-18 定：初 10s / 中 60s / 高 240s） */
export const DEFAULT_SCORE_FLOOR_MS: Record<string, number> = {
  beg: 10_000,
  int: 60_000,
  exp: 240_000,
};

export interface ParsedScoreConfig {
  topn: Record<string, number>;
  /** 保底成绩（毫秒）；仅 sum_topn 使用 */
  floor: Record<string, number>;
  /** target_diff 的目标（秒） */
  target?: number;
}

/** 解析 score_config，非法/与 mode 不符回退 null（展示与计算共用入口）。
 *  兼容旧形态 {"beg":20,...}（无 floor → 回默认保底） */
export function parseScoreConfig(mode: string, cfg: string): ParsedScoreConfig | null {
  if (!mode) return null;
  try {
    const o = JSON.parse(cfg) as Record<string, unknown>;
    if (typeof o !== "object" || o === null) return null;
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
        floor[lv] = Number.isFinite(f) && f > 0 ? Math.round(f) : DEFAULT_SCORE_FLOOR_MS[lv]!;
      }
      return { topn, floor };
    }
    if (mode === "target_diff") {
      const t = Number(o.target);
      return Number.isFinite(t) && t > 0 ? { topn: {}, floor: {}, target: t } : null;
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
      .filter((lv) => c.topn[lv] > 0)
      .map((lv) => `${LEVEL_NAMES[lv]}${c.topn[lv]}局`);
    const floors = (["beg", "int", "exp"] as const)
      .filter((lv) => c.topn[lv] > 0)
      .map((lv) => `${LEVEL_NAMES[lv]}保底${c.floor[lv]! / 1000}s`);
    return `成绩加总：${parts.length ? parts.join(" + ") : "未配置级别"}（${floors.join("，")}，不足补保底）`;
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

export interface PlayerScore {
  /** 总成绩（毫秒，越小越好）；target_diff 为最小误差 ms */
  score: number;
  /** sum_topn 明细：各级别实盘加总（0=无实盘）与补保底盘数 */
  parts: Record<string, number>;
  /** 各级别补保底局数（实盘数 < N 时） */
  filled: Record<string, number>;
  /** 计算过程（2026-11-18 晚张老师定：hover 成绩气泡展示；每级别一条） */
  calc: { lv: string; n: number; real: number; fill: number; floorMs: number }[];
}

/** 批量计算玩家成绩：Map<uid, PlayerScore>，无有效录像且无需保底的玩家不在 Map。
 *  sum_topn：各级别最好 N 局求和；不足 N 局用保底成绩补足差额局数（保底恒大于
 *  实盘才有意义，实盘更优的玩家自然排前）。均为越小越好。 */
export function computePlayerScores(
  mode: string,
  cfg: string,
  vids: TourScoreVideo[]
): Map<number, PlayerScore> {
  const conf = parseScoreConfig(mode, cfg);
  const out = new Map<number, PlayerScore>();
  if (!conf) return out;
  const valid = vids.filter((v) => v.realTime > 0 && !v.noRecord);
  if (mode === "sum_topn") {
    // 各级别最好 N 局 time 加总（跨级别累加），不足 N 局补保底
    const byUserLevel = new Map<number, Map<string, number[]>>();
    for (const v of valid) {
      const n = conf.topn[v.level] ?? 0;
      if (n <= 0) continue;
      const uid = Number(v.user);
      if (!byUserLevel.has(uid)) byUserLevel.set(uid, new Map());
      const m = byUserLevel.get(uid)!;
      if (!m.has(v.level)) m.set(v.level, []);
      m.get(v.level)!.push(v.realTime);
    }
    for (const [uid, levels] of byUserLevel) {
      let sum = 0;
      const parts: Record<string, number> = {};
      const filled: Record<string, number> = {};
      const calc: PlayerScore["calc"] = [];
      for (const lv of ["beg", "int", "exp"] as const) {
        const n = conf.topn[lv] ?? 0;
        if (n <= 0) continue;
        const times = (levels.get(lv) ?? []).sort((a, b) => a - b);
        const real = times.slice(0, n).reduce((a, b) => a + b, 0);
        const fill = Math.max(n - times.length, 0);
        parts[lv] = real;
        filled[lv] = fill;
        const floorMs = conf.floor[lv] ?? 0;
        sum += real + fill * floorMs;
        calc.push({ lv, n, real, fill, floorMs });
      }
      out.set(uid, { score: sum, parts, filled, calc });
    }
    return out;
  }
  if (mode === "target_diff") {
    const targetMs = (conf.target ?? 0) * 1000;
    for (const v of valid) {
      const uid = Number(v.user);
      const err = Math.abs(v.realTime - targetMs);
      if (!out.has(uid) || err < out.get(uid)!.score) {
        out.set(uid, { score: err, parts: {}, filled: {}, calc: [] });
      }
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
