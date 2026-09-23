// 数据访问层：移植 2013 版 PHP 的 logic/* 查询语义
// 注意：user / user_info / user_stat / user_scores 共用同一主键（用户 id）
//       video / video_info / video_stat / video_scores_* 共用同一主键（录像 id）

import { prisma } from "./db";
import { getTitleDistribution, title } from "./assess";
import {
  COMMENT_STATUS,
  COMMENT_TOP_NUMBER,
  HOME_NEWS_NUMBER,
  HOME_NEWBIE_NUMBER,
  HOME_TOP_NUMBER,
  MIN_3BV_FOR_3BVS,
  NEWS_TYPE,
  ORDER_DIRECTION,
  RANKING_PAGESIZE,
  TITLES,
  USER_ROLE,
  VIDEO_PAGESIZE,
  VIDEO_STATUS,
  byLevelOrder,
  RANKING_BYS,
  type Level,
  type Order,
  type RankingBy,
  type VideoLevel,
} from "./config";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// ---------- 类型 ----------

export interface UserBrief {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
}

export interface NewsItem {
  id: number;
  type: number;
  userScore: number;
  reference: number;
  details: Record<string, unknown>;
  createTime: number;
  author: UserBrief | null;
}

export interface RankingUser extends UserBrief {
  rank: number;
  score: number;
  videoId: number;
  date: number;
  title: string;
}

export interface VideoListItem {
  id: number;
  level: string;
  status: number;
  createTime: number;
  noflag: boolean;
  board3bv: number;
  realTime: number;
  board: string;
  software: string;
  version: string;
  clicks: number;
  comments: number;
  author: UserBrief | null;
  authorTitle: string;
}

// ---------- 通用 ----------

function toBrief(u: {
  id: bigint;
  chineseName: string;
  englishName: string;
  sex: number;
} | null): UserBrief | null {
  if (!u) return null;
  return { id: N(u.id), chineseName: u.chineseName, englishName: u.englishName, sex: u.sex };
}

export async function usersByIds(ids: number[]): Promise<Map<number, UserBrief>> {
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: ids.map(BigInt) } } });
  return new Map(rows.map((r) => [N(r.id), toBrief(r)!]));
}

/** 录像成绩：time=real_time(ms)，3bvs=board_3bv×1e6/real_time，3BV 过小记负（移植 VideoModel::getScores） */
export function videoScores(board3bv: number, realTime: number): { time: number; "3bvs": number } {
  const sign = board3bv >= MIN_3BV_FOR_3BVS ? 1 : -1;
  return {
    time: realTime,
    "3bvs": realTime > 0 ? sign * Math.floor((board3bv * 1000000) / realTime) : 0,
  };
}

// ---------- 首页 ----------

export async function getHomeNews(limit = HOME_NEWS_NUMBER): Promise<NewsItem[]> {
  return getNews({ limit });
}

export async function getNewbies(limit = HOME_NEWBIE_NUMBER): Promise<NewsItem[]> {
  return getNews({ type: NEWS_TYPE.NEWBIE, limit });
}

export async function getNews(opts: {
  type?: number;
  userId?: number;
  /** 等级筛选（beg/int/exp）：按 details JSON 的 lv 字段匹配（details_data 全为 {"lv":...} 格式） */
  level?: string;
  cursor?: number;
  limit: number;
}): Promise<NewsItem[]> {
  const rows = await prisma.news.findMany({
    where: {
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
      ...(opts.level ? { detailsData: { contains: `"lv":"${opts.level}"` } } : {}),
      // 游标分页：取 id 小于 cursor 的更早动态（移植 News::getRecentNews 的 cursor 语义）
      ...(opts.cursor ? { id: { lt: BigInt(opts.cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: opts.limit,
  });
  const authors = await usersByIds([...new Set(rows.map((r) => N(r.user)))]);
  return rows.map((r) => ({
    id: N(r.id),
    type: r.type,
    userScore: r.userScore,
    reference: N(r.reference),
    details: safeJson(r.detailsData),
    createTime: N(r.createTime),
    author: authors.get(N(r.user)) ?? null,
  }));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 十大元帅：按总计时间前 10（移植 home/_top） */
export async function getTopUsers(limit = HOME_TOP_NUMBER): Promise<(UserBrief & { title: string })[]> {
  const rows = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 } },
    orderBy: { sumTime: "asc" },
    take: limit,
  });
  const authors = await usersByIds(rows.map((r) => N(r.id)));
  return Promise.all(
    rows.map(async (r) => ({
      ...(authors.get(N(r.id)) ?? { id: N(r.id), chineseName: "?", englishName: "", sex: 1 }),
      title: await title(r.sumTime),
    }))
  );
}

// ---------- 排行榜 ----------

const SCORE_FIELD = (level: Level, order: Order) => `${level}${order === "time" ? "Time" : "3bvs"}` as const;
const VIDEO_FIELD = (level: Level, order: Order) => `${level}${order === "time" ? "TimeVideo" : "3bvsVideo"}` as const;
const DATE_FIELD = (level: Level, order: Order) => `${level}${order === "time" ? "TimeDate" : "3bvsDate"}` as const;

// user_scores 与 user_scores_nf 字段结构一致，收敛为统一委托类型，避免 union delegate 不可调用
interface UserScoresDelegate {
  count(args: { where?: Record<string, unknown> }): Promise<number>;
  findMany(args: {
    where?: Record<string, unknown>;
    select?: { id: true };
    orderBy: Record<string, string>;
    skip?: number;
    take?: number;
  }): Promise<Record<string, bigint | number | null>[]>;
  findUnique(args: {
    where: { id: bigint };
  }): Promise<Record<string, bigint | number | null> | null>;
}

function userScoresTable(nf: boolean): UserScoresDelegate {
  return (nf ? prisma.userScoresNf : prisma.userScores) as unknown as UserScoresDelegate;
}

export async function getRanking(
  level: Level,
  order: Order,
  page: number,
  nf = false
): Promise<{ users: RankingUser[]; total: number; pageSize: number }> {
  const field = SCORE_FIELD(level, order);
  // NF（无标雷）榜切换数据源（移植 2008 版 Ranking_NF 的 *_Score_NF 语义）
  const table = userScoresTable(nf);
  const where = { [field]: { gt: 0 } };
  const total = await table.count({ where });
  const rows = await table.findMany({
    where,
    orderBy: { [field]: ORDER_DIRECTION[order] },
    skip: (page - 1) * RANKING_PAGESIZE,
    take: RANKING_PAGESIZE,
  });
  const authors = await usersByIds(rows.map((r) => N(r.id)));
  const vField = VIDEO_FIELD(level, order);
  const dField = DATE_FIELD(level, order);
  const users: RankingUser[] = await Promise.all(
    rows.map(async (r, i) => {
      const rec = r as unknown as Record<string, bigint | number | null>;
      const brief = authors.get(N(r.id)) ?? { id: N(r.id), chineseName: "?", englishName: "", sex: 1 };
      return {
        ...brief,
        rank: (page - 1) * RANKING_PAGESIZE + i + 1,
        score: N(rec[field] as number),
        videoId: N(rec[vField] as bigint),
        date: N(rec[dField] as bigint),
        title: await title(rec.sumTime as number | null),
      };
    })
  );
  return { users, total, pageSize: RANKING_PAGESIZE };
}

/** 「我在哪里」：计算用户在排行榜的页码（移植 Ranking::getPage，同分时从粗定位逐页扫描找到本人） */
export async function getRankingPageOfUser(id: number, level: Level, order: Order, nf = false): Promise<number> {
  const field = SCORE_FIELD(level, order);
  const table = userScoresTable(nf);
  const row = await table.findUnique({ where: { id: BigInt(id) } });
  if (!row) return -1;
  const score = Number((row as unknown as Record<string, number | null>)[field] ?? 0);
  if (!score) return -1;
  const better = await table.count({
    where:
      order === "time" ? { [field]: { lt: score, gt: 0 } } : { [field]: { gt: score } },
  });
  let offset = better - (better % RANKING_PAGESIZE);
  for (;;) {
    const rows = await table.findMany({
      where: { [field]: { gt: 0 } },
      select: { id: true },
      orderBy: { [field]: ORDER_DIRECTION[order] },
      skip: offset,
      take: RANKING_PAGESIZE,
    });
    if (!rows.length) return -1;
    if (rows.some((r) => N(r.id) === id)) return Math.floor(offset / RANKING_PAGESIZE) + 1;
    offset += RANKING_PAGESIZE;
  }
}

// ---------- 录像列表 ----------

export async function getVideoList(opts: {
  level: VideoLevel | "all";
  order: "id" | "time" | "3bvs" | "comments";
  author?: number;
  page: number;
}): Promise<{ videos: VideoListItem[]; total: number; pageSize: number }> {
  const { level, order, author, page } = opts;
  let ids: number[] = [];
  let total = 0;

  if (order === "comments") {
    // 热评录像（移植 2008 版 Video_Hot：按评论数降序）
    const where = { comments: { gt: 0 } };
    total = await prisma.videoStat.count({ where });
    const rows = await prisma.videoStat.findMany({
      where,
      select: { id: true },
      orderBy: { comments: "desc" },
      skip: (page - 1) * VIDEO_PAGESIZE,
      take: VIDEO_PAGESIZE,
    });
    ids = rows.map((r) => N(r.id));
  } else if (level === "all") {
    // 全部：按上传时间（id 倒序）
    const where = author ? { user: BigInt(author) } : {};
    total = await prisma.video.count({ where });
    const rows = await prisma.video.findMany({
      where,
      select: { id: true },
      orderBy: { id: "desc" },
      skip: (page - 1) * VIDEO_PAGESIZE,
      take: VIDEO_PAGESIZE,
    });
    ids = rows.map((r) => N(r.id));
  } else {
    // 指定级别：从对应成绩表取序（移植 VideoScores::listHighScores，仅 flag 榜）
    const table = scoresTable(level);
    const condField = order === "id" ? undefined : order === "time" ? "scoreTime" : "score3bvs";
    const where = {
      ...(author ? { user: BigInt(author) } : {}),
      ...(condField ? { [condField]: { gt: 0 } } : {}),
    };
    total = await table.count({ where: author ? { user: BigInt(author) } : {} });
    const orderField = order === "id" ? "id" : condField!;
    const orderDir = order === "id" ? "desc" : ORDER_DIRECTION[order];
    const rows = await table.findMany({
      where,
      select: { id: true },
      orderBy: { [orderField]: orderDir },
      skip: (page - 1) * VIDEO_PAGESIZE,
      take: VIDEO_PAGESIZE,
    });
    ids = rows.map((r: { id: bigint }) => N(r.id));
  }

  const videos = await getVideosByIds(ids);
  return { videos, total, pageSize: VIDEO_PAGESIZE };
}

// 三张成绩表字段结构一致，收敛为统一委托类型，避免 union delegate 不可调用
interface ScoresDelegate {
  count(args: { where?: Record<string, unknown> }): Promise<number>;
  findMany(args: {
    where?: Record<string, unknown>;
    select: { id: true };
    orderBy: Record<string, string>;
    skip: number;
    take: number;
  }): Promise<{ id: bigint }[]>;
}

function scoresTable(level: VideoLevel): ScoresDelegate {
  switch (level) {
    case "beg":
      return prisma.videoScoresBeg as unknown as ScoresDelegate;
    case "int":
      return prisma.videoScoresInt as unknown as ScoresDelegate;
    case "exp":
      return prisma.videoScoresExp as unknown as ScoresDelegate;
  }
}

async function getVideosByIds(ids: number[]): Promise<VideoListItem[]> {
  if (!ids.length) return [];
  const bigIds = ids.map(BigInt);
  const [videos, infos, stats] = await Promise.all([
    prisma.video.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoInfo.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoStat.findMany({ where: { id: { in: bigIds } } }),
  ]);
  const authors = await usersByIds(videos.map((v) => N(v.user)));
  const infoMap = new Map(infos.map((i) => [N(i.id), i]));
  const statMap = new Map(stats.map((s) => [N(s.id), s]));

  // 保持传入 ids 的顺序（移植 Value::orderByIds）
  const videoMap = new Map(videos.map((v) => [N(v.id), v]));
  const result: VideoListItem[] = [];
  for (const id of ids) {
    const v = videoMap.get(id);
    const info = infoMap.get(id);
    if (!v || !info) continue;
    const author = authors.get(N(v.user)) ?? null;
    const authorScores = author
      ? await prisma.userScores.findUnique({ where: { id: BigInt(author.id) } })
      : null;
    const stat = statMap.get(id);
    result.push({
      id,
      level: v.level,
      status: v.status,
      createTime: N(v.createTime),
      noflag: info.noflag,
      board3bv: info.board3bv,
      realTime: info.realTime,
      board: info.board,
      software: info.software,
      version: info.version,
      clicks: stat?.clicks ?? 0,
      comments: stat?.comments ?? 0,
      author,
      authorTitle: await title(authorScores?.sumTime),
    });
  }
  return result;
}

/** 审核列表（移植 Video::findByStatus：待审按 id 升序先到先审，其余按 id 倒序） */
export async function getReviewList(
  status: number,
  page: number
): Promise<{ videos: VideoListItem[]; total: number; pageSize: number }> {
  const where = { status };
  const total = await prisma.video.count({ where });
  const rows = await prisma.video.findMany({
    where,
    select: { id: true },
    orderBy: { id: status === VIDEO_STATUS.NORMAL ? "asc" : "desc" },
    skip: (page - 1) * VIDEO_PAGESIZE,
    take: VIDEO_PAGESIZE,
  });
  const videos = await getVideosByIds(rows.map((r) => N(r.id)));
  return { videos, total, pageSize: VIDEO_PAGESIZE };
}

// ---------- 录像详情 ----------

export interface VideoDetail extends VideoListItem {
  hash: string;
  filepath: string;
  signature: string;
  reviewUser: number | null;
  reviewTime: number | null;
  reviewer: UserBrief | null;
  downloads: number;
}

export async function getVideoDetail(id: number): Promise<VideoDetail | null> {
  const v = await prisma.video.findUnique({ where: { id: BigInt(id) } });
  if (!v) return null;
  const [info, stat, author, reviewer, authorScores] = await Promise.all([
    prisma.videoInfo.findUnique({ where: { id: v.id } }),
    prisma.videoStat.findUnique({ where: { id: v.id } }),
    prisma.user.findUnique({ where: { id: v.user } }),
    v.reviewUser ? prisma.user.findUnique({ where: { id: v.reviewUser } }) : null,
    prisma.userScores.findUnique({ where: { id: v.user } }),
  ]);
  if (!info) return null;
  return {
    id: N(v.id),
    level: v.level,
    status: v.status,
    hash: v.hash,
    createTime: N(v.createTime),
    reviewUser: v.reviewUser ? N(v.reviewUser) : null,
    reviewTime: v.reviewTime ? N(v.reviewTime) : null,
    reviewer: toBrief(reviewer),
    noflag: info.noflag,
    board3bv: info.board3bv,
    realTime: info.realTime,
    board: info.board,
    software: info.software,
    version: info.version,
    filepath: info.filepath,
    signature: info.signature,
    clicks: stat?.clicks ?? 0,
    comments: stat?.comments ?? 0,
    downloads: stat?.downloads ?? 0,
    author: toBrief(author),
    authorTitle: await title(authorScores?.sumTime),
  };
}

// ---------- 用户主页 ----------

export interface UserDetail {
  user: UserBrief & { area: string; avatar: string; createTime: number; lastLoginTime: number };
  info: { nickname: string; selfIntro: string | null; interest: string | null; qq: string; mouse: string; pad: string } | null;
  stat: { loginTimes: number; loginTime: number; points: number; begVideos: number; intVideos: number; expVideos: number } | null;
  scores: Record<string, { score: number | null; videoId: number | null; date: number | null }>;
  title: string;
}

export async function getUserDetail(id: number): Promise<UserDetail | null> {
  const u = await prisma.user.findUnique({ where: { id: BigInt(id) } });
  if (!u) return null;
  const [info, stat, scores] = await Promise.all([
    prisma.userInfo.findUnique({ where: { id: u.id } }),
    prisma.userStat.findUnique({ where: { id: u.id } }),
    prisma.userScores.findUnique({ where: { id: u.id } }),
  ]);
  const scoreMap: UserDetail["scores"] = {};
  const rec = (scores ?? {}) as unknown as Record<string, bigint | number | null>;
  for (const level of ["beg", "int", "exp", "sum"] as Level[]) {
    for (const order of ["time", "3bvs"] as Order[]) {
      const f = SCORE_FIELD(level, order);
      // sum 级别没有对应录像
      const hasVideo = level !== "sum";
      scoreMap[`${level}_${order}`] = {
        score: rec[f] != null ? Number(rec[f]) : null,
        videoId: hasVideo && rec[VIDEO_FIELD(level, order)] != null ? N(rec[VIDEO_FIELD(level, order)] as bigint) : null,
        date: hasVideo && rec[DATE_FIELD(level, order)] != null ? N(rec[DATE_FIELD(level, order)] as bigint) : null,
      };
    }
  }
  return {
    user: {
      ...toBrief(u)!,
      area: u.area,
      avatar: u.avatar,
      createTime: N(u.createTime),
      lastLoginTime: N(u.lastLoginTime),
    },
    info: info
      ? {
          nickname: info.nickname,
          selfIntro: info.selfIntro,
          interest: info.interest,
          qq: info.qq,
          mouse: info.mouse,
          pad: info.pad,
        }
      : null,
    stat: stat
      ? {
          loginTimes: N(stat.loginTimes),
          loginTime: N(stat.loginTime),
          points: stat.points,
          begVideos: stat.begVideos,
          intVideos: stat.intVideos,
          expVideos: stat.expVideos,
        }
      : null,
    scores: scoreMap,
    title: await title(scores?.sumTime),
  };
}

export async function getUserNews(userId: number, limit = 10): Promise<NewsItem[]> {
  return getNews({ userId, limit });
}

// ---------- 评论（移植 logic/Comment） ----------

export interface CommentItem {
  id: number;
  content: string;
  createTime: number;
  author: UserBrief | null;
}

/** 评论列表：cursor=0 取最新，否则取 id<cursor 的更早评论（移植 Comment::getList + actionMore） */
export async function getComments(
  videoId: number,
  cursor = 0,
  limit = COMMENT_TOP_NUMBER
): Promise<CommentItem[]> {
  const rows = await prisma.comment.findMany({
    where: {
      video: BigInt(videoId),
      status: COMMENT_STATUS.NORMAL,
      ...(cursor > 0 ? { id: { lt: BigInt(cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
  });
  const authors = await usersByIds([...new Set(rows.map((r) => N(r.user)))]);
  return rows.map((r) => ({
    id: N(r.id),
    content: r.content ?? "",
    createTime: N(r.createTime),
    author: authors.get(N(r.user)) ?? null,
  }));
}

/** 发表评论并递增录像评论计数（2013 版漏了计数递增，新版补齐） */
export async function addComment(videoId: number, userId: number, content: string): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [created] = await prisma.$transaction([
    prisma.comment.create({
      data: {
        video: BigInt(videoId),
        user: BigInt(userId),
        userScore: 0,
        content,
        status: COMMENT_STATUS.NORMAL,
        createTime: now,
        updateTime: now,
      },
    }),
    prisma.videoStat.update({
      where: { id: BigInt(videoId) },
      data: { comments: { increment: 1 } },
    }),
  ]);
  return N(created.id);
}

// ---------- 雷界统计（移植 2008 版 Main/Satus.asp 的 SP dbo.Satus） ----------

export interface SiteStats {
  userTotal: number;
  rankedTotal: number;
  videoTotal: number;
  videoToday: number;
  commentTotal: number;
  newbieThisMonth: number;
  avgBeg: number;
  avgInt: number;
  avgExp: number;
}

export async function getSiteStats(): Promise<SiteStats> {
  const now = new Date();
  const monthStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000));
  const dayStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000));
  const [userTotal, rankedTotal, videoTotal, videoToday, commentTotal, newbieThisMonth, avg] =
    await Promise.all([
      prisma.user.count(),
      prisma.userScores.count({ where: { sumTime: { gt: 0 } } }),
      prisma.video.count({ where: { status: VIDEO_STATUS.REVIEWED } }),
      prisma.video.count({ where: { createTime: { gte: dayStart } } }),
      prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL } }),
      prisma.user.count({ where: { createTime: { gte: monthStart } } }),
      prisma.userScores.aggregate({
        _avg: { begTime: true, intTime: true, expTime: true },
        where: { begTime: { gt: 0 }, intTime: { gt: 0 }, expTime: { gt: 0 } },
      }),
    ]);
  return {
    userTotal,
    rankedTotal,
    videoTotal,
    videoToday,
    commentTotal,
    newbieThisMonth,
    avgBeg: Math.round(avg._avg.begTime ?? 0),
    avgInt: Math.round(avg._avg.intTime ?? 0),
    avgExp: Math.round(avg._avg.expTime ?? 0),
  };
}

// ---------- 雷界生态（移植 2008 版 World/World.asp：各军衔人数分布） ----------

/** 雷界页顶部统计标签（2026-09-23 张老师要求：滚动窗口——新人 30 天内注册、今日录像 24 小时内上传） */
export interface WorldStats {
  rankedTotal: number;
  newbie30d: number;
  videoTotal: number;
  video24h: number;
  bbsTopics: number;
}

export async function getWorldStats(): Promise<WorldStats> {
  const now = Math.floor(Date.now() / 1000);
  const d30 = BigInt(now - 30 * 86400);
  const h24 = BigInt(now - 24 * 3600);
  const [rankedTotal, newbie30d, videoTotal, video24h, bbsTopics] = await Promise.all([
    prisma.userScores.count({ where: { sumTime: { gt: 0 } } }),
    prisma.user.count({ where: { createTime: { gte: d30 } } }),
    prisma.video.count(),
    prisma.video.count({ where: { createTime: { gte: h24 } } }),
    prisma.bbsPost.count({ where: { status: 0 } }),
  ]);
  return { rankedTotal, newbie30d, videoTotal, video24h, bbsTopics };
}

/** 各军衔人数（按 distribution 阈值对 sum_time 分桶：第 i 档 = (thresholds[i-1], thresholds[i]]） */
export async function getTitleCounts(): Promise<{ title: string; count: number }[]> {
  const dist = await getTitleDistribution();
  if (!dist) return [];
  const thresholds = dist.thresholds;
  const counts = await Promise.all(
    TITLES.map((_, i) => {
      const lower = i > 0 ? thresholds[i - 1] : undefined; // 上一军衔线（不含）
      const upper = i < TITLES.length - 1 ? thresholds[i] : undefined; // 本军衔线（含）；末档无上界
      return prisma.userScores.count({
        where: {
          sumTime: {
            gt: 0,
            ...(lower !== undefined ? { gt: lower } : {}),
            ...(upper !== undefined ? { lte: upper } : {}),
          },
        },
      });
    })
  );
  const result: { title: string; count: number }[] = TITLES.map((t, i) => ({
    title: t,
    count: counts[i] ?? 0,
  }));
  // 预备役：注册但没有任何总成绩的玩家（2026-09-23 新增，张老师要求）
  const [totalUsers, ranked] = await Promise.all([
    prisma.user.count(),
    prisma.userScores.count({ where: { sumTime: { gt: 0 } } }),
  ]);
  result.push({ title: "预备役", count: Math.max(0, totalUsers - ranked) });
  return result;
}

/** 神界全员（移植 2008 版 World/Hero.asp：大元帅/元帅/大将 = 编制前 41 人） */
export async function getHeroList(limit = 41): Promise<(UserBrief & { title: string; sumTime: number })[]> {
  const rows = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 } },
    orderBy: { sumTime: "asc" },
    take: limit,
  });
  const authors = await usersByIds(rows.map((r) => N(r.id)));
  return Promise.all(
    rows.map(async (r) => ({
      ...(authors.get(N(r.id)) ?? { id: N(r.id), chineseName: "?", englishName: "", sex: 1 }),
      title: await title(r.sumTime),
      sumTime: r.sumTime ?? 0,
    }))
  );
}

// ---------- 管理团队（移植 2008 版 Team/Index.asp：管理员 + 各自审核工作量） ----------

export interface TeamMember extends UserBrief {
  role: number;
  reviewCount: number;
}

export async function getTeam(): Promise<TeamMember[]> {
  const auths = await prisma.userAuth.findMany({
    where: { role: { in: [USER_ROLE.MANAGER, USER_ROLE.ADMINISTRATOR] } },
  });
  const authors = await usersByIds(auths.map((a) => N(a.id)));
  const members: TeamMember[] = [];
  for (const a of auths) {
    const reviewCount = await prisma.video.count({
      where: { reviewUser: a.id, status: VIDEO_STATUS.REVIEWED },
    });
    members.push({
      ...(authors.get(N(a.id)) ?? { id: N(a.id), chineseName: "?", englishName: "", sex: 1 }),
      role: a.role,
      reviewCount,
    });
  }
  return members.sort((x, y) => y.role - x.role || y.reviewCount - x.reviewCount);
}

/** 随机串门（移植 2008 版 Player/Random.asp：随机访问一个有成绩用户的地盘） */
export async function getRandomUserId(): Promise<number | null> {
  const total = await prisma.userScores.count({ where: { sumTime: { gt: 0 } } });
  if (!total) return null;
  const skip = Math.floor(Math.random() * total);
  const rows = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 } },
    select: { id: true },
    orderBy: { sumTime: "asc" },
    skip,
    take: 1,
  });
  return rows.length ? N(rows[0].id) : null;
}

// ---------- 排行榜（2008 编排：一行展示全部级别成绩，2026-09-23 张老师要求） ----------

export interface RankingRow extends UserBrief {
  rank: number;
  /** 8 列成绩原始存储值（时间=ms，3bvs=×1000），0=无成绩 */
  scores: Record<string, number>;
  /** 各级别成绩对应录像 id（sum 无录像=0） */
  videos: Record<string, number>;
  /** 主榜总计时间（军衔评定用；仅 NF 榜时与 scores.sum_time 不同，需额外回填） */
  overallSumTime?: number;
}

/**
 * 全级别排行表（移植 2008 版 Ranking_All：按 By 列排序，其余列随行带出）
 * @param by   排序列（beg_time…sum_3bvs）
 * @param nf   true 走 NF（无标雷）成绩表
 * @param area 限定地区（地区榜内页用）
 */
export async function getRankingTable(
  by: RankingBy,
  nf: boolean,
  page: number,
  area?: string
): Promise<{ rows: RankingRow[]; total: number; pageSize: number }> {
  const { level, order } = byLevelOrder(by);
  const field = SCORE_FIELD(level, order);
  const table = userScoresTable(nf);
  let idsWhere: Record<string, unknown> = { [field]: { gt: 0 } };
  if (area) {
    const areaUsers = await prisma.user.findMany({ where: { area }, select: { id: true } });
    idsWhere = { ...idsWhere, id: { in: areaUsers.map((u) => u.id) } };
  }
  const total = await table.count({ where: idsWhere });
  const rows = await table.findMany({
    where: idsWhere,
    orderBy: { [field]: ORDER_DIRECTION[order] },
    skip: (page - 1) * RANKING_PAGESIZE,
    take: RANKING_PAGESIZE,
  });
  const authors = await usersByIds(rows.map((r) => N(r.id)));
  // NF 榜：军衔按主榜总计时间评定（与榜单口径无关），需额外回填主榜 sum_time
  const overall = nf
    ? new Map(
        (
          await prisma.userScores.findMany({
            where: { id: { in: rows.map((r) => BigInt(N(r.id))) } },
            select: { id: true, sumTime: true },
          })
        ).map((s) => [N(s.id), N(s.sumTime)])
      )
    : null;
  const result: RankingRow[] = rows.map((r, i) => {
    const rec = r as unknown as Record<string, bigint | number | null>;
    const brief = authors.get(N(r.id)) ?? { id: N(r.id), chineseName: "?", englishName: "", sex: 1 };
    const scores: Record<string, number> = {};
    const videos: Record<string, number> = {};
    for (const b of RANKING_BYS) {
      const lo = byLevelOrder(b);
      scores[b] = N(rec[SCORE_FIELD(lo.level, lo.order)] as number);
      videos[b] = lo.level === "sum" ? 0 : N(rec[VIDEO_FIELD(lo.level, lo.order)] as bigint);
    }
    return {
      ...brief,
      rank: (page - 1) * RANKING_PAGESIZE + i + 1,
      scores,
      videos,
      ...(overall ? { overallSumTime: overall.get(N(r.id)) ?? 0 } : null),
    };
  });
  return { rows: result, total, pageSize: RANKING_PAGESIZE };
}

/** 雷界排行（总计时间）第一人 id：旧版称号「雷帝」判定用 */
export async function getFirstRankedUserId(nf = false): Promise<number | null> {
  const table = userScoresTable(nf);
  const rows = await table.findMany({
    where: { sumTime: { gt: 0 } },
    select: { id: true },
    orderBy: { sumTime: "asc" },
    take: 1,
  });
  return rows.length ? N(rows[0].id) : null;
}

/** 按中文姓名精确查找用户 id（「我在哪里」查找定位，移植 2008 版 Goto） */
export async function findUserByName(name: string): Promise<number | null> {
  const u = await prisma.user.findFirst({ where: { chineseName: name }, select: { id: true } });
  return u ? N(u.id) : null;
}

/** 用户总计时间名次（每日一星卡「第 N 位」） */
export async function getUserSumRank(id: number): Promise<number> {
  const row = await prisma.userScores.findUnique({ where: { id: BigInt(id) }, select: { sumTime: true } });
  if (!row?.sumTime) return 0;
  const better = await prisma.userScores.count({ where: { sumTime: { lt: row.sumTime, gt: 0 } } });
  return better + 1;
}

// ---------- 地区榜（移植 2008 版 Ranking_Area + Ranking_Area_Refresh 公式实时计算） ----------
// Area_Power = Σ(全国有成绩人数 − 个人名次)；Area_Players = 人数 + 0.0001×平均名次（排序微调）

export type AreaOrder = "power" | "players" | "avg" | "best";

export interface AreaRow {
  area: string;
  players: number;
  avgRank: number;
  bestRank: number;
  power: number;
  bestId: number;
  bestName: string;
  bestExpTime: number;
  bestSumTime: number;
  bestSex: number;
}

export async function getAreaRanking(order: AreaOrder = "power"): Promise<AreaRow[]> {
  const orderBy =
    order === "players"
      ? "players + 0.0001 * avg_rank DESC"
      : order === "avg"
        ? "avg_rank ASC"
        : order === "best"
          ? "best_rank ASC"
          : "power DESC";
  const rows = await prisma.$queryRawUnsafe<
    {
      area: string;
      players: bigint;
      avg_rank: number;
      best_rank: bigint;
      power: bigint;
      best_id: bigint;
      best_name: string;
      best_exp_time: number;
      best_sum_time: number;
      best_sex: number;
    }[]
  >(
    `WITH ranked AS (
        SELECT s.id, u.area,
              ROW_NUMBER() OVER (ORDER BY s.sum_time ASC) rk,
              COUNT(*) OVER () total
       FROM user_scores s JOIN user u ON u.id = s.id
       WHERE s.sum_time > 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
     ),
     agg AS (
       SELECT area, COUNT(*) players, ROUND(AVG(rk)) avg_rank, MIN(rk) best_rank,
              SUM(total - rk) power
       FROM ranked GROUP BY area
     )
     SELECT a.area, a.players, a.avg_rank, a.best_rank, a.power,
            r.id best_id, u.chinese_name best_name, s.exp_time best_exp_time, s.sum_time best_sum_time, u.sex best_sex
     FROM agg a
     JOIN ranked r ON r.area = a.area AND r.rk = a.best_rank
     JOIN user u ON u.id = r.id
     JOIN user_scores s ON s.id = r.id
     ORDER BY ${orderBy}`,
  );
  return rows.map((r) => ({
    area: r.area,
    players: N(r.players),
    avgRank: Number(r.avg_rank), // ROUND(AVG()) 返回 Decimal，React 不能直接渲染
    bestRank: N(r.best_rank),
    power: N(r.power),
    bestId: N(r.best_id),
    bestName: r.best_name,
    bestExpTime: r.best_exp_time,
    bestSumTime: r.best_sum_time,
    bestSex: r.best_sex,
  }));
}

/** 用户全国排名 + 省份排名（用户主页军衔徽章上方展示，09-23 晚张老师要求） */
export interface UserRanks {
  national: number; // 全国名次（主榜口径：总时间升序）
  area: string; // 军区名（用于文案）
  areaPos: number | null; // 省份名次（无军区/多地区为 null）
}

export async function getUserRanks(userId: number): Promise<UserRanks | null> {
  const rows = await prisma.$queryRaw<{ national: bigint; area: string; areaPos: bigint | null }[]>`
     WITH allr AS (
        SELECT s.id, u.area,
              ROW_NUMBER() OVER (ORDER BY s.sum_time ASC) npos
       FROM user_scores s JOIN user u ON u.id = s.id
       WHERE s.sum_time > 0
     ),
     arear AS (
        SELECT id, area,
              ROW_NUMBER() OVER (PARTITION BY area ORDER BY npos) apos
       FROM allr
       WHERE area <> '' AND area NOT LIKE '%&%'
     )
     SELECT a.npos national, a.area, b.apos areaPos
     FROM allr a LEFT JOIN arear b ON b.id = a.id
     WHERE a.id = ${userId}`;
  if (!rows.length) return null;
  return {
    national: N(rows[0].national),
    area: rows[0].area,
    areaPos: rows[0].areaPos === null ? null : N(rows[0].areaPos),
  };
}
