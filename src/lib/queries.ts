// 数据访问层：移植 2013 版 PHP 的 logic/* 查询语义
// 注意：user / user_info / user_stat / user_scores 共用同一主键（用户 id）
//       video / video_info / video_stat / video_scores_* 共用同一主键（录像 id）

import { prisma } from "./db";
import { title } from "./assess";
import {
  HOME_NEWS_NUMBER,
  HOME_NEWBIE_NUMBER,
  HOME_TOP_NUMBER,
  MIN_3BV_FOR_3BVS,
  NEWS_TYPE,
  ORDER_DIRECTION,
  RANKING_PAGESIZE,
  VIDEO_PAGESIZE,
  type Level,
  type Order,
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

async function usersByIds(ids: number[]): Promise<Map<number, UserBrief>> {
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

export async function getNews(opts: { type?: number; userId?: number; limit: number }): Promise<NewsItem[]> {
  const rows = await prisma.news.findMany({
    where: {
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
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

export async function getRanking(
  level: Level,
  order: Order,
  page: number
): Promise<{ users: RankingUser[]; total: number; pageSize: number }> {
  const field = SCORE_FIELD(level, order);
  const where = { [field]: { gt: 0 } };
  const total = await prisma.userScores.count({ where });
  const rows = await prisma.userScores.findMany({
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

// ---------- 录像列表 ----------

export async function getVideoList(opts: {
  level: VideoLevel | "all";
  order: "id" | "time" | "3bvs";
  author?: number;
  page: number;
}): Promise<{ videos: VideoListItem[]; total: number; pageSize: number }> {
  const { level, order, author, page } = opts;
  let ids: number[] = [];
  let total = 0;

  if (level === "all") {
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

function scoresTable(level: VideoLevel) {
  switch (level) {
    case "beg":
      return prisma.videoScoresBeg;
    case "int":
      return prisma.videoScoresInt;
    case "exp":
      return prisma.videoScoresExp;
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
  user: UserBrief & { area: string; avatar: string; createTime: number };
  info: { nickname: string; selfIntro: string | null; interest: string | null; qq: string; mouse: string; pad: string } | null;
  stat: { loginTimes: number; points: number; begVideos: number; intVideos: number; expVideos: number } | null;
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
