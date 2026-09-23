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
  cursor?: number;
  limit: number;
}): Promise<NewsItem[]> {
  const rows = await prisma.news.findMany({
    where: {
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
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

/** 各军衔人数（按 distribution 阈值对 sum_time 分桶） */
export async function getTitleCounts(): Promise<{ title: string; count: number }[]> {
  const dist = await getTitleDistribution();
  if (!dist) return [];
  const thresholds = dist.thresholds;
  const counts: number[] = [];
  for (let i = 0; i < TITLES.length; i++) {
    const upper = thresholds[i]; // 该军衔的最好成绩线（含）
    const lower = thresholds[i + 1]; // 下一军衔线（不含）
    const where = {
      sumTime: {
        gt: 0,
        ...(upper !== undefined ? { lte: upper } : {}),
        ...(lower !== undefined ? { gt: lower } : {}),
      },
    };
    counts.push(await prisma.userScores.count({ where }));
  }
  return TITLES.map((t, i) => ({ title: t, count: counts[i] ?? 0 }));
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
