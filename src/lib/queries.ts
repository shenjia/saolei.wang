// 数据访问层：移植 2013 版 PHP 的 logic/* 查询语义
// 注意：user / user_info / user_stat / user_scores 共用同一主键（用户 id）
//       video / video_info / video_stat / video_scores_* 共用同一主键（录像 id）

import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { prisma } from "./db";
import { getTitleDistribution, title } from "./assess";
import {
  COMMENT_STATUS,
  COMMENT_TOP_NUMBER,
  HOME_NEWS_NUMBER,
  HOME_NEWBIE_NUMBER,
  HOME_TOP_NUMBER,
  LEVEL_MIN_3BV,
  MIN_3BV_FOR_3BVS,
  NEWS_HOME_TYPES,
  NEWS_TYPE,
  ORDER_DIRECTION,
  RANKING_PAGESIZE,
  TITLES,
  USER_ROLE,
  VIDEO_PAGESIZE,
  VIDEO_STATUS,
  VIDEO_LEVELS,
  byLevelOrder,
  RANKING_BYS,
  type AreaOrder,
  type BvRankingBy,
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
  /** 动态时刻该用户的高级时间 running best（军衔按当时值评定，getNews 批量重放） */
  expTime: number;
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

/** 作者信息 + 军衔（2026-10-13：评论区人名后显示军衔徽章用；BBS 作者同源复用） */
export interface UserBriefWithTitle extends UserBrief {
  /** 18 级军衔（按高级时间绝对阈值评定，distribution 阈值在 assess 内缓存） */
  title: string;
  /** 高级时间（秒，0=无成绩）——需要旧版称号（oldTitle）的场景直接复用，免二次查询 */
  expTime: number;
}

/** usersByIds 之上补军衔（批量：BBS 楼层作者、录像评论作者共用） */
export async function usersWithTitles(ids: number[]): Promise<Map<number, UserBriefWithTitle>> {
  const [briefs, scores] = await Promise.all([
    usersByIds(ids),
    ids.length
      ? prisma.userScores.findMany({
          where: { id: { in: ids.map(BigInt) } },
          select: { id: true, expTime: true },
        })
      : Promise.resolve([]),
  ]);
  const expMap = new Map(scores.map((s) => [N(s.id), s.expTime ?? 0]));
  const out = new Map<number, UserBriefWithTitle>();
  for (const [id, b] of briefs) {
    const exp = expMap.get(id) ?? 0;
    out.set(id, { ...b, title: await title(exp), expTime: exp });
  }
  return out;
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
  /** 多类型筛选（2026-10-13 用户主页「论坛」tab：发表主题 ARTICLE + 评论 COMMENT） */
  types?: number[];
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
      ...(opts.types ? { type: { in: opts.types } } : {}),
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
  // 军衔按「动态时刻」的高级时间评定（2026-10-13 SUB 制，张老师要求显示当时军衔而非现在的）：
  // 批量取相关用户的高级成绩流水，按每条动态的 create_time 重放 running best。
  // 入伍动态（NEWBIE）含同刻成绩：旧站入伍动态时间=触发成绩的上传时间，严格早于会永远评成预备役
  // （2026-10-13 张老师指出「入伍新兵怎么可能是预备役」）；破纪录动态仍严格早于（显示破之前旧军衔）
  const expMap = await expTimeAtBatch(
    [...new Set(rows.map((r) => r.user))],
    rows.map((r) => ({ user: N(r.user), ct: N(r.createTime), inclusive: r.type === NEWS_TYPE.NEWBIE }))
  );
  return rows.map((r) => ({
    id: N(r.id),
    type: r.type,
    userScore: r.userScore,
    expTime: expMap.get(`${N(r.user)}:${N(r.createTime)}`) ?? 0,
    reference: N(r.reference),
    details: safeJson(r.detailsData),
    createTime: N(r.createTime),
    author: authors.get(N(r.user)) ?? null,
  }));
}

/**
 * 批量重放「用户在指定时刻的高级时间 running best」（动态军衔显示当时值用）。
 * 取所有 (user, ct≤流水时间) 的成绩最小值；一次 IN 查询后在内存分组扫描。
 */
async function expTimeAtBatch(
  users: bigint[],
  points: { user: number; ct: number; inclusive?: boolean }[]
): Promise<Map<string, number>> {
  if (!users.length) return new Map();
  const flows = await prisma.videoScoresExp.findMany({
    where: { user: { in: users }, scoreTime: { gt: 0 } },
    select: { user: true, scoreTime: true, createTime: true },
  });
  // 按用户分组流水
  const byUser = new Map<number, { ct: number; s: number }[]>();
  for (const f of flows) {
    const uid = N(f.user);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push({ ct: N(f.createTime), s: N(f.scoreTime) });
  }
  for (const lst of byUser.values()) lst.sort((a, b) => a.ct - b.ct);
  const out = new Map<string, number>();
  for (const p of points) {
    const lst = byUser.get(p.user);
    if (!lst || !lst.length) continue;
    let best = 0;
    for (const f of lst) {
      // 默认严格早于动态时刻：同刻的成绩（含触发晋升/破纪录那盘）不改行首军衔——破纪录动态显示
      // 破之前的旧军衔（张老师 17:19 要求）；入伍动态用 inclusive（含同刻，显示入伍时的军衔）
      if (p.inclusive ? f.ct > p.ct : f.ct >= p.ct) break;
      if (!best || f.s < best) best = f.s;
    }
    out.set(`${p.user}:${p.ct}`, best);
  }
  return out;
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
  /** 与 getNews 的多类型口径一致（用户主页「论坛」tab 剩余条数） */
  types?: number[];
  userId?: number;
  level?: string;
  /** 与 getNews 的 home 口径一致（首页「加载更多」剩余条数） */
  home?: boolean;
}): Promise<number> {
  return prisma.news.count({
    where: {
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.types ? { type: { in: opts.types } } : {}),
      ...(opts.home ? { type: { in: NEWS_HOME_TYPES } } : {}),
      ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
      ...(opts.level ? { detailsData: { contains: `"lv":"${opts.level}"` } } : {}),
    },
  });
}

/** 国内 TOP10：按总计时间前 10（移植 home/_top；展示序仍按总时间，军衔列按高级时间评定）
 *  2026-10-13 张老师要求：原「十大元帅」更名「国内TOP10」，右列表由时间改为「所在地区」，
 *  故此处直接查 user（usersByIds 只回 UserBrief，不含 area） */
export async function getTopUsers(
  limit = HOME_TOP_NUMBER
): Promise<(UserBrief & { area: string; title: string; titleDate: number })[]> {
  const rows = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 } },
    orderBy: { sumTime: "asc" },
    take: limit,
  });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  const byId = new Map(users.map((u) => [N(u.id), u]));
  return rows.map((r) => {
    const u = byId.get(N(r.id));
    return {
      id: N(r.id),
      chineseName: u?.chineseName ?? "?",
      englishName: u?.englishName ?? "",
      sex: u?.sex ?? 1,
      area: u?.area ?? "",
      title: title(r.expTime),
      // 获得军衔的时间（近似值）：三项最好成绩日期中的最新一个
      titleDate: Math.max(N(r.begTimeDate), N(r.intTimeDate), N(r.expTimeDate)),
    };
  });
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
        title: title(rec.expTime as number | null),
      };
    })
  );
  return { users, total, pageSize: RANKING_PAGESIZE };
}

/** 「我在哪里」：计算用户在排行榜的页码（移植 Ranking::getPage，同分时从粗定位逐页扫描找到本人）。
 *  带 area 时限定该地区人口（2026-10-14 地区内页搜索定位；本人不在该地区返回 -1） */
export async function getRankingPageOfUser(
  id: number,
  level: Level,
  order: Order,
  nf = false,
  area?: string
): Promise<number> {
  const field = SCORE_FIELD(level, order);
  const table = userScoresTable(nf);
  const row = await table.findUnique({ where: { id: BigInt(id) } });
  if (!row) return -1;
  const score = Number((row as unknown as Record<string, number | null>)[field] ?? 0);
  if (!score) return -1;
  // 地区内页：人口限定该地区注册用户（与 getRankingTable 的 area 过滤同口径）
  let idIn: Record<string, unknown> | undefined;
  if (area) {
    const areaUsers = await prisma.user.findMany({ where: { area }, select: { id: true } });
    if (!areaUsers.some((u) => N(u.id) === id)) return -1;
    idIn = { id: { in: areaUsers.map((u) => u.id) } };
  }
  const better = await table.count({
    where: {
      ...(order === "time" ? { [field]: { lt: score, gt: 0 } } : { [field]: { gt: score } }),
      ...idIn,
    },
  });
  let offset = better - (better % RANKING_PAGESIZE);
  for (;;) {
    const rows = await table.findMany({
      where: { [field]: { gt: 0 }, ...idIn },
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

/**
 * 批量求用户在成绩榜中的名次（2026-10-14 张老师要求：搜索下拉也显示名次）。
 * 口径与榜单表格完全一致：区间 [field > 0] 内按 field 排序，**同分时 id 与主排序同向**
 * （榜单查询走 (field, id) 二级索引：升序=正向扫描 → 同分 id 升序；降序=反向扫描（EXPLAIN
 * 的 Backward index scan）→ 同分 id 降序。实测 3bvs 列同分极多，这个方向差会带来几十名偏差）。
 * 故名次 = 1 + 更好者数 + 同分且 id 更靠前者数（比较符与主排序同向）。
 * 不在表中或成绩为 0 的 id 不出现在结果里（前端显示「未加入排行」）。
 * 单条 SQL（候选 id 各做一次索引区间统计，12 个候选约 40ms），不缓存。
 */
export async function getRankOfUsers(
  ids: number[],
  by: RankingBy,
  nf = false,
  area?: string
): Promise<Map<number, number>> {
  // 只接受正整数 id 后直插 SQL（无注入面；配合下面的 0 值过滤）
  const uniq = [...new Set(ids.filter((i) => Number.isInteger(i) && i > 0))];
  if (!uniq.length) return new Map();
  const { level, order } = byLevelOrder(by);
  const col = `${level}_${order === "time" ? "time" : "3bvs"}`; // raw SQL 用 snake_case 列名
  const tbl = nf ? "user_scores_nf" : "user_scores";
  const cmp = order === "time" ? "<" : ">"; // time 越小越好、3bvs 越大越好（同分时 id 也按此向排）
  // 地区内页搜索（2026-10-14）：名次限定该地区人口（join `user` 过滤 area），
  // 本人不在该地区的 id 不出现在结果里（前端显示「未加入地区排行」）；area 一律 ? 传参
  if (area) {
    const rows = await prisma.$queryRawUnsafe<{ id: bigint; rk: bigint }[]>(
      `SELECT a.id, 1 + (SELECT COUNT(*) FROM ${tbl} b JOIN \`user\` ub ON ub.id = b.id AND ub.area = ?
          WHERE b.${col} > 0 AND (b.${col} ${cmp} a.${col} OR (b.${col} = a.${col} AND b.id ${cmp} a.id))) AS rk
        FROM ${tbl} a
        WHERE a.${col} > 0 AND a.id IN (${uniq.join(",")})
          AND a.id IN (SELECT id FROM \`user\` WHERE area = ?)`,
      area,
      area
    );
    return new Map(rows.map((r) => [N(r.id), N(r.rk)]));
  }
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; rk: bigint }[]>(
    `SELECT a.id, 1 + (SELECT COUNT(*) FROM ${tbl} b
        WHERE b.${col} > 0 AND (b.${col} ${cmp} a.${col} OR (b.${col} = a.${col} AND b.id ${cmp} a.id))) AS rk
      FROM ${tbl} a
      WHERE a.${col} > 0 AND a.id IN (${uniq.join(",")})`
  );
  return new Map(rows.map((r) => [N(r.id), N(r.rk)]));
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
  } else if (order === "3bvs") {
    // 3BVS 榜排除低 3BV 运气录像（2026-09-27 张老师要求：初级 3BV=2 的录像不进 3BVS 排序）。
    // 成绩表无 board_3bv 列，须联 video_info 过滤 board_3bv ≥ MIN_3BV_FOR_3BVS（=4，
    // 与渲染层删除线同阈值；旧站靠入库 max(3bvs,0)+score_3bvs>0 钳制，同步数据未钳制故补此）。
    const tbl = SCORES_TABLES[level];
    const authorCond = author ? ` AND s.user = ${BigInt(author)}` : "";
    const [cnt] = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COUNT(*) AS c FROM ${tbl} s JOIN video_info vi ON vi.id = s.id
       WHERE vi.board_3bv >= ${MIN_3BV_FOR_3BVS} AND s.score_3bvs > 0${authorCond}`
    );
    total = N(cnt.c);
    const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT s.id FROM ${tbl} s JOIN video_info vi ON vi.id = s.id
       WHERE vi.board_3bv >= ${MIN_3BV_FOR_3BVS} AND s.score_3bvs > 0${authorCond}
       ORDER BY s.score_3bvs DESC LIMIT ${size} OFFSET ${(page - 1) * size}`
    );
    ids = rows.map((r) => N(r.id));
  } else {
    // 指定级别 + 按上传时间/按成绩：从对应成绩表取序（移植 VideoScores::listHighScores，仅 flag 榜）
    const table = scoresTable(level);
    const condField = order === "time" ? "scoreTime" : undefined;
    const where = {
      ...(author ? { user: BigInt(author) } : {}),
      ...(condField ? { [condField]: { gt: 0 } } : {}),
    };
    total = await table.count({ where: author ? { user: BigInt(author) } : {} });
    const orderField = condField ?? "id";
    const orderDir: "asc" | "desc" = condField ? ORDER_DIRECTION[order as "time"] : "desc";
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

/**
 * 热门录像（/video 右栏版块，2026-09-26 张老师要求）：
 * 按上传时间倒序显示「至少两条评论」的录像，只带作者（名称+军衔）/级别/时间成绩。
 * 口径与 getVideoList 的 order=comments（videoStat.comments>0）一致，此处收紧为 ≥2。
 */
export async function getHotVideos(limit = 10): Promise<VideoListItem[]> {
  const rows = await prisma.videoStat.findMany({
    where: { comments: { gte: 2 } },
    select: { id: true },
    orderBy: { id: "desc" },
    take: limit,
  });
  return getVideosByIds(rows.map((r) => N(r.id)));
}

/**
 * 录像统计（/video 右栏版块）：级别细分 + 总数 + 评论总数，每行各带「今日新增」增量。
 * 2026-10-13 二轮：去掉本日/本周/本月三行，改为四行右侧统一挂今日增量列。
 * 2026-10-13 三轮（张老师要求）：末行增「评论总数」（口径与首页「发布评论」严格一致：
 *   comment.status=COMMENT_STATUS.NORMAL，增量按 create_time 落在今日）。
 */
export interface VideoBoxStats {
  /** 初级录像（仅已通过） */
  beg: number;
  /** 中级录像（仅已通过） */
  int: number;
  /** 高级录像（仅已通过） */
  exp: number;
  total: number;
  /** 今日新增（按级别）；口径与首页「上传录像」增量严格一致：status=REVIEWED 且 review_time 落在今日 */
  begToday: number;
  intToday: number;
  expToday: number;
  /** 今日新增合计（= 三段之和，不必再查库） */
  totalToday: number;
  /** 评论总数（仅正常状态，软删/屏蔽不计） */
  commentTotal: number;
  /** 评论今日新增（按 create_time；与首页「发布评论」口径一致） */
  commentToday: number;
}

export async function getVideoBoxStats(): Promise<VideoBoxStats> {
  const now = new Date();
  const dayStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000));
  // 两次 GROUP BY 一次取全（video 表无 status/level 索引，逐项 count 会各扫一遍全表）；
  // 今日量按 review_time 而非 create_time——与首页「上传录像（+N）」口径一致（审过才算新增）
  const [total, levelRows, todayRows, commentTotal, commentToday] = await Promise.all([
    prisma.video.count({ where: { status: VIDEO_STATUS.REVIEWED } }),
    prisma.video.groupBy({
      by: ["level"],
      where: { status: VIDEO_STATUS.REVIEWED },
      _count: { _all: true },
    }),
    prisma.video.groupBy({
      by: ["level"],
      where: { status: VIDEO_STATUS.REVIEWED, reviewTime: { gte: dayStart } },
      _count: { _all: true },
    }),
    prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL } }),
    prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL, createTime: { gte: dayStart } } }),
  ]);
  // 三段口径与「录像总数」严格一致（均只算已通过），故三者之和 = total
  const byLevel = new Map(levelRows.map((r) => [r.level, r._count._all]));
  const todayByLevel = new Map(todayRows.map((r) => [r.level, r._count._all]));
  const begToday = todayByLevel.get("beg") ?? 0;
  const intToday = todayByLevel.get("int") ?? 0;
  const expToday = todayByLevel.get("exp") ?? 0;
  return {
    beg: byLevel.get("beg") ?? 0,
    int: byLevel.get("int") ?? 0,
    exp: byLevel.get("exp") ?? 0,
    total,
    begToday,
    intToday,
    expToday,
    totalToday: begToday + intToday + expToday,
    commentTotal,
    commentToday,
  };
}

/** 某用户今日新增录像（按级别 + 合计）；口径与首页「上传录像」增量一致：status=REVIEWED 且 review_time 落在今日 */
export async function getUserTodayVideos(
  userId: number
): Promise<{ beg: number; int: number; exp: number; total: number }> {
  const now = new Date();
  const dayStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000));
  // 单用户走 (user, level) 索引；一次 GROUP BY 取三段
  const rows = await prisma.video.groupBy({
    by: ["level"],
    where: { user: BigInt(userId), status: VIDEO_STATUS.REVIEWED, reviewTime: { gte: dayStart } },
    _count: { _all: true },
  });
  const m = new Map(rows.map((r) => [r.level, r._count._all]));
  const beg = m.get("beg") ?? 0;
  const int = m.get("int") ?? 0;
  const exp = m.get("exp") ?? 0;
  return { beg, int, exp, total: beg + int + exp };
}

/**
 * 某用户「发表文章」（论坛主题）与「发表评论」（录像评论）数量 + 今日增量
 * （2026-10-13 张老师要求，用户主页右栏「数据统计」新增两行）。
 * 口径与首页「数据统计」的发布主题/发布评论严格一致：
 *   文章 = bbs_post.status=0（软删 -1 不计）；评论 = comment.status=COMMENT_STATUS.NORMAL；
 *   今日增量按 create_time 落在今天（站点自然日，与首页增量同一算法）。
 */
export async function getUserActivity(
  userId: number
): Promise<{ posts: number; postsToday: number; comments: number; commentsToday: number }> {
  const now = new Date();
  const dayStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000));
  const uid = BigInt(userId);
  const [posts, postsToday, comments, commentsToday] = await Promise.all([
    prisma.bbsPost.count({ where: { user: uid, status: 0 } }),
    prisma.bbsPost.count({ where: { user: uid, status: 0, createTime: { gte: dayStart } } }),
    prisma.comment.count({ where: { user: uid, status: COMMENT_STATUS.NORMAL } }),
    prisma.comment.count({
      where: { user: uid, status: COMMENT_STATUS.NORMAL, createTime: { gte: dayStart } },
    }),
  ]);
  return { posts, postsToday, comments, commentsToday };
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

// 成绩表物理表名（raw SQL 用，3BVS 榜联 video_info 过滤低 3BV）
const SCORES_TABLES: Record<VideoLevel, string> = {
  beg: "video_scores_beg",
  int: "video_scores_int",
  exp: "video_scores_exp",
};

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
      authorTitle: title(authorScores?.expTime),
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
    authorTitle: title(authorScores?.expTime),
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
    title: title(scores?.expTime),
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
  /** 作者军衔（2026-10-13 张老师要求：评论作者也显示军衔，与 BBS 楼层同款徽章） */
  authorTitle: string;
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
  // 2026-10-13：作者带军衔（评论人名后显示徽章，与 BBS 楼层同一实现）
  const authors = await usersWithTitles([...new Set(rows.map((r) => N(r.user)))]);
  return rows.map((r) => {
    const a = authors.get(N(r.user)) ?? null;
    return {
      id: N(r.id),
      content: r.content ?? "",
      createTime: N(r.createTime),
      author: a,
      authorTitle: a?.title ?? "",
    };
  });
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
      // cid = 本条评论 id：AI 后置复审要按它精确定位并撤下这一条动态
      // （同秒多条评论 createTime 相同，只靠时间会把别人的动态一并删掉）
      details: { kind: "video", cid: Number(created.id) },
      createTime: Number(now),
    });
    return N(created.id);
  });
}

// ---------- 雷界统计（移植 2008 版 Main/Satus.asp 的 SP dbo.Satus） ----------

export interface SiteStats {
  userTotal: number;
  userToday: number;
  rankedTotal: number;
  videoTotal: number;
  videoToday: number;
  commentTotal: number;
  commentToday: number;
  bbsTotal: number;
  bbsToday: number;
}

export async function getSiteStats(): Promise<SiteStats> {
  const now = new Date();
  const dayStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000));
  // 今日增量口径：排行人数不显示增量——user_scores.create_time 是注册时间非上榜时间，
  // 历史同步行全落在同步日（2019-05-18 / 2026-09-23），无干净数据源；
  // 录像增量按 review_time（与总数同 status=REVIEWED 口径，审过才算「今日新增」）
  const [
    userTotal, userToday,
    rankedTotal,
    videoTotal, videoToday,
    commentTotal, commentToday,
    bbsTotal, bbsToday,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createTime: { gte: dayStart } } }),
    prisma.userScores.count({ where: { sumTime: { gt: 0 } } }),
    prisma.video.count({ where: { status: VIDEO_STATUS.REVIEWED } }),
    prisma.video.count({ where: { status: VIDEO_STATUS.REVIEWED, reviewTime: { gte: dayStart } } }),
    prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL } }),
    prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL, createTime: { gte: dayStart } } }),
    prisma.bbsPost.count({ where: { status: 0 } }),
    prisma.bbsPost.count({ where: { status: 0, createTime: { gte: dayStart } } }),
  ]);
  return {
    userTotal,
    userToday,
    rankedTotal,
    videoTotal,
    videoToday,
    commentTotal,
    commentToday,
    bbsTotal,
    bbsToday,
  };
}

// ---------- 军衔页（移植 2008 版 World/World.asp：各军衔人数分布） ----------

/** 各军衔人数（2026-10-13 起按高级时间绝对阈值分桶：第 i 档 = (thresholds[i-1], thresholds[i]]） */
/** 各军衔人数（2026-10-13 SUB 制：TITLE_THRESHOLDS 与 TITLES 按下标对应，升序数组
 *  第 i 档 = (thresholds[i-1], thresholds[i]]，大元帅 = <= 35s，列兵 = > 150s 无上界） */
export async function getTitleCounts(): Promise<{ title: string; count: number }[]> {
  const thresholds = getTitleDistribution().thresholds;
  if (!thresholds.length) return [];
  const counts = await Promise.all(
    TITLES.map((_, i) => {
      const lower = i > 0 ? thresholds[i - 1] : undefined; // 上一档线（不含）
      const upper = i < TITLES.length - 1 ? thresholds[i] : undefined; // 本档线（含）；末档无上界
      return prisma.userScores.count({
        where: {
          expTime: {
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
  // 预备役：注册但没有任何高级成绩的玩家（2026-09-23 新增，2026-10-13 口径改高级）
  const [totalUsers, ranked] = await Promise.all([
    prisma.user.count(),
    prisma.userScores.count({ where: { expTime: { gt: 0 } } }),
  ]);
  result.push({ title: "预备役", count: Math.max(0, totalUsers - ranked) });
  return result;
}

// （雷神殿 getHeroList 已于 2026-10-13 随每日一星/神界概念一并移除，张老师要求）

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

/** 军衔→user_scores 查询条件（与 getTitleCounts 同口径，升序 thresholds：第 i 档 = (thresholds[i-1], thresholds[i]]）；预备役返回 null（查 user 表） */
async function titleScoresWhere(t: string): Promise<Record<string, unknown> | null> {
  const idx = TITLES.indexOf(t as (typeof TITLES)[number]);
  if (idx < 0) return null;
  const dist = getTitleDistribution();
  if (!dist.thresholds.length) return null;
  const lower = idx > 0 ? dist.thresholds[idx - 1] : undefined;
  const upper = idx < TITLES.length - 1 ? dist.thresholds[idx] : undefined;
  return {
    expTime: {
      gt: lower !== undefined ? lower : 0,
      ...(upper !== undefined ? { lte: upper } : {}),
    },
  };
}

/** 预备役→user 查询条件（id 不在有高级成绩集合内；2026-10-13 口径改高级） */
async function reserveWhere(): Promise<Record<string, unknown>> {
  const ranked = await prisma.userScores.findMany({
    where: { expTime: { gt: 0 } },
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
 * 普通军衔：user_scores 按 exp_time 升序 + 区间过滤，行含 8 列成绩与全局名次（名次=高级时间全局名次）；
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
    orderBy: [{ expTime: "asc" }, { id: "asc" }],
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
    const row = await prisma.userScores.findUnique({ where: { id: BigInt(uid) }, select: { expTime: true } });
    if (row?.expTime && row.expTime > 0) return -1; // 有高级成绩，不是预备役
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
  if (!row?.expTime || !(row.expTime > 0)) return -1;
  // 检验是否真在此军衔区间（同 titleScoresWhere 口径，升序 thresholds）
  const dist = getTitleDistribution();
  if (!dist.thresholds.length) return -1;
  const idx = TITLES.indexOf(t as (typeof TITLES)[number]);
  const upper = idx < TITLES.length - 1 ? dist.thresholds[idx] : Infinity;
  const lower = idx > 0 ? dist.thresholds[idx - 1] : 0;
  if (row.expTime > upper || row.expTime <= lower) return -1;
  // 排序键 (expTime asc, id asc)：数排在自己前面的行数
  const before = await prisma.userScores.count({
    where: {
      ...where,
      OR: [{ expTime: { lt: row.expTime } }, { expTime: row.expTime, id: { lte: BigInt(uid) } }],
    },
  });
  return before;
}

/** 批量取全局高级时间名次（ROW_NUMBER 与军衔列表 exp_time 升序同口径；map 缺省 0）
 *  注意：rank 为 MySQL 保留字，别名须反引号 */
async function getUserSumRanksBatch(ids: bigint[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<
    { id: bigint; rank: bigint }[]
  >`SELECT id, \`rank\` FROM (
      SELECT id, ROW_NUMBER() OVER (ORDER BY exp_time ASC) AS \`rank\`
      FROM user_scores WHERE exp_time > 0
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
  /** 主榜高级时间（军衔评定用；仅 NF 榜时与 scores.exp_time 不同，需额外回填） */
  overallExpTime?: number;
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
  // NF 榜：军衔按主榜高级时间评定（与榜单口径无关），需额外回填主榜 exp_time（2026-10-13 SUB 制）
  const overall = nf
    ? new Map(
        (
          await prisma.userScores.findMany({
            where: { id: { in: rows.map((r) => BigInt(N(r.id))) } },
            select: { id: true, expTime: true },
          })
        ).map((s) => [N(s.id), N(s.expTime)])
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
      ...(overall ? { overallExpTime: overall.get(N(r.id)) ?? 0 } : null),
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

// （getUserSumRank 每日一星卡专用，已随每日一星于 2026-10-13 移除）

// ---------- 地区榜（移植 2008 版 Ranking_Area + Ranking_Area_Refresh 公式实时计算） ----------
// Area_Power = Σ(全国有成绩人数 − 个人名次)；Area_Players = 人数 + 0.0001×平均名次（排序微调）
// 活跃人数＝该地区近 30 天内登录过的人数（user.last_login_time 为 Unix 秒，2026-10-13 新增）
// 榜序类型 AreaOrder 与表头定义在 lib/config（服务端与客户端共用），此处只做查询

export interface AreaRow {
  area: string;
  players: number;
  /** 近 30 天登录过的人数（含无成绩用户） */
  active: number;
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
      ? "players + 0.0001 * a.avg_rank DESC"
      : order === "active"
        ? "active DESC, a.power DESC"
        : order === "best"
          ? "best_rank ASC"
          : "power DESC";
  const rows = await prisma.$queryRawUnsafe<
    {
      area: string;
      players: bigint;
      active: bigint;
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
     ),
     act AS (
       SELECT u.area, COUNT(*) active
       FROM user u
       WHERE u.last_login_time > UNIX_TIMESTAMP() - 30 * 86400
         AND u.area <> '' AND u.area NOT LIKE '%&%'
       GROUP BY u.area
     )
     SELECT a.area, a.players, COALESCE(v.active, 0) active, a.best_rank, a.power,
            r.id best_id, u.chinese_name best_name, s.exp_time best_exp_time, s.sum_time best_sum_time, u.sex best_sex
     FROM agg a
     JOIN ranked r ON r.area = a.area AND r.rk = a.best_rank
     JOIN user u ON u.id = r.id
     JOIN user_scores s ON s.id = r.id
     LEFT JOIN act v ON v.area = a.area
     ORDER BY ${orderBy}`,
  );
  return rows.map((r) => ({
    area: r.area,
    players: N(r.players),
    active: N(r.active),
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

// ---------- 3BV 收集（2026-10-13 张老师方案：个人主页侧栏「3BV 收集」版块） ----------

/**
 * 各级别 3BV 收集区间（level_3bv_range 表，3 行小表，读取亚毫秒）。
 * 区间 = 站内已通过（status=REVIEWED）录像的 board_3bv 实际上下限，只扩不缩
 * （审核通过时在 lib/review.ts 同事务扩边）。
 * 2026-10-14 张老师：按现行排行规则收敛统计区间——下限钳到 LEVEL_MIN_3BV
 * （初 2 / 中 30 / 高 100），中级 <30、高级 <100 不再统计完成度；
 * 库里的行「只扩不缩」可能留着更低的下限，读取时钳（self-heal 补种同样钳）。
 * 缺行时从已通过录像现算并补种（自愈：兼容生产首次部署空表；主键幂等，
 * 并发补种最坏只是多跑一次现算）。
 */
export async function getLevel3bvRanges(): Promise<
  Partial<Record<VideoLevel, { min: number; max: number }>>
> {
  const rows = await prisma.level3bvRange.findMany();
  const out: Partial<Record<VideoLevel, { min: number; max: number }>> = {};
  for (const r of rows) {
    const level = r.level as VideoLevel;
    const min = Math.max(r.min3bv, LEVEL_MIN_3BV[level]);
    if (min <= r.max3bv) out[level] = { min, max: r.max3bv };
  }

  const missing = VIDEO_LEVELS.filter((l) => !out[l]);
  if (missing.length) {
    // 现算全站已通过录像的实际上下限（仅首次/缺行时跑一次）
    const agg = await prisma.$queryRaw<{ level: string; mn: number; mx: number }[]>`
      SELECT v.level, MIN(vi.board_3bv) AS mn, MAX(vi.board_3bv) AS mx
      FROM video v JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED}
      GROUP BY v.level`;
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const a of agg) {
      const level = a.level as VideoLevel;
      if (!missing.includes(level)) continue;
      const min = Math.max(N(a.mn), LEVEL_MIN_3BV[level]);
      const max = N(a.mx);
      if (min > max) continue; // 该级别全部低于统计下限，不出区间（侧栏该级整行隐藏）
      await prisma.level3bvRange.upsert({
        where: { level },
        create: { level, min3bv: min, max3bv: max, createTime: now, updateTime: now },
        update: {},
      });
      out[level] = { min, max };
    }
  }
  return out;
}

/**
 * 用户已收集的 3BV 集合（按级别分组的不同 board_3bv，仅已通过录像）。
 * 值 = { vid: 该 3BV 首个录像 id, t: 其上传时间 Unix 秒 }（id 序=上传时间序，
 * MIN(id)/MIN(create_time) 同盘），供侧栏方格气泡展示 + 点击跳首盘（2026-10-13 张老师要求）。
 * 2026-10-14 张老师：按现行排行规则收敛——低于 LEVEL_MIN_3BV（初 2 / 中 30 / 高 100）
 * 的 3BV 不计入收集（CASE 按级别取下限，与 BV 榜 fetchBvCollection 同口径）。
 * 走 video 表 (user, level) 索引 + video_info 主键 join，全站最重用户（5k+ 盘）毫秒级。
 */
export async function getUser3bvCollection(
  userId: number
): Promise<Record<VideoLevel, Map<number, { vid: number; t: number }>>> {
  const rows = await prisma.$queryRaw<{ level: string; b3bv: number; first_vid: bigint; first_ct: bigint }[]>`
    SELECT v.level, vi.board_3bv AS b3bv, MIN(v.id) AS first_vid, MIN(v.create_time) AS first_ct
    FROM video v JOIN video_info vi ON vi.id = v.id
    WHERE v.user = ${BigInt(userId)} AND v.status = ${VIDEO_STATUS.REVIEWED}
      AND vi.board_3bv >= CASE v.level
        WHEN 'beg' THEN ${LEVEL_MIN_3BV.beg}
        WHEN 'int' THEN ${LEVEL_MIN_3BV.int}
        ELSE ${LEVEL_MIN_3BV.exp} END
    GROUP BY v.level, vi.board_3bv`;
  const out: Record<VideoLevel, Map<number, { vid: number; t: number }>> = {
    beg: new Map(),
    int: new Map(),
    exp: new Map(),
  };
  for (const r of rows) out[r.level as VideoLevel]?.set(r.b3bv, { vid: N(r.first_vid), t: N(r.first_ct) });
  return out;
}

// ---------- BV 收集榜（2026-10-13 张老师需求：排行榜 NF 后新增 BV 榜，设计稿 design/ranking-bv.html v3） ----------

/** BV 榜条目：一名玩家的三级收集数 + 高级时间（军衔评定用） */
export interface BvRankingEntry {
  id: number;
  chineseName: string;
  sex: number;
  beg: number;
  int: number;
  exp: number;
  total: number;
  expTime: number;
}

export interface BvRankingRow extends BvRankingEntry {
  rank: number;
}

export interface BvRankingResult {
  rows: BvRankingRow[];
  total: number;
  pageSize: number;
  /** 各级别分母（level_3bv_range 实际上下限跨度）与总计分母 */
  den: Record<VideoLevel, number>;
  totalDen: number;
  /** 各级别区间（表头小字「2 – 51」用） */
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
}

// 全量收集聚合 1 小时缓存：30 万行级聚合并发会 P1017（铁律），
// 缓存后页面渲染/加载更多只是对万级小数组排序切片，DB 每小时最多被打一次。
// 注意改查询逻辑必须升缓存键版本号（unstable_cache 文件持久化，dev 重启不清）。
const fetchBvCollection = unstable_cache(
  async (): Promise<BvRankingEntry[]> => {
    const rows = await prisma.$queryRaw<
      {
        id: bigint;
        chinese_name: string;
        sex: number;
        exp_time: number | null;
        beg: number;
        inter: number;
        exp: number;
      }[]
    >`
      SELECT u.id, u.chinese_name, u.sex, us.exp_time,
        SUM(CASE WHEN t.level = 'beg' THEN t.n ELSE 0 END) AS beg,
        SUM(CASE WHEN t.level = 'int' THEN t.n ELSE 0 END) AS inter,
        SUM(CASE WHEN t.level = 'exp' THEN t.n ELSE 0 END) AS exp
      FROM (
        SELECT v.user, v.level, COUNT(DISTINCT vi.board_3bv) AS n
        FROM video v JOIN video_info vi ON vi.id = v.id
        WHERE v.status = ${VIDEO_STATUS.REVIEWED}
          AND vi.board_3bv >= CASE v.level
            WHEN 'beg' THEN ${LEVEL_MIN_3BV.beg}
            WHEN 'int' THEN ${LEVEL_MIN_3BV.int}
            ELSE ${LEVEL_MIN_3BV.exp} END
        GROUP BY v.user, v.level
      ) t
      JOIN user u ON u.id = t.user
      LEFT JOIN user_scores us ON us.id = t.user
      GROUP BY u.id, u.chinese_name, u.sex, us.exp_time`;
    return rows.map((r) => {
      const beg = N(r.beg);
      const inter = N(r.inter);
      const exp = N(r.exp);
      return {
        id: N(r.id),
        chineseName: r.chinese_name,
        sex: r.sex,
        beg,
        int: inter,
        exp,
        total: beg + inter + exp,
        expTime: N(r.exp_time),
      };
    });
  },
  ["bv-collection-v2"],
  { revalidate: 3600, tags: ["bv-collection"] }
);

/** 排序口径（页面 / 名次查询 / 下拉增强三处共用）：所选列降序，同数用户 ID 小在前（2026-10-13 张老师定） */
function sortBv(all: BvRankingEntry[], by: BvRankingBy): BvRankingEntry[] {
  return [...all].sort((a, b) => b[by] - a[by] || a.id - b.id);
}

/** 分母 = level_3bv_range 统计区间跨度（下限已按 LEVEL_MIN_3BV 钳制，上限随新录像突破自动扩展） */
function bvDenoms(ranges: Partial<Record<VideoLevel, { min: number; max: number }>>): {
  den: Record<VideoLevel, number>;
  totalDen: number;
} {
  const den: Record<VideoLevel, number> = { beg: 0, int: 0, exp: 0 };
  for (const l of VIDEO_LEVELS) {
    const r = ranges[l];
    if (r) den[l] = r.max - r.min + 1;
  }
  return { den, totalDen: den.beg + den.int + den.exp };
}

/** BV 收集榜一页。 */
export async function getBvRanking(by: BvRankingBy, page: number): Promise<BvRankingResult> {
  const [all, ranges] = await Promise.all([fetchBvCollection(), getLevel3bvRanges()]);
  const { den, totalDen } = bvDenoms(ranges);
  const sorted = sortBv(all, by);
  const rows = sorted
    .slice((page - 1) * RANKING_PAGESIZE, page * RANKING_PAGESIZE)
    .map((e, i) => ({ ...e, rank: (page - 1) * RANKING_PAGESIZE + i + 1 }));
  return { rows, total: sorted.length, pageSize: RANKING_PAGESIZE, den, totalDen, ranges };
}

/** BV 榜「用户 → 名次 + 总计收集数」索引（2026-10-14 搜索定位/下拉增强）：
 *  一次内存排序构建 Map，不在 Map 里即「未加入 BV 排行」。零 DB 重活（只有 3 行的 ranges 小表）。 */
export async function getBvBoardIndex(by: BvRankingBy): Promise<{
  index: Map<number, { rank: number; collected: number }>;
  total: number;
  totalDen: number;
}> {
  const [all, ranges] = await Promise.all([fetchBvCollection(), getLevel3bvRanges()]);
  const { totalDen } = bvDenoms(ranges);
  const sorted = sortBv(all, by);
  const index = new Map<number, { rank: number; collected: number }>();
  sorted.forEach((e, i) => index.set(e.id, { rank: i + 1, collected: e.total }));
  return { index, total: sorted.length, totalDen };
}

/**
 * BV 榜内求某人的名次与页码（2026-10-14 搜索定位，「BV 版我在哪里」）。
 * 走 1 小时缓存的全量数组做内存查找，零 DB 查询——比雷界榜 getRankingPageOfUser（打库分页循环）轻得多。
 * 不在榜（没有已通过审核的录像）返回 null。
 */
export async function getBvRankOfUser(
  id: number,
  by: BvRankingBy
): Promise<{ rank: number; page: number; collected: number; total: number; totalDen: number } | null> {
  const { index, total, totalDen } = await getBvBoardIndex(by);
  const hit = index.get(id);
  if (!hit) return null;
  return { rank: hit.rank, page: Math.floor((hit.rank - 1) / RANKING_PAGESIZE) + 1, collected: hit.collected, total, totalDen };
}
