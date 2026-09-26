// 数据访问层：移植 2013 版 PHP 的 logic/* 查询语义
// 注意：user / user_info / user_stat / user_scores 共用同一主键（用户 id）
//       video / video_info / video_stat / video_scores_* 共用同一主键（录像 id）

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { getTitleDistribution, title } from "./assess";
import {
  COMMENT_STATUS,
  COMMENT_TOP_NUMBER,
  HOME_NEWS_NUMBER,
  HOME_NEWBIE_NUMBER,
  HOME_TOP_NUMBER,
  NEWS_HOME_TYPES,
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
import { publishNews } from "./news";

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

/** 录像成绩：time=real_time(ms)，3bvs=board_3bv×1e6/real_time，3BV 过小记负（移植 VideoModel::getScores）
 *  2026-09-24 实现迁至 lib/format（纯模块，供客户端行渲染件共用），此处 re-export 兼容旧引用。 */
export { videoScores } from "./format";

// ---------- 首页 ----------

export async function getHomeNews(limit = HOME_NEWS_NUMBER): Promise<NewsItem[]> {
  return getNews({ limit, home: true });
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
  /** 首页新闻流口径：仅 NEWS_HOME_TYPES（注册/头像/发帖/评论动态不进首页，2026-09-24） */
  home?: boolean;
  limit: number;
}): Promise<NewsItem[]> {
  const rows = await prisma.news.findMany({
    where: {
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.home ? { type: { in: NEWS_HOME_TYPES } } : {}),
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
    // 兜底：历史数据可能带多余转义层（如 2019 转储的 {\"lv\":...}），去一层再试
    try {
      return JSON.parse(s.replace(/\\"/g, '"')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

/**
 * 动态总数（「加载更多」括号内显示剩余条数用）
 * 过滤条件与 getNews 严格一致，否则剩余条数会对不上
 */
export async function getNewsCount(opts: {
  type?: number;
  userId?: number;
  level?: string;
  /** 与 getNews 的 home 口径一致（首页「加载更多」剩余条数） */
  home?: boolean;
}): Promise<number> {
  return prisma.news.count({
    where: {
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.home ? { type: { in: NEWS_HOME_TYPES } } : {}),
      ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
      ...(opts.level ? { detailsData: { contains: `"lv":"${opts.level}"` } } : {}),
    },
  });
}

/** 十大元帅：按总计时间前 10（移植 home/_top） */
export async function getTopUsers(
  limit = HOME_TOP_NUMBER
): Promise<(UserBrief & { title: string; titleDate: number })[]> {
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
      // 获得军衔的时间（近似值）：三项最好成绩日期中的最新一个
      titleDate: Math.max(N(r.begTimeDate), N(r.intTimeDate), N(r.expTimeDate)),
    }))
  );
}

// ---------- 排行榜 ----------

// 字段名构造（导出给 ranksnap 进步榜复用，保证 8 列成绩映射一致）
export const SCORE_FIELD = (level: Level, order: Order) => `${level}${order === "time" ? "Time" : "3bvs"}` as const;
export const VIDEO_FIELD = (level: Level, order: Order) => `${level}${order === "time" ? "TimeVideo" : "3bvsVideo"}` as const;
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
  order: "id" | "time" | "3bvs" | "comments" | "clicks";
  author?: number;
  page: number;
  /** 每页条数（默认 VIDEO_PAGESIZE；用户主页录像版块传 USER_VIDEO_NUMBER，2026-09-26） */
  pageSize?: number;
}): Promise<{ videos: VideoListItem[]; total: number; pageSize: number }> {
  const { level, order, author, page } = opts;
  const size = opts.pageSize ?? VIDEO_PAGESIZE;
  let ids: number[] = [];
  let total = 0;

  if (order === "comments" || order === "clicks") {
    // 热评录像（移植 2008 版 Video_Hot：按评论数降序）/ 热门录像（按点击数降序）
    const field = order === "comments" ? "comments" : "clicks";
    const where = { [field]: { gt: 0 } };
    total = await prisma.videoStat.count({ where });
    const rows = await prisma.videoStat.findMany({
      where,
      select: { id: true },
      orderBy: { [field]: "desc" },
      skip: (page - 1) * size,
      take: size,
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
      skip: (page - 1) * size,
      take: size,
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
      skip: (page - 1) * size,
      take: size,
    });
    ids = rows.map((r: { id: bigint }) => N(r.id));
  }

  const videos = await getVideosByIds(ids);
  return { videos, total, pageSize: size };
}

/**
 * 录像流（首页录像版块用）：按上传时间（id 倒序）游标翻页，语义与动态列表一致。
 * 与 getVideoList 的区别：① 游标而非页码（配合「加载更多」）；② 级别筛选按录像本身的级别过滤，
 * 始终「最新在前」（getVideoList 在指定级别下会切到成绩表排序，不适用首页「最新录像」）。
 */
export async function getVideoFeed(opts: {
  level: VideoLevel | "all";
  cursor?: number;
  limit: number;
}): Promise<VideoListItem[]> {
  const rows = await prisma.video.findMany({
    where: {
      ...(opts.level !== "all" ? { level: opts.level } : {}),
      // 游标：取 id 小于 cursor 的更早录像（与动态 getNews 同语义）
      ...(opts.cursor ? { id: { lt: BigInt(opts.cursor) } } : {}),
    },
    select: { id: true },
    orderBy: { id: "desc" },
    take: opts.limit,
  });
  return getVideosByIds(rows.map((r) => N(r.id)));
}

/** 录像总数（「加载更多」括号内剩余条数口径，过滤条件与 getVideoFeed 严格一致） */
export async function getVideoCount(opts: { level?: VideoLevel | "all" } = {}): Promise<number> {
  return prisma.video.count({
    where: opts.level && opts.level !== "all" ? { level: opts.level } : {},
  });
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
  info: { nickname: string; interest: string | null; qq: string; mouse: string; pad: string } | null;
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

/** 评论总数（「加载更多」括号内显示剩余条数用，过滤条件与 getComments 一致） */
export async function getCommentsCount(videoId: number): Promise<number> {
  return prisma.comment.count({
    where: { video: BigInt(videoId), status: COMMENT_STATUS.NORMAL },
  });
}

/** 发表评论并递增录像评论计数（2013 版漏了计数递增，新版补齐）
 *  2026-09-24 起事务内同发「评论」动态（仅个人主页可见，不进首页新闻流） */
export async function addComment(videoId: number, userId: number, content: string): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        video: BigInt(videoId),
        user: BigInt(userId),
        userScore: 0,
        content,
        status: COMMENT_STATUS.NORMAL,
        createTime: now,
        updateTime: now,
      },
    });
    await tx.videoStat.update({
      where: { id: BigInt(videoId) },
      data: { comments: { increment: 1 } },
    });
    await publishNews({
      tx,
      type: NEWS_TYPE.COMMENT,
      userId,
      reference: videoId,
      details: { kind: "video" },
      createTime: Number(now),
    });
    return N(created.id);
  });
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

// ---------- 军衔页（移植 2008 版 World/World.asp：各军衔人数分布） ----------

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

// ---------- 军衔玩家列表（2026-09-24 张老师要求：徽章墙可点击查看本军衔所有玩家） ----------

export interface TitleMemberRow extends UserBrief {
  /** 全局总时间名次（1 起；预备役=行序号） */
  rank: number;
  sumTime: number;
  /** 注册时间（Unix 秒；预备役列表显示用） */
  createTime: number;
  /** 8 列成绩原始存储值（时间=ms，3bvs=×1000），0=无成绩（与 RankingRow 同构） */
  scores: Record<string, number>;
  /** 各级别成绩对应录像 id（sum 无录像=0） */
  videos: Record<string, number>;
}

/** 军衔→user_scores 查询条件（与 getTitleCounts 同口径：第 i 档 = (thresholds[i-1], thresholds[i]]）；预备役返回 null（查 user 表） */
async function titleScoresWhere(t: string): Promise<Record<string, unknown> | null> {
  const idx = TITLES.indexOf(t as (typeof TITLES)[number]);
  if (idx < 0) return null;
  const dist = await getTitleDistribution();
  if (!dist || !dist.thresholds.length) return null;
  const lower = idx > 0 ? dist.thresholds[idx - 1] : undefined;
  const upper = idx < TITLES.length - 1 ? dist.thresholds[idx] : undefined;
  return {
    sumTime: {
      gt: lower !== undefined ? lower : 0,
      ...(upper !== undefined ? { lte: upper } : {}),
    },
  };
}

/** 预备役→user 查询条件（id 不在有成绩集合内） */
async function reserveWhere(): Promise<Record<string, unknown>> {
  const ranked = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 } },
    select: { id: true },
  });
  return { id: { notIn: ranked.map((r) => r.id) } };
}

/** 本军衔玩家数（列表页头部用；-1=军衔名不合法） */
export async function getTitleMemberCount(t: string): Promise<number> {
  if (t === "预备役") return prisma.user.count({ where: await reserveWhere() });
  const where = await titleScoresWhere(t);
  if (!where) return -1;
  return prisma.userScores.count({ where });
}

/**
 * 本军衔玩家一页（偏移分页，cursor=已加载条数）——照搬排行表结构（getRankingTable）
 * 普通军衔：user_scores 按 sum_time 升序 + 区间过滤，行含 8 列成绩与全局名次；
 * 预备役：user 按注册时间倒序（无成绩列）。
 * @returns 不合法军衔返回 null
 */
export async function getTitleMembers(
  t: string,
  cursor: number,
  take = 20
): Promise<{ rows: TitleMemberRow[]; hasMore: boolean } | null> {
  if (t === "预备役") {
    const rows = await prisma.user.findMany({
      where: await reserveWhere(),
      orderBy: [{ createTime: "desc" }, { id: "desc" }],
      skip: cursor,
      take: take + 1,
      select: { id: true, chineseName: true, englishName: true, sex: true, createTime: true },
    });
    const hasMore = rows.length > take;
    return {
      rows: rows.slice(0, take).map((u) => ({
        id: N(u.id),
        chineseName: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        createTime: N(u.createTime),
        rank: cursor + 1, // 预备役序号=行号（1 起）
        sumTime: 0,
        scores: {},
        videos: {},
      })),
      hasMore,
    };
  }
  const where = await titleScoresWhere(t);
  if (!where) return null;
  const rows = await prisma.userScores.findMany({
    where,
    orderBy: [{ sumTime: "asc" }, { id: "asc" }],
    skip: cursor,
    take: take + 1,
  });
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const authors = await usersByIds(page.map((r) => N(r.id)));
  const ranks = await getUserSumRanksBatch(page.map((r) => r.id));
  return {
    rows: page.map((r) => {
      const rec = r as unknown as Record<string, bigint | number | null>;
      const scores: Record<string, number> = {};
      const videos: Record<string, number> = {};
      for (const b of RANKING_BYS) {
        const lo = byLevelOrder(b);
        scores[b] = N(rec[SCORE_FIELD(lo.level, lo.order)] as number);
        videos[b] = lo.level === "sum" ? 0 : N(rec[VIDEO_FIELD(lo.level, lo.order)] as bigint);
      }
      return {
        ...(authors.get(N(r.id)) ?? { id: N(r.id), chineseName: "?", englishName: "", sex: 1 }),
        createTime: 0,
        rank: ranks.get(N(r.id)) ?? 0,
        sumTime: N(r.sumTime),
        scores,
        videos,
      };
    }),
    hasMore,
  };
}

/**
 * 「我在哪里」：用户在本军衔列表的偏移量（用于定位到自己的位置）
 * @returns -1=不在此军衔/无成绩；否则返回行偏移（0 起，= 该行前有多少行）
 */
export async function getTitleMemberOffset(uid: number, t: string): Promise<number> {
  if (t === "预备役") {
    const row = await prisma.userScores.findUnique({ where: { id: BigInt(uid) }, select: { sumTime: true } });
    if (row?.sumTime && row.sumTime > 0) return -1; // 有成绩，不是预备役
    const me = await prisma.user.findUnique({ where: { id: BigInt(uid) }, select: { createTime: true } });
    if (!me) return -1;
    const where = await reserveWhere();
    // 排序键 (createTime desc, id desc)：数排在自己前面的行数
    const before = await prisma.user.count({
      where: {
        ...where,
        OR: [
          { createTime: { gt: me.createTime } },
          { createTime: me.createTime, id: { gt: BigInt(uid) } },
        ],
      },
    });
    return before;
  }
  const where = await titleScoresWhere(t);
  if (!where) return -1;
  const row = await prisma.userScores.findUnique({ where: { id: BigInt(uid) } });
  if (!row?.sumTime || !(row.sumTime > 0)) return -1;
  // 检验是否真在此军衔区间（同 titleScoresWhere 口径）
  const dist = await getTitleDistribution();
  if (!dist || !dist.thresholds.length) return -1;
  const idx = TITLES.indexOf(t as (typeof TITLES)[number]);
  const upper = idx < TITLES.length - 1 ? dist.thresholds[idx] : undefined;
  const lower = idx > 0 ? dist.thresholds[idx - 1] : 0;
  if (row.sumTime > (upper ?? Infinity) || row.sumTime <= lower) return -1;
  // 排序键 (sumTime asc, id asc)：数排在自己前面的行数
  const before = await prisma.userScores.count({
    where: {
      ...where,
      OR: [{ sumTime: { lt: row.sumTime } }, { sumTime: row.sumTime, id: { lte: BigInt(uid) } }],
    },
  });
  return before;
}

/** 批量取全局总时间名次（ROW_NUMBER 与排行榜 sum_time 升序同口径；map 缺省 0）
 *  注意：rank 为 MySQL 保留字，别名须反引号 */
async function getUserSumRanksBatch(ids: bigint[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<
    { id: bigint; rank: bigint }[]
  >`SELECT id, \`rank\` FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY sum_time ASC) AS \`rank\`
      FROM user_scores WHERE sum_time > 0
    ) r WHERE id IN (${Prisma.join(ids)})`;
  return new Map(rows.map((r) => [N(r.id), N(r.rank)]));
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

/** 排行榜搜索框模糊匹配推荐（2026-09-24 张老师要求）：中文姓名前缀→包含，
 *  英文名前缀兜底；纯数字按 ID 精确匹配（输入完整 ID 实时推荐该玩家）。
 *  前缀命中优先排序，取前 N 条（user 表 3.4 万行，contains 全扫可接受） */
export async function searchUsers(q: string, limit = 8): Promise<UserBrief[]> {
  const kw = q.trim();
  if (!kw) return [];
  const where: Prisma.UserWhereInput = /^\d+$/.test(kw)
    ? { id: BigInt(kw) } // ID 精确匹配（张老师要求：不按前缀）
    : {
        OR: [
          { chineseName: { startsWith: kw } },
          { chineseName: { contains: kw } },
          { englishName: { startsWith: kw } },
        ],
      };
  const rows = await prisma.user.findMany({
    where,
    select: { id: true, chineseName: true, englishName: true, sex: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  return rows.map((r) => ({ id: N(r.id), chineseName: r.chineseName, englishName: r.englishName, sex: r.sex }));
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
