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
  FEED_USER_LEVEL_QUOTA,
  HOME_NEWS_NUMBER,
  HOME_NEWBIE_NUMBER,
  HOME_TOP_NUMBER,
  LEVEL_MAX_3BV,
  LEVEL_MIN_3BV,
  MIN_3BV_FOR_3BVS,
  UNREACHABLE_3BV,
  NEWS_FEED_EXCLUDED,
  NEWS_HOME_TYPES,
  NEWS_RECORD_FIRST_MARKS,
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
  type VideoListOrder,
  type VideoListDir,
  VIDEO_LIST_DEFAULT_DIR,
  parseVideoTimeWindow,
  parseVideo3bv,
} from "./config";
import { publishNews } from "./news";
import { rebuildUserRanksOnce } from "./userrank";
import { decodeLegacyEntities } from "./format";
import { liftExpiredBans } from "./ban";
import { AVATAR_UPLOAD_PREFIX } from "./avatar";
import { dualTitles, classicTitle, getThunderKingId, type TitlePair } from "./title-system";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// ---------- 类型 ----------

export interface UserBrief {
  id: number;
  chineseName: string;
  englishName: string;
  sex: number;
  /** 新版上传头像路径；无上传头像时缺省或空串（排行榜小头像用） */
  avatar?: string;
}

export interface NewsItem {
  id: number;
  type: number;
  /** 发布时是否在榜（快照；自选称号体系判「未加入排行」用） */
  ranked: boolean;
  /** 发布时刻高级时间 running best（毫秒，0=无成绩）——军衔按快照评定（2026-10-17 快照制） */
  expTime: number;
  reference: number;
  details: Record<string, unknown>;
  createTime: number;
  author: UserBrief | null;
  /** 双体系称号对（2026-10-17 Phase 5）：军衔 + 旧版称号，TitleBadge 按观看者体系渲染 */
  authorTitles: TitlePair | null;
  /** 录像评论动态的目标录像楼主（2026-10-22：渲染「评论了录像 楼主的高级xx.xx」用；
   *  仅 kind=video 且 details.vid 有效时带出，其余类型 null。楼主称号按其录像行内
   *  快照评定——发评论时楼主成绩已定格在该录像审核时刻，语义贴合） */
  videoOwner: (UserBrief & { titles: TitlePair | null }) | null;
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
  /** Phase 5 双体系：旧版称号备选（上传时刻快照评定） */
  authorClassic: { name: string; color: string } | null;
  /** 效率指标 IOE（video_metrics.ioe，无指标行为 null——2026-10-20 列表列显示用） */
  ioe: number | null;
  /** 判雷指标 STNB（video_metrics.stnb，无指标行为 null——2026-10-20 列表列显示用） */
  stnb: number | null;
}

// ---------- 通用 ----------

function toBrief(u: {
  id: bigint;
  chineseName: string;
  englishName: string;
  sex: number;
  avatar: string;
} | null): UserBrief | null {
  if (!u) return null;
  return {
    id: N(u.id),
    chineseName: u.chineseName,
    englishName: u.englishName,
    sex: u.sex,
    avatar: u.avatar,
  };
}

export async function usersByIds(ids: number[]): Promise<Map<number, UserBrief>> {
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: ids.map(BigInt) } } });
  return new Map(rows.map((r) => [N(r.id), toBrief(r)!]));
}

/** 当前榜页的真实头像（仅按需查 20 行，避免给 BV/STNB 全量缓存增加头像字段）。 */
async function rankingAvatarsByIds(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.user.findMany({
    where: {
      id: { in: ids.map(BigInt) },
      OR: [
        { avatar: { startsWith: AVATAR_UPLOAD_PREFIX } },
        { avatar: { startsWith: "http" } },
        { avatar: "1" }, // 旧站上传头像，实体为 /images/player/{id}.jpg
      ],
    },
    select: { id: true, avatar: true },
  });
  return new Map(rows.map((r) => [N(r.id), r.avatar]));
}

/** 作者信息 + 军衔（2026-10-13：评论区人名后显示军衔徽章用；BBS 作者同源复用） */
export interface UserBriefWithTitle extends UserBrief {
  /** 19 级军衔（按高级时间绝对阈值评定，distribution 阈值在 assess 内缓存） */
  title: string;
  /** 高级时间（秒，0=无成绩）——需要旧版称号（oldTitle）的场景直接复用，免二次查询 */
  expTime: number;
}

/** usersByIds 之上补军衔（批量：BBS 楼层作者、录像评论作者共用；
 *  2026-10-19 总司令=雷界第一人特判） */
export async function usersWithTitles(ids: number[]): Promise<Map<number, UserBriefWithTitle>> {
  const [briefs, scores, king] = await Promise.all([
    usersByIds(ids),
    ids.length
      ? prisma.userScores.findMany({
          where: { id: { in: ids.map(BigInt) } },
          select: { id: true, expTime: true },
        })
      : Promise.resolve([]),
    getThunderKingId(),
  ]);
  const expMap = new Map(scores.map((s) => [N(s.id), s.expTime ?? 0]));
  const out = new Map<number, UserBriefWithTitle>();
  for (const [id, b] of briefs) {
    const exp = expMap.get(id) ?? 0;
    out.set(id, { ...b, title: title(exp, king > 0 && king === id), expTime: exp });
  }
  return out;
}

// ---------- 称号快照（2026-10-17 快照制：写入时取「当时高级成绩 + 是否在榜」） ----------

export interface TitleSnapshot {
  /** 快照时刻高级时间 running best（毫秒，0=无成绩） */
  expTime: number;
  /** 快照时刻是否在榜（user.status=0） */
  ranked: boolean;
}

/**
 * 取用户称号快照（写入 news/comment/bbs/video 时调用）。
 * expTimeOverride：破纪录动态传覆盖前旧值（original.expTime）、入伍/晋升传更新后新值。
 * db 参数可传事务 client（publishNews 事务内免二次开连接）。
 */
export async function userTitleSnapshot(
  userId: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  expTimeOverride?: number
): Promise<TitleSnapshot> {
  const [scores, u] = await Promise.all([
    db.userScores.findUnique({
      where: { id: BigInt(userId) },
      select: { expTime: true },
    }),
    db.user.findUnique({ where: { id: BigInt(userId) }, select: { status: true } }),
  ]);
  return {
    expTime: expTimeOverride ?? (scores?.expTime ?? 0),
    ranked: u?.status === 0,
  };
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

/**
 * 动态级别筛选的 where 片段（展开到 where 顶层）。
 * 老站（MSSQL 原样搬入的 4.1 万条 type=20）写的是带空格 JSON `{"lv": "beg", ...}`，
 * 新站写紧凑 JSON `{"lv":"beg"}`——必须两种形态都匹配，否则筛选级别后
 * 3bvs 纪录动态（老站形态）全部漏掉（2026-10-16 张老师报告）。
 */
function newsLevelFilter(level: string) {
  return {
    OR: [
      { detailsData: { contains: `"lv":"${level}"` } },
      { detailsData: { contains: `"lv": "${level}"` } },
    ],
  };
}

/** 首页新闻流类型过滤（2026-10-25 张老师定，2026-10-26 扩口径）：NEWS_HOME_TYPES 白名单内，
 *  再排除破纪录动态（type=20）中的两类：
 *  ① 首创行 or=0 渲染「创造了」——成绩不值得放首页（10-25 原口径）；
 *  ② 预备役用户（快照 exp_time=0 或 ranked=0，与 title-system 预备役判定一致）——
 *    一律不进首页，**含「刷新了」or>0**（2026-10-26 张老师定：预备役的破纪录动态不进首页）。
 *  or=0 落库两种形态（新行数字 "or":0 / 同步存量行字符串 "or":"0"，渲染层 "0">0 同判 false），
 *  details_data 是 VarChar 无法做 JSON 路径过滤，用 contains 双标记匹配（形态普查 2026-10-25 全覆盖）。
 *  getNews / getNewsPage / getNewsCount 三处 home 分支共用，保证行集与计数严格一致 */
function homeNewsTypeFilter() {
  return {
    type: { in: NEWS_HOME_TYPES },
    NOT: {
      type: NEWS_TYPE.PERSON_RECORD,
      OR: [
        ...NEWS_RECORD_FIRST_MARKS.map((mark) => ({ detailsData: { contains: mark } })),
        // 预备役快照：无高级成绩 或 未在榜（news 表 exp_time/ranked 列，写入时定值）
        { expTime: BigInt(0) },
        { ranked: BigInt(0) },
      ],
    },
  };
}

export async function getNews(opts: {
  type?: number;
  /** 多类型筛选（2026-10-13 用户主页「论坛」tab：发表主题 ARTICLE + 评论 COMMENT） */
  types?: number[];
  userId?: number;
  /** 等级筛选（beg/int/exp）：按 details JSON 的 lv 字段匹配（details_data 全为 {"lv":...} 格式） */
  level?: string;
  /** keyset 游标：上一批末行的 id，服务端据此查 (create_time,id) 序更早的动态。
   *  2026-10-20 起动态流按 (create_time, id) 倒序（破纪录动态时间=录像上传时间，
   *  id 序不再等于时间序），cursor 单传 id 不再够用——实现上改为先查 cursor 行的
   *  create_time 再做 OR(create_time<ct / 同刻 id<id) keyset，保证翻页无缝。 */
  cursor?: number;
  /** 首页新闻流口径：仅 NEWS_HOME_TYPES（注册/头像/发帖/评论动态不进首页，2026-09-24） */
  home?: boolean;
  limit: number;
  /** 内部：直接指定 id 列表（getNewsPage 页码模式用；与 cursor 互斥） */
  ids?: bigint[];
}): Promise<NewsItem[]> {
  // 2026-10-20 张老师定：动态流按 (create_time, id) 倒序——破纪录动态时间取录像上传时间，
  // 补审积压时动态 id 追表尾而时间是旧的，id 序≠时间序（10-19 方案 B 改审核时间被否，
  // 一批补审动态时间全挤在过审时刻不可接受）。排序不再依赖「id 序=create_time 序」铁律。
  // cursor 为 keyset 语义：先取 cursor 行的 create_time，再 (ct,id) 双条件取更早行。
  let cursorTime: bigint | undefined;
  if (opts.cursor && !opts.ids) {
    const anchor = await prisma.news.findUnique({
      where: { id: BigInt(opts.cursor) },
      select: { createTime: true },
    });
    cursorTime = anchor?.createTime;
  }
  const where = {
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.types ? { type: { in: opts.types } } : {}),
    ...(opts.home ? homeNewsTypeFilter() : {}),
    ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
    ...(opts.level ? newsLevelFilter(opts.level) : {}),
    // keyset 游标：查 (create_time,id) 序比 cursor 行更早的动态（同刻按 id 分先后）
    ...(cursorTime !== undefined
      ? { OR: [{ createTime: { lt: cursorTime } }, { createTime: cursorTime, id: { lt: BigInt(opts.cursor!) } }] }
      : {}),
    // 2026-10-17 张老师定：上传录像动态（type=30）撤出动态流——录像一传就刷屏；
    // 首页/用户主页另有「录像」版块，信息不丢。显式 type/types 筛选（后台/论坛 tab）不受影响；
    // home 模式也不量加：NEWS_HOME_TYPES 已不含 VIDEO，且对象展开会覆盖 home 的 in 过滤
    ...(opts.type === undefined && !opts.types && !opts.home
      ? { type: { notIn: NEWS_FEED_EXCLUDED } }
      : {}),
  };
  const rows = await prisma.news.findMany({
    where: opts.ids ? { id: { in: opts.ids } } : where,
    orderBy: [{ createTime: "desc" }, { id: "desc" }],
    ...(opts.ids ? {} : { take: opts.limit }),
  });
  const authors = await usersByIds([...new Set(rows.map((r) => N(r.user)))]);
  // 2026-10-17 称号快照制：军衔按行内 exp_time/ranked 快照评定（写入时定值），
  // 不再按 video_scores_exp 流水重放——入伍/晋升「含同刻」、破纪录「严格早于」的口径
  // 已固化在写入点（review.ts publishNews expTimeOverride），历史行为一次性回填迁移。
  // Phase 5 双体系：批量补算旧版称号（TitlePair），TitleBadge 按观看者体系渲染
  // 2026-10-27 dualTitles 改行序数组（旧 Map 同用户多行塌缩）：按下标配对
  const pairList = await dualTitles(
    rows.map((r) => ({
      userId: N(r.user),
      expTime: N(r.expTime),
      ranked: r.ranked === BigInt(1),
      sex: authors.get(N(r.user))?.sex ?? 1,
    }))
  );
  // 录像评论动态的楼主身份批量补全（2026-10-22 张老师要求：渲染「评论了录像 楼主的高级xx.xx」，
  // 楼主要带姓名/性别/称号并可点进主页，与动态作者同款）——按 details.vid 聚合查询；
  // 楼主称号按其录像行内 exp_time/ranked 快照评定（video 表有这两列，见 getVideoDetail）
  const ownerIds = [
    ...new Set(
      rows
        .filter((r) => r.type === NEWS_TYPE.COMMENT && safeJson(r.detailsData).kind === "video")
        .map((r) => {
          const v = safeJson(r.detailsData).vid;
          return typeof v === "number" ? v : 0;
        })
        .filter((v) => v > 0)
    ),
  ];
  let ownerMap = new Map<number, UserBrief & { titles: TitlePair | null }>();
  if (ownerIds.length) {
    // 仅 kind=video 行的 reference 是录像 id（bbs 帖 id 与录像 id 同数值空间，混入会查到别人）
    const videoRefs = [
      ...new Set(
        rows
          .filter((r) => r.type === NEWS_TYPE.COMMENT && safeJson(r.detailsData).kind === "video")
          .map((r) => r.reference)
          .filter(Boolean)
      ),
    ];
    const [ownerBriefs, videoSnaps] = await Promise.all([
      usersByIds(ownerIds),
      prisma.video.findMany({
        where: { id: { in: videoRefs.map(BigInt) } },
        select: { id: true, user: true, expTime: true, ranked: true },
      }),
    ]);
    // vid → 该楼主的录像行快照（同一楼主多部录像取任一行，快照同值）
    const snapByOwner = new Map<number, { expTime: bigint; ranked: bigint }>();
    for (const v of videoSnaps) {
      const ou = N(v.user);
      if (!snapByOwner.has(ou)) snapByOwner.set(ou, { expTime: v.expTime, ranked: v.ranked });
    }
    const ownerPairs = await dualTitles(
      ownerIds.map((id) => ({
        userId: id,
        expTime: N(snapByOwner.get(id)?.expTime ?? 0),
        ranked: (snapByOwner.get(id)?.ranked ?? BigInt(0)) === BigInt(1),
        sex: ownerBriefs.get(id)?.sex ?? 1,
      }))
    );
    // dualTitles 行序数组（2026-10-27）：ownerIds 下标与 ownerPairs 一一对应
    ownerMap = new Map(
      ownerIds.flatMap((id, i) => {
        const b = ownerBriefs.get(id);
        return b ? [[b.id, { ...b, titles: ownerPairs[i] ?? null }] as const] : [];
      })
    );
  }
  return rows.map((r, i) => {
    const d = safeJson(r.detailsData);
    const vid = typeof d.vid === "number" ? d.vid : 0;
    const owner =
      r.type === NEWS_TYPE.COMMENT && d.kind === "video" && vid > 0
        ? ownerMap.get(vid) ?? null
        : null;
    return {
      id: N(r.id),
      type: r.type,
      ranked: r.ranked === BigInt(1),
      expTime: N(r.expTime),
      reference: N(r.reference),
      details: d,
      createTime: N(r.createTime),
      author: authors.get(N(r.user)) ?? null,
      authorTitles: pairList[i] ?? null,
      videoOwner: owner,
    };
  });
}

/** 动态页码模式（2026-10-14 用户主页动态翻页条）：(create_time,id) 倒序第 page 页起 limit 条。
 *  页锚点按 base（=调用方传入的页大小）计；skip 恒按 base 锚点，take 才是本批行数
 *  （与列表类 more 接口同语义）。两段查询：先 id 列表（带筛选条件）再复用 getNews 组装军衔。
 *  2026-10-20 排序随 getNews 从 id 倒序改为 (create_time,id) 倒序（上传时间口径，见 getNews 注释）。 */
export async function getNewsPage(opts: {
  types?: number[];
  userId?: number;
  level?: string;
  home?: boolean;
  page: number;
  base: number;
  limit: number;
}): Promise<NewsItem[]> {
  const where = {
    ...(opts.types ? { type: { in: opts.types } } : {}),
    ...(opts.home ? homeNewsTypeFilter() : {}),
    ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
    ...(opts.level ? newsLevelFilter(opts.level) : {}),
    // 同 getNews：上传录像动态撤出动态流（2026-10-17）；home 模式同样不叠加（避免覆盖 in 过滤）
    ...(opts.types || opts.home ? {} : { type: { notIn: NEWS_FEED_EXCLUDED } }),
  };
  const idRows = await prisma.news.findMany({
    where,
    select: { id: true },
    orderBy: [{ createTime: "desc" }, { id: "desc" }],
    skip: (opts.page - 1) * opts.base,
    take: opts.limit,
  });
  if (!idRows.length) return [];
  return getNews({
    types: opts.types,
    userId: opts.userId,
    level: opts.level,
    home: opts.home,
    limit: opts.limit,
    ids: idRows.map((r) => r.id),
  });
}

// （2026-10-17 称号快照制：原「expTimeAtBatch 流水重放」已整体移除——
//  渲染改读行内快照 exp_time/ranked，入伍/晋升/破纪录口径固化在写入点与
//  一次性回填脚本 scripts/backfill-title-snapshot.py 中）

function safeJson(s: string): Record<string, unknown> {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(s) as Record<string, unknown>;
  } catch {
    // 兜底：历史数据可能带多余转义层（如 2019 转储的 {\"lv\":...}），去一层再试
    try {
      obj = JSON.parse(s.replace(/\\"/g, '"')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  // 论坛动态的标题快照（t 字段）带老 ASP 转义实体，出口统一解码（2026-10-15，同 bbs 标题口径）
  if (typeof obj.t === "string") {
    obj = { ...obj, t: decodeLegacyEntities(obj.t) };
  }
  return obj;
}

/**
 * 动态总数（「加载更多」括号内显示剩余条数用）
 * 过滤条件与 getNews 严格一致，否则剩余条数会对不上
 */
async function getNewsCountImpl(opts: {
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
      ...(opts.home ? homeNewsTypeFilter() : {}),
      ...(opts.userId ? { user: BigInt(opts.userId) } : {}),
      ...(opts.level ? newsLevelFilter(opts.level) : {}),
      // 同 getNews：上传录像动态撤出动态流（2026-10-17）。home 模式下 NEWS_HOME_TYPES
      // 已不含 VIDEO，此处 notIn 不与之冲突；显式 type 筛选（后台按类型过滤）不受影响
      ...(opts.type === undefined && !opts.types && !opts.home
        ? { type: { notIn: NEWS_FEED_EXCLUDED } }
        : {}),
    },
  });
}

// 2026-10-15 上线前性能审计：news 23 万行无 type 索引时该 count 是全表扫描。
// 键空间有界的组合（首页 home / 版块 type(s) / 级别 level）缓存 60s；
// 带 userId 的组合每用户一档、键空间无界，直查不走缓存（用户页另有索引兜底）。
const fetchNewsCountNoUser = unstable_cache(
  async (opts: Omit<Parameters<typeof getNewsCountImpl>[0], "userId">) => getNewsCountImpl(opts),
  // v5：2026-10-26 home 口径扩「预备役破纪录一律不进首页」（exp_time/ranked=0 并入排除）。
  // v4：缓存 60s → 5min（2026-10-26 慢 SQL 巡检）。home 口径 10-25 上线首创行（or=0）双 LIKE
  // 排除后无法走索引，news 22.8 万行 count 全扫 avg 1.25s × 258 次/日（上线前基线 3 次/日）。
  // total 仅用于页码滑条 maxPage 与 hasMore，滞后 5 分钟无感（新动态多一页晚 5 分钟可翻）
  ["news-count-v5"],
  { revalidate: 300 }
);

export async function getNewsCount(opts: Parameters<typeof getNewsCountImpl>[0]): Promise<number> {
  if (opts.userId) return getNewsCountImpl(opts);
  return fetchNewsCountNoUser(opts);
}

// ---------- 封禁用户（旧站「停用」）与「上榜」口径 ----------
// 移植 2008 口径：旧站**所有「上榜」查询都带 `Player_IsLive=1`**（database/mssql/procedures.sql
// 数十处：排行榜 / 军衔人数 / 英雄榜 / 地区榜 / 随机串门），即停用账号**不上榜、不计入人数统计**；
// 而个人主页、录像/评论/帖子的归属照常显示（旧站 Player/Show.asp 也只是隐藏名次块）。
//
// 2026-10-14：旧站停用账号已全量导入新站（user.status=-1，见 scripts/sync/backfill-banned-users.py），
// 需要在新站复刻这条口径。user_scores 与 user 同主键，故用「封禁 id 黑名单」表达——
// 不动 schema；封禁量级仅数百，对 3.4 万行的 user_scores 代价可忽略。
// 原始 SQL 处直接 `JOIN \`user\` u ON u.id = s.id AND u.status = 0`（同义，且更省）。
// 缓存 60 秒：后台封禁/解封最多 1 分钟内体现在榜单。
// 2026-10-16 限时封禁：缓存重建前先清扫到期限时封禁（解禁+连坐录像恢复），
// 保证黑名单不含「已到期」账号。
const fetchBannedUserIds = unstable_cache(
  async (): Promise<number[]> => {
    await liftExpiredBans();
    const rows = await prisma.user.findMany({ where: { status: { not: 0 } }, select: { id: true } });
    return rows.map((r) => N(r.id));
  },
  ["banned-user-ids-v1"],
  { revalidate: 60 }
);

/** 「上榜」口径通用排除条件（无封禁用户时返回空对象，可直接展开进 where） */
export async function rankedOnly(): Promise<{ id?: { notIn: number[] } }> {
  const ids = await fetchBannedUserIds();
  return ids.length ? { id: { notIn: ids } } : {};
}

/** 「上榜」口径的 user 表条件（人数统计用）：只要正常账号 */
const ACTIVE_USER = { status: 0 } as const;

/** 该用户是否在榜（封禁用户一律不在榜；「我在哪里」/定位用） */
export async function isRankedUser(id: number): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: BigInt(id) }, select: { status: true } });
  return !!u && u.status === 0;
}

/** 国内 TOP10：按总计时间前 10（移植 home/_top；展示序仍按总时间，军衔列按高级时间评定）
 *  2026-10-13 张老师要求：原「十大元帅」更名「国内TOP10」，右列表由时间改为「所在地区」，
 *  故此处直接查 user（usersByIds 只回 UserBrief，不含 area） */
async function getTopUsersImpl(
  limit = HOME_TOP_NUMBER
): Promise<(UserBrief & { area: string; title: string; titleDate: number; classic: { name: string; color: string } | null })[]> {
  const rows = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 }, ...(await rankedOnly()) },
    orderBy: { sumTime: "asc" },
    take: limit,
  });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  const byId = new Map(users.map((u) => [N(u.id), u]));
  // Phase 5：批量补旧版称号备选（榜首即雷帝 TOP1，与 getThunderKingId 同源）
  // 2026-10-19：军衔制总司令=雷界第一人（rows 按 sum_time 升序，榜首即 king，取 0 位行）
  const kingId = rows.length ? N(rows[0].id) : 0;
  // dualTitles 行序数组（2026-10-27）：与 rows 下标一一对应
  const topPairs = await dualTitles(
    rows.map((r) => ({ userId: N(r.id), expTime: N(r.expTime), ranked: true, sex: byId.get(N(r.id))?.sex ?? 1 }))
  );
  return rows.map((r, i) => {
    const u = byId.get(N(r.id));
    return {
      id: N(r.id),
      chineseName: u?.chineseName ?? "?",
      englishName: u?.englishName ?? "",
      sex: u?.sex ?? 1,
      area: u?.area ?? "",
      title: title(r.expTime, N(r.id) === kingId),
      classic: topPairs[i]?.c ?? null,
      // 获得军衔的时间（近似值）：三项最好成绩日期中的最新一个
      titleDate: Math.max(N(r.begTimeDate), N(r.intTimeDate), N(r.expTimeDate)),
    };
  });
}

// 2026-10-15 性能审计：首页右栏排行前十，榜内成员极少变动，缓存 60s
const fetchTopUsers = unstable_cache(getTopUsersImpl, ["top-users-v2"], { revalidate: 60 });

export async function getTopUsers(
  limit = HOME_TOP_NUMBER
): Promise<(UserBrief & { area: string; title: string; titleDate: number; classic: { name: string; color: string } | null })[]> {
  return fetchTopUsers(limit);
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
  const where: Record<string, unknown> = { [field]: { gt: 0 }, ...(await rankedOnly()) };
  const total = await table.count({ where });
  const rows = await table.findMany({
    where,
    orderBy: { [field]: ORDER_DIRECTION[order] },
    skip: (page - 1) * RANKING_PAGESIZE,
    take: RANKING_PAGESIZE,
  });
  const authors = await usersByIds(rows.map((r) => N(r.id)));
  const king = await getThunderKingId(); // 2026-10-19 总司令=雷界第一人特判
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
        title: title(rec.expTime as number | null, king > 0 && king === N(r.id)),
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
  if (!(await isRankedUser(id))) return -1; // 封禁用户不在榜
  const row = await table.findUnique({ where: { id: BigInt(id) } });
  if (!row) return -1;
  const score = Number((row as unknown as Record<string, number | null>)[field] ?? 0);
  if (!score) return -1;
  // 地区内页：人口限定该地区注册用户（与 getRankingTable 的 area 过滤同口径）
  let idIn: Record<string, unknown> | undefined;
  if (area) {
    const areaUsers = await prisma.user.findMany({ where: { area, ...ACTIVE_USER }, select: { id: true } });
    if (!areaUsers.some((u) => N(u.id) === id)) return -1;
    idIn = { id: { in: areaUsers.map((u) => u.id) } };
  }
  const ranked = await rankedOnly();
  const better = await table.count({
    where: {
      ...(order === "time" ? { [field]: { lt: score, gt: 0 } } : { [field]: { gt: score } }),
      ...idIn,
      ...ranked,
    },
  });
  let offset = better - (better % RANKING_PAGESIZE);
  for (;;) {
    const rows = await table.findMany({
      where: { [field]: { gt: 0 }, ...idIn, ...ranked },
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
      `SELECT a.id, 1 + (SELECT COUNT(*) FROM ${tbl} b
            JOIN \`user\` ub ON ub.id = b.id AND ub.area = ? AND ub.status = 0
          WHERE b.${col} > 0 AND (b.${col} ${cmp} a.${col} OR (b.${col} = a.${col} AND b.id ${cmp} a.id))) AS rk
        FROM ${tbl} a
        WHERE a.${col} > 0 AND a.id IN (${uniq.join(",")})
          AND a.id IN (SELECT id FROM \`user\` WHERE area = ? AND status = 0)`,
      area,
      area
    );
    return new Map(rows.map((r) => [N(r.id), N(r.rk)]));
  }
  // 封禁用户不上榜：候选人自身与计数子查询都 join user.status = 0
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; rk: bigint }[]>(
    `SELECT a.id, 1 + (SELECT COUNT(*) FROM ${tbl} b
          JOIN \`user\` ub ON ub.id = b.id AND ub.status = 0
        WHERE b.${col} > 0 AND (b.${col} ${cmp} a.${col} OR (b.${col} = a.${col} AND b.id ${cmp} a.id))) AS rk
      FROM ${tbl} a
      JOIN \`user\` ua ON ua.id = a.id AND ua.status = 0
      WHERE a.${col} > 0 AND a.id IN (${uniq.join(",")})`
  );
  return new Map(rows.map((r) => [N(r.id), N(r.rk)]));
}

// ---------- 录像列表 ----------

/** 时间成绩搜索窗口 + 各排序有效性过滤的公共 WHERE 片段（行查询与 count 同源）。
 *  索引设计（2026-10-15 实测）：time/3bv 走 video_info 索引序扫描（免 30 万行 filesort），
 *  3bvs 计算比值走 (board_3bv, real_time) 复合覆盖索引（filesort 免回表），
 *  comments/clicks 走 video_stat 单列索引反向扫描；故 ORDER BY 不带跨表 tie-break
 *  （混合方向会强制 filesort；索引序扫描的并列键按 InnoDB (键,id) 物理序天然稳定）。
 *  返回 selectId：id 列取驱动表别名（vi/vs/v id 同值，各 join 形态下别名必须存在）。 */
function videoListConds(opts: {
  level: VideoLevel | "all";
  order: VideoListOrder;
  author?: number;
  win: [number, number] | null;
  /** 3BV 精确筛选（2026-10-20）：vi.board_3bv = N（显示值即库值，无舍入窗口） */
  bv: number | null;
  /** NF 筛选（2026-10-20 张老师要求）：只显示 NF 录像（vi.noflag=1） */
  nf: boolean;
}): { joins: string; where: string; selectId: string } {
  const { level, order, author, win, bv, nf } = opts;
  const needVi =
    !!win || !!bv || nf || order === "time" || order === "3bv" || order === "3bvs" || order === "stnb";
  const needVs = order === "comments" || order === "clicks";
  // 2026-10-20 ioe/stnb 排序：join video_metrics（指标行可能缺——老盘跑批已全量覆盖，
  // 仅个别解析失败盘无行；排序语义=「有指标者中排前」，缺行自然不出现）
  const needVm = order === "ioe" || order === "stnb";
  // 2026-10-20 stnb 单表化曾在此免 join（vm 与 v 全量一致）——2026-10-22 作废：
  // 前台列表屏蔽录像（status=0）一律不展示（张老师指令），vm 无 status 列必须
  // join video 过滤。
  // 2026-10-25 个人页排序卡顿修复（张老师报「STNB/IOE 比其他排序卡」）：FORCE INDEX
  // 收窄到无 author 的全站列表——author 过滤选择性极高（个人录像几百条 vs 全站 30 万），
  // FORCE 钉死 vm 驱动会沿全表指标序扫描找该用户的行（每行 video/video_info 两次 PK
  // 回表，级别筛选/翻页越深扫得越多）；IOE 更惨：ORDER BY ioe 用不上 stnb 索引 →
  // 全表扫 29.6 万行 + filesort（本地实测 ~0.9s，「等一会才刷新」的根因）。去 FORCE 后
  // 优化器走 video(user) 索引驱动 + 用户录像小集合 filesort（本地实测毫秒级）。
  // 全站路径保留 FORCE（2026-10-20「STNB 排序 10~12s」根因修复的主力），但索引按排序列
  // 匹配：ioe 排序反扫 ioe 索引——原两排序共用 stnb_idx 是笔误，[ioe] 索引建了却被
  // FORCE 废掉（全站 IOE 排序同样在吃全表扫 + filesort）。
  const table = needVm
    ? author
      ? "video_metrics vm"
      : `video_metrics vm FORCE INDEX (${
          order === "ioe" ? "video_metrics_ioe_idx" : "video_metrics_stnb_idx"
        })`
    : needVi
      ? "video_info vi"
      : needVs
        ? "video_stat vs"
        : "video v";
  // 2026-10-20 修复：驱动表之外的引用表必须补 JOIN——bv/time 筛选（needVi）+ comments/clicks
  // 排序（needVs）组合下，驱动表是 video_info 而 conds 引用 vs.comments/vs.clicks，
  // 漏 JOIN 直接 SQL 报错 500（线上定向列表点「评论/点击」无反应的根因）
  const joins = `FROM ${table} JOIN video v ON v.id = ${
    needVm ? "vm.id" : needVi ? "vi.id" : needVs ? "vs.id" : "v.id"
  }${needVi && needVm ? " JOIN video_info vi ON vi.id = v.id" : ""}${
    needVs && (needVi || needVm) ? " JOIN video_stat vs ON vs.id = v.id" : ""
  }`;
  const selectId = needVm ? "vm.id" : needVi ? "vi.id" : needVs ? "vs.id" : "v.id";
  const conds: string[] = [];
  // 2026-10-23 张老师指令：待审（status=10）录像即上前台（列表/首页流/个人主页，
  // 渲染层无「已审核✓」下标）；屏蔽（0）仍一律不进。原 2026-10-22 的全路径
  // v.status=20 过滤放宽为 <>0（旧站 2008 语义：IsLive=1 即显示，审核只管成绩入榜）
  conds.push(`v.status <> ${VIDEO_STATUS.BANNED}`);
  // NF 筛选（2026-10-20）：needVi 已因 nf=true 走 video_info 驱动/JOIN，
  // 此处统一 vi 列引用安全
  if (nf) conds.push(`vi.noflag = 1`);
  if (level !== "all") conds.push(`v.level = '${level}'`);
  if (author) conds.push(`v.user = ${BigInt(author)}`);
  if (win) conds.push(`vi.real_time >= ${win[0]} AND vi.real_time < ${win[1]}`);
  if (bv !== null) conds.push(`vi.board_3bv = ${bv}`);
  if (order === "time" || order === "3bvs" || order === "stnb") conds.push(`vi.real_time > 0`);
  // 运气盘限界（2026-10-20 张老师定：STNB 与 3BV/s 同口径，初级 3BV<10 不参与排行）：
  // 3bvs 与 stnb 共用 MIN_3BV_FOR_3BVS（初 10 / 中 4 / 高 4）——不限则初级 3BV=2 的
  // 0.09s 秒开盘 STNB 4316 会霸榜（STNB 榜同理，见 fetchStnbCollection）。
  // 2026-10-20 修复：bv 精确筛选时跳过限界——用户已锁定 3BV 集合（如初级 3BV=5 的
  // 定向列表），限界与筛选矛盾会把行全部滤空（线上点 3BVS/STNB「录像消失」根因）；
  // 无效成绩由渲染层处理（videoScores 低于限界记负值显示删除线，口径一致）
  if ((order === "3bvs" || order === "stnb") && bv === null)
    conds.push(
      `vi.board_3bv >= CASE v.level WHEN 'beg' THEN ${MIN_3BV_FOR_3BVS.beg} WHEN 'int' THEN ${MIN_3BV_FOR_3BVS.int} ELSE ${MIN_3BV_FOR_3BVS.exp} END`
    );
  if (order === "comments") conds.push(`vs.comments > 0`);
  if (order === "clicks") conds.push(`vs.clicks > 0`);
  return { joins, where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", selectId };
}

/** 列表总数（非默认排序/时间搜索路径）：join 计数有 0.1~0.5s 代价（30 万行），
 *  挂 60s 缓存（2026-10-15 上线前性能审计同口径：热点统计必须 unstable_cache）；
 *  键升级 v2（改查询逻辑必须升缓存键版本号）；v3（2026-10-20：videoListConds
 *  加 3bv 精确筛选与 ioe/stnb 排序，键空间随参数扩容）；v4（2026-10-20：stnb
 *  排序补运气盘限界 MIN_3BV_FOR_3BVS，与 3bvs 口径对齐）；v5（2026-10-20 修复：
 *  bv 筛选时跳过运气盘限界 + needVs 时补 video_stat JOIN——旧缓存里这些组合的
 *  计数是 0/陈旧值，必须失效）；v6（2026-10-20：stnb 无筛选路径单表化免 join，
 *  条件列同步换 vm 自身列——旧缓存计数同值但查询形态已变，失效重来）；
 *  v7（2026-10-20：加 NF 筛选参数，键空间扩容）；
 *  v8（2026-10-22：全路径统一 v.status=20 过滤（屏蔽/待审不进前台）——
 *  stnb 单表化作废恢复 join video，旧缓存计数含屏蔽行，必须失效）；
 *  v9（2026-10-23：待审放行进前台，过滤放宽 v.status<>0——旧缓存计数不含
 *  待审行，必须失效）；
 *  v10（2026-10-25：FORCE INDEX 收窄到无 author 路径 + ioe 排序改反扫 ioe 索引，
 *  查询计划形态变——旧缓存计数值仍正确但为彻底失效重来） */
const getVideoListJoinCount = unstable_cache(
  async (
    level: string,
    order: string,
    author: number,
    time: string,
    bv: number,
    nf: boolean
  ): Promise<number> => {
    const win = parseVideoTimeWindow(time);
    const { joins, where } = videoListConds({
      level: level as VideoLevel | "all",
      order: order as VideoListOrder,
      author: author || undefined,
      win,
      bv: bv || null,
      nf,
    });
    const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) AS c ${joins} ${where}`);
    return N(rows[0]?.c);
  },
  ["video-list-join-count", "v10"],
  { revalidate: 60 }
);

/**
 * 录像列表（2026-10-15 张老师需求重构：右侧排序 tabs 换搜索框后，排序改表头点击，
 * 6 列 × 级别/玩家/时间筛选须全组合可用）：
 * - order=id（默认，上传时间倒序）且无时间搜索：保持原路径（video 表 / 成绩表，
 *   2026-10-22 起按 (create_time, id) 倒序——真上传时间序，索引已补齐）；
 * - 其余排序或时间成绩搜索：统一 join 查询（驱动表与 ORDER BY 按排序键选索引，见 videoListConds）。
 * 时间成绩搜索：parseVideoTimeWindow 的 ±5ms 显示舍入窗口（匹配所有显示相同的成绩）。
 * 各排序方向：time 升序（快在前）、3bv 降序（大在前）、3bvs/stnb 降序（快/大在前，
 * 均排除运气盘：初级 3BV<10、中/高级 3BV<4，见 MIN_3BV_FOR_3BVS——2026-10-20 张老师定
 * STNB 成绩与 3BV/s 同口径，限界内才有效）、
 * comments/clicks 降序（多在前，保留原 >0 过滤口径）。
 */
export async function getVideoList(opts: {
  level: VideoLevel | "all";
  order: VideoListOrder;
  /** 排序方向（2026-10-23 升降序切换）：缺省=该列默认方向（VIDEO_LIST_DEFAULT_DIR） */
  dir?: VideoListDir;
  author?: number;
  /** 时间成绩搜索输入（秒字符串，如 "37.29"），非法输入忽略 */
  time?: string;
  /** 3BV 精确搜索输入（整数字符串，如 "42"），非法输入忽略（2026-10-20） */
  bv?: string;
  /** NF 筛选（2026-10-20 张老师要求）：true=只显示 NF 录像 */
  nf?: boolean;
  /** 屏蔽盘放行（2026-10-23 张老师需求）：true=不过滤 status=0（本人主页看自己被屏蔽
   *  的录像用）。仅默认排序（order=id 无搜索）路径支持；其余排序路径走
   *  videoListConds 仍滤屏蔽（个人页屏蔽盘排序无意义，本人按上传时间翻找即可） */
  includeBanned?: boolean;
  page: number;
  /** 每页条数（默认 VIDEO_PAGESIZE；用户主页录像版块传 USER_VIDEO_NUMBER，2026-09-26） */
  pageSize?: number;
  /** 页锚点（2026-10-26 修复「加载更多」跳行漏行）：OFFSET/skip 恒按本页基锚定，pageSize
   *  （size）退化为「本批行数 take」。原实现 OFFSET=(page-1)*size 与客户端页码按 20/页
   *  推进（page = winStart + items.length/20）基准错位——递增批量（40/80/100）下每次
   *  「加载更多」都跳过一段行且间隙越滚越大（81-130 行区间整段漏掉，玩家钱旭程评论=5
   *  的 342344 落在间隙里「翻不到」的根因）。对齐 BBS/Ranking/Grow/News 的
   *  skip-锚定-base 模式；锚点恒为 20（/video 列表与用户主页页基相同）。 */
  pageAnchor?: number;
}): Promise<{ videos: VideoListItem[]; total: number; pageSize: number }> {
  const { level, order, author, page } = opts;
  const size = opts.pageSize ?? VIDEO_PAGESIZE;
  const anchor = opts.pageAnchor ?? VIDEO_PAGESIZE;
  const win = parseVideoTimeWindow(opts.time);
  const bv = parseVideo3bv(opts.bv);
  const nf = !!opts.nf;
  // 方向归一（2026-10-23）：非法/缺省回退该列默认方向
  const dir: VideoListDir = opts.dir ?? VIDEO_LIST_DEFAULT_DIR[order];
  const asc = dir === "asc";

  if (order === "id" && !win && bv === null && !nf) {
    // 默认排序（上传时间倒序）原路径：全部=video 表；指定级别=成绩表。
    // 2026-10-22（张老师要求）：id 倒序 → (create_time, id) 倒序——历史同步数据
    // id 序≠上传时间序（本地库 27.8 万处相邻逆序），id 充当时间序时「上传时间」列乱序。
    // 成绩表 create_time 与 video 全量一致（本地校验 0 差异）；索引已补
    // （video: (level,create_time) / video_scores_*: create_time），实测首屏 ~0.06s
    // 2026-10-23 张老师指令：待审录像放行进前台——过滤从 status=20 放宽为 <>0
    // （屏蔽仍挡）；级别路径顺带简化：video_scores_* 只有过审管线写入（review.ts），
    // 待审盘必无成绩表行，驱动 video (level, create_time) 过滤 status 后再 join
    // 成绩表已无必要，回归 video 单表直出 id
    // 同日二轮：includeBanned=true 时连屏蔽盘也放行（本人主页看自己的屏蔽录像，
    // 渲染层红 ✕ 标记）——仅此两路径放行，其余前台面仍一律滤屏蔽
    const noBanFilter = !!opts.includeBanned;
    let ids: number[] = [];
    let total = 0;
    // 方向（2026-10-23 升降序切换）：默认路径按 (create_time,id) 排，asc=正序（最早在前）
    const timeDir = asc ? "asc" : "desc";
    if (level === "all") {
      const where = {
        ...(noBanFilter ? {} : { status: { not: VIDEO_STATUS.BANNED } }),
        ...(author ? { user: BigInt(author) } : {}),
      };
      total = await prisma.video.count({ where });
      const rows = await prisma.video.findMany({
        where,
        select: { id: true },
        orderBy: [{ createTime: timeDir }, { id: timeDir }],
        skip: (page - 1) * size,
        take: size,
      });
      ids = rows.map((r) => N(r.id));
    } else {
      // 级别默认排序：原走成绩表（video_scores_* create_time 索引序）——10-23 起
      // 待审盘也要出列，成绩表无待审行，改 video (level, create_time) 复合索引反扫
      const conds = [
        `v.level = '${level}'`,
        ...(noBanFilter ? [] : [`v.status <> ${VIDEO_STATUS.BANNED}`]),
        ...(author ? [`v.user = ${BigInt(author)}`] : []),
      ].join(" AND ");
      const totalRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) AS c FROM video v WHERE ${conds}`
      );
      total = N(totalRows[0]?.c);
      const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
        `SELECT v.id AS id FROM video v WHERE ${conds} ORDER BY v.create_time ${timeDir.toUpperCase()}, v.id ${timeDir.toUpperCase()} LIMIT ${size} OFFSET ${(page - 1) * size}`
      );
      ids = rows.map((r) => N(r.id));
    }
    const videos = await getVideosByIds(ids);
    return { videos, total, pageSize: size };
  }

  // 其余排序 / 时间搜索 / 3BV 搜索 / NF 筛选：统一 join 查询（order=id 且带搜索时按上传时间排序）。
  // 方向（2026-10-23 升降序切换）：各排序键 ASC/DESC 双向；默认排序+搜索沿 (create_time,id)
  // 索引序双向。方向与列内并列无关（索引序扫描的并列键按 InnoDB (键,id) 物理序天然稳定）
  const idOrder = nf
    ? `vi.create_time ${asc ? "ASC" : "DESC"}, vi.id ${asc ? "ASC" : "DESC"}`
    : `v.create_time ${asc ? "ASC" : "DESC"}, v.id ${asc ? "ASC" : "DESC"}`;
  const D = asc ? "ASC" : "DESC";
  const orderBy =
    order === "time"
      ? `vi.real_time ${D}`
      : order === "3bv"
        ? `vi.board_3bv ${D}`
        : order === "3bvs"
          ? `(vi.board_3bv * 1000000 / vi.real_time) ${D}`
          : order === "ioe"
            ? `vm.ioe ${D}`
            : order === "stnb"
              ? `vm.stnb ${D}`
              : order === "comments"
                ? `vs.comments ${D}`
                : order === "clicks"
                  ? `vs.clicks ${D}`
                  : idOrder; // 默认排序 + 时间/3BV 搜索：上传时间序（create_time 索引序）
  const { joins, where, selectId } = videoListConds({ level, order, author, win, bv, nf });
  const [total, idRows] = await Promise.all([
    getVideoListJoinCount(level, order, author ?? 0, opts.time ?? "", bv ?? 0, nf),
    // 2026-10-26 修复：OFFSET 恒按页锚点 20（页码语义），take 才是本批行数（递增批量）——
    // 原 (page-1)*size 在递增批量下跳行（详见 pageAnchor 注）
    prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT ${selectId} AS id ${joins} ${where} ORDER BY ${orderBy} LIMIT ${size} OFFSET ${(page - 1) * anchor}`
    ),
  ]);
  const videos = await getVideosByIds(idRows.map((r) => N(r.id)));
  return { videos, total, pageSize: size };
}

/**
 * 录像流（首页录像版块用）：按上传时间倒序游标翻页，语义与动态列表一致。
 * 与 getVideoList 的区别：① 游标而非页码（配合「加载更多」）；② 级别筛选按录像本身的级别过滤，
 * 始终「最新在前」（getVideoList 在指定级别下会切到成绩表排序，不适用首页「最新录像」）。
 * NF 筛选（2026-10-20 张老师要求）：nf=true 时只取 NF 录像（video_info.noflag=1）。
 * noflag 在 video_info（video 行不带），nf 路径改 raw SQL 单表扫 video_info——
 * 无 nf 索引下即全表扫过滤，实测 30 万行 count+首页页 ~0.3s，靠 60s count 缓存兜住。
 * 2026-10-22（张老师要求）：排序键 id DESC → (create_time, id) DESC——历史同步数据
 * id 序≠上传时间序（MSSQL 分组灌入，本地库 27.8 万处相邻逆序），id 充当时间序时
 * 「上传时间」列显示乱序。vi.create_time 与 v.create_time 全量一致（生产/本地校验 0 差异），
 * ORDER BY vi.create_time 吃 (noflag, create_time) 复合索引免 join 免 filesort。
 * 2026-10-22 张老师指令：屏蔽/待审录像不进前台——nf 路径 join video 滤 status=20
 * （单表免 join 优化作废；NF 全量 11.6 万行 join PK 等值查，实测 p1 仍 <0.1s）。
 * 2026-10-23：首页 SSR 已改走 getVideoFeedPage（发现流去重口径，见该函数注）；
 * 本函数仅剩 /api/video/more 游标分支（无调用方）引用，保持全量口径
 * （keyset 游标与配额去重不兼容，若未来启用需另行设计）。
 */
export async function getVideoFeed(opts: {
  level: VideoLevel | "all";
  cursor?: number;
  limit: number;
  nf?: boolean;
}): Promise<VideoListItem[]> {
  if (opts.nf) {
    const conds = [
      "v.status <> " + VIDEO_STATUS.BANNED,
      opts.level !== "all" ? `v.level = '${opts.level}'` : "",
      opts.cursor ? `vi.create_time < ${BigInt(opts.cursor)}` : "",
      "vi.noflag = 1",
    ]
      .filter(Boolean)
      .join(" AND ");
    // vi (noflag, create_time) 索引反扫驱动 + v PK 点查滤 status
    const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT vi.id FROM video_info vi JOIN video v ON v.id = vi.id WHERE ${conds} ORDER BY vi.create_time DESC, vi.id DESC LIMIT ${opts.limit}`
    );
    return getVideosByIds(rows.map((r) => N(r.id)));
  }
  const rows = await prisma.video.findMany({
    where: {
      // 2026-10-23 张老师指令：待审放行进前台（屏蔽仍挡），与 getVideoList 全路径同口径
      status: { not: VIDEO_STATUS.BANNED },
      ...(opts.level !== "all" ? { level: opts.level } : {}),
      // 游标：取 create_time 早于 cursor 的更早录像（动态 getNews 同语义；
      // (create_time, id) 双键稳定序，翻页无重复无遗漏）
      ...(opts.cursor ? { createTime: { lt: BigInt(opts.cursor) } } : {}),
    },
    select: { id: true },
    orderBy: [{ createTime: "desc" }, { id: "desc" }],
    take: opts.limit,
  });
  return getVideosByIds(rows.map((r) => N(r.id)));
}

/** 录像流页码模式（2026-10-14 四轮，首页录像版块翻页条）：上传时间倒序第 page 页起 limit 条。
 *  页锚点按 base（=调用方传入的页大小）计；skip 恒按 base 锚点，take 才是本批行数。
 *  NF 筛选（2026-10-20）：nf=true 走 video_info 单表 noflag 过滤（同 getVideoFeed nf 路径）。
 *  2026-10-22：排序键 id DESC → (create_time, id) DESC（真上传时间序，见 getVideoFeed 注）；
 *  同日张老师指令：屏蔽/待审不进前台（nf 路径 join video 滤 status=20）。
 *  2026-10-23（张老师定）防刷屏去重：发现流按 (用户, 级别) 分区配额——每人每级别最多露
 *  最新 FEED_USER_LEVEL_QUOTA 盘；纪录盘（user_scores(_nf) 12 个 *_video 指针 = 当前
 *  个人最好成绩）不占配额、永不参与淘汰（不进 ROW_NUMBER 计数，UNION ALL 直通）。
 *  仅首页发现流生效；/video 列表（getVideoList）、个人页、动态流保持全量口径。
 *  性能：全量窗口函数（30.9 万行排序物化）裸查 ~百 ms 级，按铁律 unstable_cache
 *  60s 兜底（[level,nf,page,base,limit] 键空间），首页第一页进 scripts/preheat.sh；
 *  冷页偶发一次重建（stale-while-revalidate 不阻塞请求）。 */

/** 纪录盘 id 集合子查询：user_scores / user_scores_nf 各 6 个 *_video 指针列
 *  （beg/int/exp × time/3bvs），指向即「当前有效个人最好成绩」——审核管线自动维护
 *  （破纪录换指针、屏蔽撤纪录清指针），无需独立清理任务。 */
const PB_VIDEO_IDS_SQL = `SELECT id FROM (
  SELECT beg_time_video AS id FROM user_scores WHERE beg_time_video IS NOT NULL
  UNION SELECT beg_3bvs_video FROM user_scores WHERE beg_3bvs_video IS NOT NULL
  UNION SELECT int_time_video FROM user_scores WHERE int_time_video IS NOT NULL
  UNION SELECT int_3bvs_video FROM user_scores WHERE int_3bvs_video IS NOT NULL
  UNION SELECT exp_time_video FROM user_scores WHERE exp_time_video IS NOT NULL
  UNION SELECT exp_3bvs_video FROM user_scores WHERE exp_3bvs_video IS NOT NULL
  UNION SELECT beg_time_video FROM user_scores_nf WHERE beg_time_video IS NOT NULL
  UNION SELECT beg_3bvs_video FROM user_scores_nf WHERE beg_3bvs_video IS NOT NULL
  UNION SELECT int_time_video FROM user_scores_nf WHERE int_time_video IS NOT NULL
  UNION SELECT int_3bvs_video FROM user_scores_nf WHERE int_3bvs_video IS NOT NULL
  UNION SELECT exp_time_video FROM user_scores_nf WHERE exp_time_video IS NOT NULL
  UNION SELECT exp_3bvs_video FROM user_scores_nf WHERE exp_3bvs_video IS NOT NULL
) pb`;

const fetchFeedDedupIdsImpl = async (
  level: VideoLevel | "all",
  nf: boolean,
  page: number,
  base: number,
  limit: number
): Promise<number[]> => {
  const lvCond = level !== "all" ? ` AND v.level = '${level}'` : "";
  // nf 视图 join video_info 滤 noflag（vi.create_time 与 v.create_time 全量一致，排序用 v 即可）
  const nfJoin = nf ? " JOIN video_info vi ON vi.id = v.id AND vi.noflag = 1" : "";
  const quota = FEED_USER_LEVEL_QUOTA;
  // 2026-10-23：status 过滤放宽 <>0（待审放行进首页流，屏蔽仍挡）——待审盘无
  // user_scores 指针、必不在纪录盘集合，自然走配额分支
  const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(`
    SELECT f.id FROM (
      SELECT q.id, q.create_time FROM (
        SELECT v.id AS id, v.create_time AS create_time,
               ROW_NUMBER() OVER (PARTITION BY v.user, v.level ORDER BY v.create_time DESC, v.id DESC) AS rn
        FROM video v${nfJoin}
        WHERE v.status <> ${VIDEO_STATUS.BANNED}${lvCond} AND v.id NOT IN (${PB_VIDEO_IDS_SQL})
      ) q WHERE q.rn <= ${quota}
      UNION ALL
      SELECT v.id, v.create_time FROM video v${nfJoin}
      WHERE v.status <> ${VIDEO_STATUS.BANNED}${lvCond} AND v.id IN (${PB_VIDEO_IDS_SQL})
    ) f
    ORDER BY f.create_time DESC, f.id DESC
    LIMIT ${limit} OFFSET ${(page - 1) * base}
  `);
  return rows.map((r) => N(r.id));
};
const fetchFeedDedupIds = unstable_cache(fetchFeedDedupIdsImpl, ["feed-dedup-v2"], { revalidate: 60 });

/** 首页发现流去重总数（与 fetchFeedDedupIds 口径严格一致）：
 *  Σ 每组 (用户,级别) 的 min(非纪录盘数, 配额) + 纪录盘总数。 */
const fetchFeedDedupCountImpl = async (level: VideoLevel | "all", nf: boolean): Promise<number> => {
  const lvCond = level !== "all" ? ` AND v.level = '${level}'` : "";
  const nfJoin = nf ? " JOIN video_info vi ON vi.id = v.id AND vi.noflag = 1" : "";
  const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(`
    SELECT (
      SELECT COALESCE(SUM(q.c), 0) FROM (
        SELECT LEAST(COUNT(*), ${FEED_USER_LEVEL_QUOTA}) AS c FROM video v${nfJoin}
        WHERE v.status <> ${VIDEO_STATUS.BANNED}${lvCond} AND v.id NOT IN (${PB_VIDEO_IDS_SQL})
        GROUP BY v.user, v.level
      ) q
    ) + (
      SELECT COUNT(*) FROM video v${nfJoin}
      WHERE v.status <> ${VIDEO_STATUS.BANNED}${lvCond} AND v.id IN (${PB_VIDEO_IDS_SQL})
    ) AS c
  `);
  return N(rows[0]?.c);
};
const fetchFeedDedupCount = unstable_cache(fetchFeedDedupCountImpl, ["feed-dedup-count-v2"], { revalidate: 60 });

/** 首页「最新录像」发现流总数（去重口径，2026-10-23）——
 *  仅首页 SSR 与 /api/video/more 的 feedPage 分支使用；/video 列表仍用 getVideoCount 全量口径。 */
export async function getVideoFeedCount(opts: { level?: VideoLevel | "all"; nf?: boolean } = {}): Promise<number> {
  return fetchFeedDedupCount(opts.level ?? "all", opts.nf === true);
}

export async function getVideoFeedPage(opts: {
  level: VideoLevel | "all";
  page: number;
  base: number;
  limit: number;
  nf?: boolean;
}): Promise<VideoListItem[]> {
  const ids = await fetchFeedDedupIds(opts.level, opts.nf === true, opts.page, opts.base, opts.limit);
  return getVideosByIds(ids);
}

/** 录像总数（「加载更多」括号内剩余条数口径，过滤条件与 getVideoFeed 严格一致）
 *  2026-10-15 性能审计：键空间仅 all/beg/int/exp 四档，缓存 60s（video 30 万行 count 走主键扫描）
 *  2026-10-20 NF 筛选：键空间扩 nf 维度（v2）——nf 路径 join video_info 全表扫过滤，
 *  实测 ~0.3s，必须走缓存（与铁律「热点统计查询必须挂 unstable_cache」一致）
 *  2026-10-22 v3：屏蔽/待审不进前台（张老师指令）——nf 路径加 v.status=20
 *  （join video 滤；原 vi 单表 SQL 形态已变），非 nf 路径 count 加 status 条件，
 *  旧缓存计数含 1285 部屏蔽行，必须失效重来；
 *  2026-10-23 v4：待审放行进前台——过滤放宽 v.status<>0，旧缓存计数不含待审行，失效 */
const fetchVideoCount = unstable_cache(
  async (opts: { level?: VideoLevel | "all"; nf?: boolean } = {}) => {
    if (opts.nf) {
      const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) AS c FROM video v JOIN video_info vi ON vi.id = v.id WHERE v.status <> ${VIDEO_STATUS.BANNED}${
          opts.level && opts.level !== "all" ? ` AND v.level = '${opts.level}'` : ""
        } AND vi.noflag = 1`
      );
      return N(rows[0]?.c);
    }
    return prisma.video.count({
      where: {
        status: { not: VIDEO_STATUS.BANNED },
        ...(opts.level && opts.level !== "all" ? { level: opts.level } : {}),
      },
    });
  },
  ["video-count-v4"],
  { revalidate: 60 }
);

export async function getVideoCount(opts: { level?: VideoLevel | "all"; nf?: boolean } = {}): Promise<number> {
  return fetchVideoCount(opts);
}

const HOT_VIDEO_WINDOW_SECONDS = 30 * 24 * 3600;
const HOT_VIDEO_COMMENT_WEIGHT = 20;

/**
 * 热门录像（现仅首页右栏使用）：近 30 天上传，按点击与他人有效评论综合排序。
 * 热度 = 点击量 + 有效评论数 × 20；评论只计 NORMAL，且 c.user <> v.user，
 * 排除作者自评（包括在自己录像下回复他人）对热度的影响。屏蔽录像仍不进前台。
 */
async function getHotVideosImpl(limit = 10): Promise<VideoListItem[]> {
  const cutoff = BigInt(Math.floor(Date.now() / 1000) - HOT_VIDEO_WINDOW_SECONDS);
  const safeLimit = Math.max(1, Math.floor(limit));
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    WITH hot_candidates AS (
      SELECT v.id, vs.clicks,
        (SELECT COUNT(*) FROM comment c
         WHERE c.video = v.id AND c.status = ${COMMENT_STATUS.NORMAL} AND c.user <> v.user
        ) AS external_comments
      FROM video v JOIN video_stat vs ON vs.id = v.id
      WHERE v.status <> ${VIDEO_STATUS.BANNED} AND v.create_time >= ${cutoff}
    )
    SELECT id FROM hot_candidates
    ORDER BY clicks + external_comments * ${HOT_VIDEO_COMMENT_WEIGHT} DESC, id DESC
    LIMIT ${safeLimit}`;
  return getVideosByIds(rows.map((r) => N(r.id)));
}

// 2026-10-26 v6：热评改热门——限近 30 天，点击 + 他人有效评论 × 20，升键作废旧缓存
const fetchHotVideos = unstable_cache(getHotVideosImpl, ["hot-videos-v6"], { revalidate: 60 });

export async function getHotVideos(limit = 10): Promise<VideoListItem[]> {
  return fetchHotVideos(limit);
}

// （2026-10-20 张老师要求 /video 列表改通栏、右栏「统计」板块下线——
//  getVideoBoxStats 与 VideoBoxStats 接口已随板块一并删除，无调用方）

/** 某用户今日新增录像（按级别 + 合计）；口径与首页「上传录像」增量一致：status<>0（屏蔽除外，
 * 2026-10-23 待审放行——但待审尚无 review_time，天然不落「今日审核」窗口，条件合并后语义不变）
 * 且 review_time 落在今日 */
export async function getUserTodayVideos(
  userId: number
): Promise<{ beg: number; int: number; exp: number; total: number }> {
  const now = new Date();
  const dayStart = BigInt(Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000));
  // 单用户走 (user, level) 索引；一次 GROUP BY 取三段
  const rows = await prisma.video.groupBy({
    by: ["level"],
    where: { user: BigInt(userId), status: { not: VIDEO_STATUS.BANNED }, reviewTime: { gte: dayStart } },
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
 * 口径与首页「数据统计」的论坛主题/录像评论严格一致（2026-10-22 首页行名更新后：
 *   主题对应论坛主题、此处「发表评论」仍是录像评论）：
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

// 成绩表物理表名（raw SQL 用）：原 3BVS 榜分支使用，2026-10-15 排序统一改 video ⋈ video_info
// 计算序后不再需要；2026-10-22 起默认排序级别路径也改 raw SQL（JOIN video 滤
// status=20，屏蔽不进前台）——ScoresDelegate/scoresTable 已无调用方，随之移除

async function getVideosByIds(ids: number[]): Promise<VideoListItem[]> {
  if (!ids.length) return [];
  const bigIds = ids.map(BigInt);
  const [videos, infos, stats, metrics] = await Promise.all([
    prisma.video.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoInfo.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoStat.findMany({ where: { id: { in: bigIds } } }),
    // 2026-10-20 列表 IOE/STNB 列：批量补指标（缺行=无指标，显示 -）
    prisma.videoMetrics.findMany({
      where: { id: { in: bigIds } },
      select: { id: true, ioe: true, stnb: true },
    }),
  ]);
  const authors = await usersByIds(videos.map((v) => N(v.user)));
  const infoMap = new Map(infos.map((i) => [N(i.id), i]));
  const statMap = new Map(stats.map((s) => [N(s.id), s]));
  const metricMap = new Map(metrics.map((m) => [N(m.id), m]));

  // 保持传入 ids 的顺序（移植 Value::orderByIds）
  // 2026-10-17 称号快照制：authorTitle 按录像行内 exp_time 快照评定（上传时刻军衔），
  // 不再批量查 user_scores 当前值。Phase 5：批量补算旧版称号
  // 2026-10-27 dualTitles 改行序数组（旧 Map 同用户多行塌缩——个人主页录像区
  // 整页同一人时全部共用同一军衔的根因）：视频下标与称号下标一一配对
  const pairList = await dualTitles(
    videos.map((v) => ({
      userId: N(v.user),
      expTime: N(v.expTime),
      ranked: v.ranked === BigInt(1),
      sex: authors.get(N(v.user))?.sex ?? 1,
    }))
  );
  const videoMap = new Map(videos.map((v) => [N(v.id), v]));
  const videoIdx = new Map(videos.map((v, i) => [N(v.id), i]));
  const result: VideoListItem[] = [];
  for (const id of ids) {
    const v = videoMap.get(id);
    const info = infoMap.get(id);
    if (!v || !info) continue;
    const author = authors.get(N(v.user)) ?? null;
    const stat = statMap.get(id);
    const m = metricMap.get(id);
    const p = pairList[videoIdx.get(id) ?? 0];
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
      authorTitle: p?.m ?? "",
      authorClassic: p?.c ?? null,
      ioe: m ? m.ioe : null,
      stnb: m ? m.stnb : null,
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
  const [info, stat, author, reviewer, metrics] = await Promise.all([
    prisma.videoInfo.findUnique({ where: { id: v.id } }),
    prisma.videoStat.findUnique({ where: { id: v.id } }),
    prisma.user.findUnique({ where: { id: v.user } }),
    v.reviewUser ? prisma.user.findUnique({ where: { id: v.reviewUser } }) : null,
    // 2026-10-20 VideoListItem 扩 ioe/stnb：详情页顺带补指标行（缺行=null）
    prisma.videoMetrics.findUnique({
      where: { id: v.id },
      select: { ioe: true, stnb: true },
    }),
  ]);
  if (!info) return null;
  // Phase 5 双体系：按录像行内快照评定双套称号（dualTitles 行序数组，2026-10-27）
  const [p] = await dualTitles([
    {
      userId: N(v.user),
      expTime: N(v.expTime),
      ranked: v.ranked === BigInt(1),
      sex: author?.sex ?? 1,
    },
  ]);
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
    // 2026-10-17 称号快照制：按录像行内快照评定（上传时刻军衔）
    authorTitle: p?.m ?? "",
    authorClassic: p?.c ?? null,
    ioe: metrics ? metrics.ioe : null,
    stnb: metrics ? metrics.stnb : null,
  };
}

// ---------- 用户主页 ----------

export interface UserDetail {
  user: UserBrief & { area: string; avatar: string; createTime: number; lastLoginTime: number; status: number };
  info: { nickname: string; interest: string | null; qq: string; mouse: string; pad: string } | null;
  stat: { loginTimes: number; loginTime: number; points: number; begVideos: number; intVideos: number; expVideos: number } | null;
  scores: Record<string, { score: number | null; videoId: number | null; date: number | null }>;
  title: string;
  /** Phase 5：旧版称号备选（当前成绩+在榜状态评定；用户主页大徽章区切换渲染） */
  classicTitle: { name: string; color: string } | null;
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
      // 账号状态（0 正常 / -1 封禁）：主页排名区对封禁用户显示红字提示用（2026-10-16 张老师要求）
      status: u.status,
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
    // 2026-10-19 总司令=雷界第一人特判（与雷帝同一判定源）
    title: title(scores?.expTime, (await getThunderKingId()) === id),
    // Phase 5：旧版称号备选（在榜=user.status===0 且有高级成绩；含雷帝 TOP1 判定）
    classicTitle:
      (
        await dualTitles([
          { userId: N(u.id), expTime: N(scores?.expTime ?? 0), ranked: u.status === 0 && (scores?.expTime ?? 0) > 0, sex: u.sex },
        ])
      )[0]?.c ?? null,
  };
}

export async function getUserNews(userId: number, limit = 10): Promise<NewsItem[]> {
  return getNews({ userId, limit });
}

// ---------- 评论（移植 logic/Comment） ----------

export interface CommentItem {
  id: number;
  /** 发布者 uid（2026-10-26：前台删除按钮按「发布者本人」判定渲染，不必再依赖 author?.id） */
  authorId: number;
  content: string;
  createTime: number;
  author: UserBrief | null;
  /** 作者军衔（快照评定，2026-10-17 快照制） */
  authorTitle: string;
  /** 双体系称号对（Phase 5）：旧版称号备选，TitleBadge 按观看者体系渲染 */
  authorClassic: { name: string; color: string } | null;
  /** 2026-10-22 本人可见待审行：0 正常 / 5 待审（AI 复审转待审后仅作者本人仍可见，渲染「审核中」徽章） */
  status: number;
}

/** 评论可见性（2026-10-22 张老师要求：评论发出后不管过没过审，发表者本人必须一直能看到）
 *  他人/游客只看 NORMAL(0)；本人额外看到自己 PENDING(5) 的行 */
function commentVisibleWhere(videoId: number, viewerUid: number | null) {
  return {
    video: BigInt(videoId),
    ...(viewerUid
      ? { OR: [{ status: COMMENT_STATUS.NORMAL }, { status: 5, user: BigInt(viewerUid) }] }
      : { status: COMMENT_STATUS.NORMAL }),
  };
}

/** 评论列表：cursor=0 取最新，否则取 id<cursor 的更早评论（移植 Comment::getList + actionMore） */
export async function getComments(
  videoId: number,
  cursor = 0,
  limit = COMMENT_TOP_NUMBER,
  viewerUid: number | null = null
): Promise<CommentItem[]> {
  const rows = await prisma.comment.findMany({
    where: {
      ...commentVisibleWhere(videoId, viewerUid),
      ...(cursor > 0 ? { id: { lt: BigInt(cursor) } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
  });
  // 2026-10-17 称号快照制：军衔按评论行内 exp_time 快照评定（回填脚本已迁移存量）
  // Phase 5 双体系：批量补算旧版称号
  // 2026-10-27 dualTitles 行序数组（旧 Map 同用户多条评论塌缩成同一军衔）
  const authors = await usersByIds([...new Set(rows.map((r) => N(r.user)))]);
  const pairList = await dualTitles(
    rows.map((r) => ({
      userId: N(r.user),
      expTime: N(r.expTime),
      ranked: r.ranked === BigInt(1),
      sex: authors.get(N(r.user))?.sex ?? 1,
    }))
  );
  return rows.map((r, i) => {
    const a = authors.get(N(r.user)) ?? null;
    const p = pairList[i];
    return {
      id: N(r.id),
      authorId: N(r.user),
      content: r.content ?? "",
      createTime: N(r.createTime),
      author: a,
      authorTitle: p?.m ?? "",
      authorClassic: p?.c ?? null,
      status: r.status,
    };
  });
}

/** 评论总数（「加载更多」括号内显示剩余条数用，过滤条件与 getComments 一致——含本人待审行） */
export async function getCommentsCount(videoId: number, viewerUid: number | null = null): Promise<number> {
  return prisma.comment.count({
    where: commentVisibleWhere(videoId, viewerUid),
  });
}

/** 按 id 取单条评论（发表接口返回新行用，2026-10-22）：作者信息/称号与列表同口径 */
export async function getCommentById(id: number): Promise<CommentItem | null> {
  const rows = await prisma.comment.findMany({
    where: { id: BigInt(id), status: { in: [COMMENT_STATUS.NORMAL, 5] } },
    take: 1,
  });
  if (!rows.length) return null;
  const r = rows[0];
  const authors = await usersByIds([N(r.user)]);
  const [p] = await dualTitles([
    {
      userId: N(r.user),
      expTime: N(r.expTime),
      ranked: r.ranked === BigInt(1),
      sex: authors.get(N(r.user))?.sex ?? 1,
    },
  ]);
  return {
    id: N(r.id),
    authorId: N(r.user),
    content: r.content ?? "",
    createTime: N(r.createTime),
    author: authors.get(N(r.user)) ?? null,
    authorTitle: p?.m ?? "",
    authorClassic: p?.c ?? null,
    status: r.status,
  };
}

/** 发表评论并递增录像评论计数（2013 版漏了计数递增，新版补齐）
 *  2026-09-24 起事务内同发「评论」动态（仅个人主页可见，不进首页新闻流）
 *  2026-10-17 称号快照制：写入评论时刻的 exp_time/ranked（评论行内嵌快照，渲染不再实时查）
 *  2026-10-22 张老师要求：动态带录像基本信息（「评论了yyy的高级40.44NF录像」）——
 *  lv/tm/nf（级别/成绩/NF）与 vn（楼主名）快照进 details；键序 cid 尾置不动，
 *  AI 复审/删除联动的 detailsData contains "cid":<id>} 精确匹配口径不受影响
 *  2026-10-24 张老师要求：自评自己的录像不发动态（口径同 addReply 自评文章） */
export async function addComment(videoId: number, userId: number, content: string): Promise<number> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return prisma.$transaction(async (tx) => {
    const snap = await userTitleSnapshot(userId, tx);
    const created = await tx.comment.create({
      data: {
        video: BigInt(videoId),
        user: BigInt(userId),
        expTime: BigInt(snap.expTime),
        ranked: snap.ranked ? BigInt(1) : BigInt(0),
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
    // 录像信息快照（video.level + video_info.noflag/real_time + 楼主名）。
    // 注意：交互式事务内不能用 Promise.all 并行发多个 tx 查询（P2028：事务被并发
    // 使用后立即失效，实测 addComment 500）——全部顺序 await
    const video = await tx.video.findUnique({ where: { id: BigInt(videoId) }, select: { level: true, user: true } });
    // 2026-10-24 张老师要求：自评自己的录像（含楼主在自己录像下回复他人）不发动态——
    // 「自己评论自己」对个人主页动态流没有信息量（口径同 bbs.ts addReply 自评守卫）；
    // 评论照常入库并提交，动态不发（info/楼主名只为动态快照服务，一并跳过）
    if (N(video?.user ?? 0) === userId) return N(created.id);
    const info = await tx.videoInfo.findUnique({ where: { id: BigInt(videoId) }, select: { noflag: true, realTime: true } });
    const ownerName =
      (await tx.user.findUnique({ where: { id: video?.user ?? BigInt(0) }, select: { chineseName: true } }))
        ?.chineseName ?? "";
    await publishNews({
      tx,
      type: NEWS_TYPE.COMMENT,
      userId,
      reference: videoId,
      // cid = 本条评论 id：AI 后置复审/删除联动要按它精确定位并撤下这一条动态
      // （同秒多条评论 createTime 相同，只靠时间会把别人的动态一并删掉）——cid 必须尾置
      details: {
        kind: "video",
        lv: video?.level ?? "",
        tm: N(info?.realTime ?? 0),
        nf: info?.noflag ? 1 : 0,
        vn: ownerName.slice(0, 20),
        vid: N(video?.user ?? 0),
        cid: Number(created.id),
      },
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
  // 2026-10-22 张老师要求：「发布评论」更名「论坛评论」并换数据源 bbs_reply（原 comment 表
  // 是录像评论，改挂「录像评论」新行）——两行统计数字各归各位
  bbsReplyTotal: number;
  bbsReplyToday: number;
  // 2026-10-22 张老师要求：新增「在线练习」行——practice_log 累计练习盘数 + 今日增量
  // （口径同「今日练习」板块/后台 KPI：胜负都算、游客局也计）
  practiceTotal: number;
  practiceToday: number;
}

async function getSiteStatsImpl(): Promise<SiteStats> {
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
    bbsReplyTotal, bbsReplyToday,
    practiceTotal, practiceToday,
  ] = await Promise.all([
    // 2026-10-14：注册人数按旧站口径排除封禁账号（旧站 @All_Number = count(...Player_IsLive='1')）
    prisma.user.count({ where: ACTIVE_USER }),
    prisma.user.count({ where: { createTime: { gte: dayStart } } }),
    prisma.userScores.count({ where: { sumTime: { gt: 0 }, ...(await rankedOnly()) } }),
    // 录像增量按 review_time（与总数同口径；2026-10-23 总数随前台放行待审改 status<>0——
    // 待审行无 review_time 不落今日窗口，今日增量口径实际不变）
    prisma.video.count({ where: { status: { not: VIDEO_STATUS.BANNED } } }),
    prisma.video.count({ where: { status: { not: VIDEO_STATUS.BANNED }, reviewTime: { gte: dayStart } } }),
    // 录像评论（comment 表带 video 外键；2026-10-22 起首页行名「录像评论」）
    prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL } }),
    prisma.comment.count({ where: { status: COMMENT_STATUS.NORMAL, createTime: { gte: dayStart } } }),
    prisma.bbsPost.count({ where: { status: 0 } }),
    prisma.bbsPost.count({ where: { status: 0, createTime: { gte: dayStart } } }),
    // 论坛评论（bbs_reply；2026-10-22 起首页行名「论坛评论」，口径同 bbs_post：软删 -1 不计）
    prisma.bbsReply.count({ where: { status: 0 } }),
    prisma.bbsReply.count({ where: { status: 0, createTime: { gte: dayStart } } }),
    // 在线练习（practice_daily 日汇总：SUM 全量；口径同「今日练习」板块：胜负都算、游客局也计。
    // 2026-10-22 张老师定：不逐盘落行改汇总表，原 practice_log 已迁移清理）
    prisma.$queryRaw<Array<{ p: bigint }>>`SELECT COALESCE(SUM(plays),0) AS p FROM practice_daily`,
    prisma.$queryRaw<Array<{ p: bigint }>>`
      SELECT COALESCE(SUM(plays),0) AS p FROM practice_daily
      WHERE day = ${Math.floor((Number(dayStart) + 28800) / 86400)}
    `,
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
    bbsReplyTotal,
    bbsReplyToday,
    // $queryRaw SUM 返回 bigint → number
    practiceTotal: Number(practiceTotal[0]?.p ?? 0),
    practiceToday: Number(practiceToday[0]?.p ?? 0),
  };
}

// 2026-10-15 性能审计：首页右栏「站点统计」9 个 count，其中 video/news/comment 三项
// 在 20 万级表上全表扫描（EXPLAIN 证实 ALL），是全站最重的单点。缓存 60s
const fetchSiteStats = unstable_cache(getSiteStatsImpl, ["site-stats-v1"], { revalidate: 60 });

export async function getSiteStats(): Promise<SiteStats> {
  return fetchSiteStats();
}

// ---------- 军衔页（移植 2008 版 World/World.asp：各军衔人数分布） ----------

/** 各军衔人数（thresholds 与 TITLES[1..] 按下标对应，升序数组：
 *  TITLES[i] 档 = (thresholds[i-2], thresholds[i-1]]（i≥1），列兵 = > 150s 无上界。
 *  总司令不占阈值档位：2026-10-19 张老师改口径=雷界排行第一人（getThunderKingId），
 *  恒 1 人（无人上榜时 0），并从其高级成绩所在档位中摘出。
 *  2026-10-18 张老师定：人神界体系撤销、军衔制回归 19 档（10-16 定稿版），缓存键升 v3；
 *  2026-10-19 总司令改口径，缓存键升 v4 */
async function getTitleCountsImpl(): Promise<{ title: string; count: number }[]> {
  const thresholds = getTitleDistribution().thresholds;
  if (!thresholds.length) return [];
  // 封禁账号不计入军衔人数（旧站数据库口径一律 Player_IsLive=1）
  const ranked = await rankedOnly();
  // 雷界第一人（总司令）：各档区间计数统一排除，恒计 1 人
  const kingId = await getThunderKingId();
  const counts = await Promise.all(
    TITLES.map((_, i) => {
      if (i === 0) return Promise.resolve(0); // 总司令：king 特判（下方置 1），不按区间计数
      const lower = i >= 2 ? thresholds[i - 2] : undefined; // 上一档线（不含）；大元帅无下界
      const upper = i < TITLES.length - 1 ? thresholds[i - 1] : undefined; // 本档线（含）；末档无上界
      // king 摘出为总司令，各档区间计数一律排除（合并封禁黑名单）
      const notIn = [...(ranked.id?.notIn ?? []), ...(kingId > 0 ? [kingId] : [])];
      return prisma.userScores.count({
        where: {
          expTime: {
            gt: 0,
            ...(lower !== undefined ? { gt: lower } : {}),
            ...(upper !== undefined ? { lte: upper } : {}),
          },
          ...(notIn.length ? { id: { notIn } } : {}),
        },
      });
    })
  );
  const result: { title: string; count: number }[] = TITLES.map((t, i) => ({
    title: t,
    count: i === 0 ? (kingId > 0 ? 1 : 0) : (counts[i] ?? 0),
  }));
  // 预备役：注册但没有任何高级成绩的玩家（2026-09-23 新增，2026-10-13 口径改高级）
  const [totalUsers, rankedTotal] = await Promise.all([
    prisma.user.count({ where: ACTIVE_USER }),
    prisma.userScores.count({ where: { expTime: { gt: 0 }, ...ranked } }),
  ]);
  result.push({ title: "预备役", count: Math.max(0, totalUsers - rankedTotal) });
  return result;
}

// 2026-10-15 性能审计：军衔页每次请求 18 次 user_scores count（合计≈全索引扫一遍），
// 军衔人数变化极慢，缓存 60s
// 2026-10-17 人神界改版（阈值全换 24 档）：缓存键升 v2；10-18 回退升 v3；10-19 总司令改口径升 v4
const fetchTitleCounts = unstable_cache(getTitleCountsImpl, ["title-counts-v4"], {
  revalidate: 60,
});

export async function getTitleCounts(): Promise<{ title: string; count: number }[]> {
  return fetchTitleCounts();
}

// （雷神殿 getHeroList 已于 2026-10-13 随每日一星/神界概念一并移除，张老师要求）

// ---------- 军衔玩家列表（2026-09-24 张老师要求：徽章墙可点击查看本军衔所有玩家） ----------

export interface TitleMemberRow extends UserBrief {
  /** 全局总时间名次（1 起；预备役=行序号） */
  rank: number;
  sumTime: number;
  /** Phase 5：旧版称号备选（军衔成员按各自高级成绩；预备役=布衣） */
  classic: { name: string; color: string } | null;
  /** 注册时间（Unix 秒；预备役列表显示用） */
  createTime: number;
  /** 8 列成绩原始存储值（时间=ms，3bvs=×1000），0=无成绩（与 RankingRow 同构） */
  scores: Record<string, number>;
  /** 各级别成绩对应录像 id（sum 无录像=0） */
  videos: Record<string, number>;
}

/** 军衔→user_scores 查询条件（与 getTitleCounts 同口径，升序 thresholds：
 *  TITLES[i] 档 = (thresholds[i-2], thresholds[i-1]]（i≥1））；
 *  总司令=雷界第一人特判（id = king，2026-10-19 改口径），不按区间；
 *  其余档位一律排除 king（已摘出为总司令，不重复占档）；
 *  预备役返回 null（查 user 表） */
async function titleScoresWhere(t: string): Promise<Record<string, unknown> | null> {
  const idx = TITLES.indexOf(t as (typeof TITLES)[number]);
  if (idx < 0) return null;
  const ranked = await rankedOnly();
  if (idx === 0) {
    // 总司令：雷界排行第一人（fetchThunderKingId 已保证 status=0，直接按 id 取；
    // 注意不能展开 ranked——其 id.notIn 会覆盖掉这里的 id 精确条件）
    const kingId = await getThunderKingId();
    return kingId > 0 ? { id: BigInt(kingId) } : { id: BigInt(-1) };
  }
  const dist = getTitleDistribution();
  if (!dist.thresholds.length) return null;
  const lower = idx >= 2 ? dist.thresholds[idx - 2] : undefined;
  const upper = idx < TITLES.length - 1 ? dist.thresholds[idx - 1] : undefined;
  const kingId = await getThunderKingId();
  // 合并封禁黑名单与 king 摘出（rankedOnly 只可能带 id.notIn）
  const notIn = [...(ranked.id?.notIn ?? []), ...(kingId > 0 ? [kingId] : [])];
  return {
    expTime: {
      gt: lower !== undefined ? lower : 0,
      ...(upper !== undefined ? { lte: upper } : {}),
    },
    ...(notIn.length ? { id: { notIn } } : {}),
  };
}

/** 预备役→user 查询条件（正常账号 + id 不在有高级成绩集合内；2026-10-13 口径改高级） */
async function reserveWhere(): Promise<Record<string, unknown>> {
  const ranked = await prisma.userScores.findMany({
    where: { expTime: { gt: 0 } },
    select: { id: true },
  });
  return { ...ACTIVE_USER, id: { notIn: ranked.map((r) => r.id) } };
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
      select: { id: true, chineseName: true, englishName: true, sex: true, avatar: true, createTime: true },
    });
    const hasMore = rows.length > take;
    return {
      rows: rows.slice(0, take).map((u) => ({
        id: N(u.id),
        chineseName: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        avatar: u.avatar,
        createTime: N(u.createTime),
        rank: cursor + 1, // 预备役序号=行号（1 起）
        sumTime: 0,
        scores: {},
        videos: {},
        // Phase 5：未加入排行 → 旧体系「布衣」
        classic: classicTitle(0, false, u.sex),
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
  // Phase 5：批量补旧版称号备选（成员各按高级成绩；本列表恒在榜）
  // dualTitles 行序数组（2026-10-27）：与 page 下标一一对应
  const memberPairs = await dualTitles(
    page.map((r) => ({ userId: N(r.id), expTime: N(r.expTime), ranked: true, sex: authors.get(N(r.id))?.sex ?? 1 }))
  );
  return {
    rows: page.map((r, i) => {
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
        classic: memberPairs[i]?.c ?? null,
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
  if (!(await isRankedUser(uid))) return -1; // 封禁用户不在任何军衔列表
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
  // 总司令：仅雷界第一人本人（2026-10-19 改口径）
  const idx = TITLES.indexOf(t as (typeof TITLES)[number]);
  if (idx === 0) {
    return (await getThunderKingId()) === uid ? 0 : -1;
  }
  // 检验是否真在此军衔区间（同 titleScoresWhere 口径，升序 thresholds；
  // king 虽在区间内但已摘出为总司令，titleScoresWhere 的 id.notIn 已排除）
  const dist = getTitleDistribution();
  if (!dist.thresholds.length) return -1;
  const upper = idx < TITLES.length - 1 ? dist.thresholds[idx - 1] : Infinity;
  const lower = idx >= 2 ? dist.thresholds[idx - 2] : 0;
  if (row.expTime > upper || row.expTime <= lower) return -1;
  if ((await getThunderKingId()) === uid) return -1; // king 已摘出为总司令
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
  // 名次口径与排行榜一致：封禁用户不参与（旧站 `Player_IsLive=1 and Player_Rank<>0`）
  const rows = await prisma.$queryRaw<
    { id: bigint; rank: bigint }[]
  >`SELECT id, \`rank\` FROM (
      SELECT s.id, ROW_NUMBER() OVER (ORDER BY s.exp_time ASC) AS \`rank\`
      FROM user_scores s JOIN \`user\` u ON u.id = s.id AND u.status = 0
      WHERE s.exp_time > 0
    ) r WHERE id IN (${Prisma.join(ids)})`;
  return new Map(rows.map((r) => [N(r.id), N(r.rank)]));
}

// ---------- 管理团队（移植 2008 版 Team/Index.asp：管理员 + 各自审核工作量） ----------

export interface TeamMember extends UserBrief {
  role: number;
  reviewCount: number;
}

async function getTeamImpl(): Promise<TeamMember[]> {
  const auths = await prisma.userAuth.findMany({
    where: { role: { in: [USER_ROLE.MANAGER, USER_ROLE.ADMINISTRATOR] } },
  });
  const authors = await usersByIds(auths.map((a) => N(a.id)));
  // 2026-10-22 迁移收尾索引排查：审核量 count 改单条 GROUP BY；此前逐人 count，
  // 最大审核员 12.6 万条目扫 1.4s/人。
  // 2026-10-23 慢 SQL 巡检修正：Prisma groupBy 的 IN 列表让优化器弃用 (review_user,status)
  // 索引、改走 (status,…) 索引扫 30.8 万行且不覆盖 review_user（生产 1~3.5s/次）——
  // 改手写 SQL + FORCE INDEX 钉死覆盖索引（9 个区间 range 扫，毫秒级）
  const counts = await prisma.$queryRawUnsafe<{ review_user: bigint; c: bigint }[]>(
    `SELECT review_user, COUNT(*) c FROM video
     WHERE review_user IN (${auths.map((a) => a.id).join(",")}) AND status = ${VIDEO_STATUS.REVIEWED}
     GROUP BY review_user`,
  );
  const cntMap = new Map(counts.map((c) => [N(c.review_user), N(c.c)]));
  const members: TeamMember[] = auths.map((a) => ({
    ...(authors.get(N(a.id)) ?? { id: N(a.id), chineseName: "?", englishName: "", sex: 1 }),
    role: a.role,
    reviewCount: cntMap.get(N(a.id)) ?? 0,
  }));
  return members.sort((x, y) => y.role - x.role || y.reviewCount - x.reviewCount);
}

// 2026-10-22：团队页低频变化，缓存 300s（大审核员 12.6 万条目覆盖扫描 ~1s，
// 没必要每次访问都跑）；缓存键 v2 起版（查询形态已变）
const fetchTeam = unstable_cache(getTeamImpl, ["team-v2"], { revalidate: 300 });

export async function getTeam(): Promise<TeamMember[]> {
  return fetchTeam();
}

/** 随机串门（移植 2008 版 Player/Random.asp：随机访问一个有成绩用户的地盘） */
export async function getRandomUserId(): Promise<number | null> {
  const where = { sumTime: { gt: 0 }, ...(await rankedOnly()) }; // 不串到封禁账号的地盘
  const total = await prisma.userScores.count({ where });
  if (!total) return null;
  const skip = Math.floor(Math.random() * total);
  const rows = await prisma.userScores.findMany({
    where,
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
  /** 8 列成绩原始存储值（时间=ms，3bvs=×1000）；0 通常为无成绩，初级 3BV/s 有初级时间时为例外零纪录 */
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
  area?: string,
  /** 本批行数（2026-10-14「加载更多」递增批量）：skip 恒按 RANKING_PAGESIZE 页锚点，take 才是行数 */
  take?: number
): Promise<{ rows: RankingRow[]; total: number; pageSize: number }> {
  const { level, order } = byLevelOrder(by);
  const size = take ?? RANKING_PAGESIZE;
  const field = SCORE_FIELD(level, order);
  const table = userScoresTable(nf);
  let idsWhere: Record<string, unknown> = { [field]: { gt: 0 }, ...(await rankedOnly()) };
  if (area) {
    const areaUsers = await prisma.user.findMany({ where: { area, ...ACTIVE_USER }, select: { id: true } });
    idsWhere = { ...idsWhere, id: { in: areaUsers.map((u) => u.id) } };
  }
  const total = await table.count({ where: idsWhere });
  const rows = await table.findMany({
    where: idsWhere,
    orderBy: { [field]: ORDER_DIRECTION[order] },
    skip: (page - 1) * RANKING_PAGESIZE, // 页锚点恒按 base 20（页码语义不变）
    take: size, // 本批行数（「加载更多」递增批量可 > 20）
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
    where: { sumTime: { gt: 0 }, ...(await rankedOnly()) },
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
    where: { ...where, ...ACTIVE_USER }, // 榜单搜索：封禁账号不在榜，不出现在推荐里
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

async function getAreaRankingImpl(order: AreaOrder = "power"): Promise<AreaRow[]> {
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
       WHERE s.sum_time > 0 AND u.status = 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
     ),
     agg AS (
       SELECT area, COUNT(*) players, ROUND(AVG(rk)) avg_rank, MIN(rk) best_rank,
              SUM(total - rk) power
       FROM ranked GROUP BY area
     ),
     act AS (
       SELECT u.area, COUNT(*) active
       FROM user u
       WHERE u.status = 0
         AND u.last_login_time > UNIX_TIMESTAMP() - 30 * 86400
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

// 2026-10-15 性能审计：/area 每次请求跑全量窗口聚合（user_scores 3.5 万行 × JOIN user
// × 30 天活跃子查询），地区榜一天变不了几次，缓存 5 分钟（按 order 参数分键）
// 2026-10-15 海外条目：地区榜含「海外」（张老师同日改主意——海外也进地区榜表），
// 查询恢复不含排除；缓存键升 v3
const fetchAreaRanking = unstable_cache(getAreaRankingImpl, ["area-ranking-v3"], {
  revalidate: 300,
});

export async function getAreaRanking(order: AreaOrder = "power"): Promise<AreaRow[]> {
  return fetchAreaRanking(order);
}

/** 用户全国排名 + 省份排名（用户主页军衔徽章上方展示，09-23 晚张老师要求） */
export interface UserRanks {
  national: number; // 全国名次（主榜口径：总时间升序）
  area: string; // 军区名（用于文案）
  areaPos: number | null; // 省份名次（无军区/多地区为 null）
}

async function getUserRanksImpl(userId: number): Promise<UserRanks | null> {
  // 2026-10-22 名次落盘：读 user_rank 表（触发点增量维护 + 每日 00:05 重建兜底，见 lib/userrank.ts），
  // 不再全表 ROW_NUMBER 窗口扫（慢日志实证 1.1s/次、20 分钟 12 次，站点常态 CPU 税大头）。
  // 海外名次口径不变：地区名次含「海外」，多地区/空地区 area_pos 为 null。
  let rows = await prisma.$queryRaw<{ national: number; area: string; area_pos: number | null }[]>`
    SELECT national, area, area_pos FROM user_rank WHERE id = ${userId}`;
  if (!rows.length) {
    // 自愈兜底：该用户确实在榜却无落盘行（同步管线整表重写 user_scores 后漂移/表刚上线）→ 全量重建一次
    const ranked = await prisma.$queryRaw<unknown[]>`
      SELECT 1 x FROM user_scores s JOIN user u ON u.id = s.id
      WHERE s.id = ${userId} AND s.sum_time > 0 AND u.status = 0`;
    if (ranked.length) {
      await rebuildUserRanksOnce();
      rows = await prisma.$queryRaw<{ national: number; area: string; area_pos: number | null }[]>`
        SELECT national, area, area_pos FROM user_rank WHERE id = ${userId}`;
    }
  }
  if (!rows.length) return null;
  return {
    national: Number(rows[0].national),
    area: rows[0].area,
    areaPos: rows[0].area_pos === null ? null : Number(rows[0].area_pos),
  };
}

// 2026-10-15 性能审计：用户主页每次浏览都跑一次全量 ROW_NUMBER 窗口（3.5 万行 ×2 CTE），
// 而名次只在有人出成绩时变化——按用户 id 分键缓存 10 分钟（userId 自动并入缓存键）
// 2026-10-15 海外名次：arear 恢复含「海外」，缓存键升 v3
const fetchUserRanks = unstable_cache(getUserRanksImpl, ["user-ranks-v3"], { revalidate: 600 });

export async function getUserRanks(userId: number): Promise<UserRanks | null> {
  return fetchUserRanks(userId);
}

// ---------- 3BV 收集（2026-10-13 张老师方案：个人主页侧栏「3BV 收集」版块） ----------

/**
 * 各级别 3BV 收集区间（level_3bv_range 表，3 行小表，读取亚毫秒）。
 * 区间 = 站内已通过（status=REVIEWED）录像的 board_3bv 实际上下限，只扩不缩
 * （审核通过时在 lib/review.ts 同事务扩边）。
 * 2026-10-14 张老师：按现行排行规则收敛统计区间——下限钳到 LEVEL_MIN_3BV
 * （初 2 / 中 30 / 高 100），中级 <30、高级 <100 不再统计完成度；
 * 库里的行「只扩不缩」可能留着更低的下限，读取时钳（self-heal 补种同样钳）。
 * 2026-10-22 张老师：初级上限抬到理论最大值 54（8×8 非雷格全为孤立数字格），
 * 50/52/53 数学不可达（推导见 config.LEVEL_MAX_3BV），站内实际数据顶格 51 属
 * 「角上单 0」极限盘；库里的 max_3bv 只跟实际录像走（当前 51），读取时抬到理论值，
 * 54 被收集时 review.ts 扩边自然接上。50/52/53 三个不可达值在 BbvCollection
 * 格子墙单独渲染死格（不做收集目标），BV 榜分母按可达值个数计（见 bvDenoms）。
 * 仅初级——中/高级不做理论抬升（实际顶格 133/271 远低于理论值，抬了分母虚高）。
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
    // 上限按级别定义抬到理论最大（2026-10-22，仅初级 54）：初级实际顶格 51，
    // 理论最大 54 留出收集目标位，54 被收集时 review.ts 扩边自然接上；
    // 中/高级无 LEVEL_MAX_3BV 定义，上限仍随实际数据走
    const theoryMax = LEVEL_MAX_3BV[level];
    const max = theoryMax ? Math.max(r.max3bv, theoryMax) : r.max3bv;
    if (min <= max) out[level] = { min, max };
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
      const theoryMax = LEVEL_MAX_3BV[level];
      const max = theoryMax ? Math.max(N(a.mx), theoryMax) : N(a.mx);
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
 * 值 = 该 3BV 的录像数（≥1），供侧栏方格气泡「共X个录像，点击查看」
 * （2026-10-20 张老师要求；原「首个录像 id+时间」已随格子直开首盘入口下线，
 * 点击入口改为定向列表 /video?author=..&level=..&3bv=..&order=time）。
 * 2026-10-14 张老师：按现行排行规则收敛——低于 LEVEL_MIN_3BV（初 2 / 中 30 / 高 100）
 * 的 3BV 不计入收集（CASE 按级别取下限，与 BV 榜 fetchBvCollection 同口径）。
 * 2026-10-16 张老师：封禁用户的录像计入本人收集——旧站封禁会把账号全部录像连坐
 * IsLive=0（实证：正常用户 0 部 status=0，3038 部 status=0 全属封禁账号），
 * 这些是审核通过的合法成绩，封禁只剥夺上榜资格、不抹除历史数据；
 * 正常用户被管理员单独屏蔽的录像（owner 未封禁）仍不计入。
 * 走 video 表 (user, level) 索引 + video_info/user 主键 join，全站最重用户（5k+ 盘）毫秒级。
 */
export async function getUser3bvCollection(
  userId: number
): Promise<Record<VideoLevel, Map<number, number>>> {
  const rows = await prisma.$queryRaw<{ level: string; b3bv: number; n: bigint }[]>`
    SELECT v.level, vi.board_3bv AS b3bv, COUNT(*) AS n
    FROM video v JOIN video_info vi ON vi.id = v.id
      JOIN \`user\` u ON u.id = v.user
    WHERE v.user = ${BigInt(userId)}
      AND (v.status = ${VIDEO_STATUS.REVIEWED} OR (v.status = ${VIDEO_STATUS.BANNED} AND u.status <> 0))
      AND vi.board_3bv >= CASE v.level
        WHEN 'beg' THEN ${LEVEL_MIN_3BV.beg}
        WHEN 'int' THEN ${LEVEL_MIN_3BV.int}
        ELSE ${LEVEL_MIN_3BV.exp} END
    GROUP BY v.level, vi.board_3bv`;
  const out: Record<VideoLevel, Map<number, number>> = {
    beg: new Map(),
    int: new Map(),
    exp: new Map(),
  };
  for (const r of rows) out[r.level as VideoLevel]?.set(r.b3bv, N(r.n));
  return out;
}

// ---------- BV 收集榜（2026-10-13 张老师需求：排行榜 NF 后新增 BV 榜，设计稿 design/ranking-bv.html v3） ----------

/** BV 榜条目：一名玩家的三级收集数 + 高级时间（军衔评定用） */
export interface BvRankingEntry {
  id: number;
  chineseName: string;
  sex: number;
  /** 当前页渲染时补入；全量收集缓存不携带 */
  avatar?: string;
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
  async (nf: boolean = false): Promise<BvRankingEntry[]> => {
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
        -- 2026-10-23 慢 SQL 巡检：驱动侧 FORCE INDEX (user, level) 让 GROUP BY 顺序
        -- 即索引顺序，消除 15 万行 Sort（生产 avg 2.35s/次 × 50 次/日）
        SELECT v.user, v.level, COUNT(DISTINCT vi.board_3bv) AS n
        FROM video v FORCE INDEX (video_user_level_idx) JOIN video_info vi ON vi.id = v.id
        WHERE v.status = ${VIDEO_STATUS.REVIEWED}
          ${nf ? Prisma.sql`AND vi.noflag = 1` : Prisma.empty}
          AND vi.board_3bv >= CASE v.level
            WHEN 'beg' THEN ${LEVEL_MIN_3BV.beg}
            WHEN 'int' THEN ${LEVEL_MIN_3BV.int}
            ELSE ${LEVEL_MIN_3BV.exp} END
        GROUP BY v.user, v.level
      ) t
      JOIN user u ON u.id = t.user AND u.status = 0
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
  ["bv-collection-v6"], // v6（2026-10-26）：nf 参数进入缓存键，支持混合/NF 两套收集聚合
  { revalidate: 3600, tags: ["bv-collection"] }
);

/** 排序口径（页面 / 名次查询 / 下拉增强三处共用）：所选列降序，同数用户 ID 小在前（2026-10-13 张老师定） */
function sortBv(all: BvRankingEntry[], by: BvRankingBy): BvRankingEntry[] {
  return [...all].sort((a, b) => b[by] - a[by] || a.id - b.id);
}

/** 分母 = 区间内**可达** 3BV 值个数（2026-10-22 张老师：初级 50/52/53 数学不可达，
 *  不做收集目标——跨度 53 扣 3 个 = 50）。分子（fetchBvCollection 的 COUNT DISTINCT）
 *  天然只数真实存在的值，分子分母口径自洽。 */
function bvDenoms(ranges: Partial<Record<VideoLevel, { min: number; max: number }>>): {
  den: Record<VideoLevel, number>;
  totalDen: number;
} {
  const den: Record<VideoLevel, number> = { beg: 0, int: 0, exp: 0 };
  for (const l of VIDEO_LEVELS) {
    const r = ranges[l];
    if (!r) continue;
    const span = r.max - r.min + 1;
    const miss = (UNREACHABLE_3BV[l] ?? []).filter((v) => v >= r.min && v <= r.max).length;
    den[l] = span - miss;
  }
  return { den, totalDen: den.beg + den.int + den.exp };
}

/** BV 收集榜一页。 */
export async function getBvRanking(by: BvRankingBy, page: number, take?: number, nf = false): Promise<BvRankingResult> {
  const [all, ranges] = await Promise.all([fetchBvCollection(nf), getLevel3bvRanges()]);
  const { den, totalDen } = bvDenoms(ranges);
  const sorted = sortBv(all, by);
  const size = take ?? RANKING_PAGESIZE;
  const pageRows = sorted.slice((page - 1) * RANKING_PAGESIZE, (page - 1) * RANKING_PAGESIZE + size);
  const avatars = await rankingAvatarsByIds(pageRows.map((e) => e.id));
  const rows = pageRows.map((e, i) => ({
    ...e,
    avatar: avatars.get(e.id) ?? "",
    rank: (page - 1) * RANKING_PAGESIZE + i + 1,
  }));
  return { rows, total: sorted.length, pageSize: RANKING_PAGESIZE, den, totalDen, ranges };
}

/** BV 榜「用户 → 名次 + 总计收集数」索引（2026-10-14 搜索定位/下拉增强）：
 *  一次内存排序构建 Map，不在 Map 里即「未加入 BV 排行」。零 DB 重活（只有 3 行的 ranges 小表）。 */
export async function getBvBoardIndex(by: BvRankingBy, nf = false): Promise<{
  index: Map<number, { rank: number; collected: number }>;
  total: number;
  totalDen: number;
}> {
  const [all, ranges] = await Promise.all([fetchBvCollection(nf), getLevel3bvRanges()]);
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
  by: BvRankingBy,
  nf = false
): Promise<{ rank: number; page: number; collected: number; total: number; totalDen: number } | null> {
  const { index, total, totalDen } = await getBvBoardIndex(by, nf);
  const hit = index.get(id);
  if (!hit) return null;
  return { rank: hit.rank, page: Math.floor((hit.rank - 1) / RANKING_PAGESIZE) + 1, collected: hit.collected, total, totalDen };
}

// ---------- STNB 榜（2026-10-20 张老师需求：筛选器 BV 右侧新增 STNB 榜，展示类似 BV 榜） ----------

/** STNB 榜条目：一名玩家的三级历史最高 STNB + 高级时间（军衔评定用）。
 *  列值 0 = 该级无有效成绩；total 仅在三级齐全时为三者之和，否则 0（按总计排序时不上榜）。
 *  best.<level> = 该级最优盘（成绩点击跳转 + hover 气泡「高级 xx.xx 秒 NF 3月前」用）。 */
export interface StnbBestVideo {
  /** 录像 id（点击跳转 /video/<id>） */
  vid: number;
  /** 用时 Unix 毫秒（气泡显示 xx.xx 秒） */
  timeMs: number;
  /** NF 标记（气泡显示 NF） */
  nf: boolean;
  /** 上传时间 Unix 秒（气泡显示相对时间） */
  ct: number;
}

export interface StnbRankingEntry {
  id: number;
  chineseName: string;
  sex: number;
  /** 当前页渲染时补入；紧凑全量缓存不携带，守住 2MB 载荷上限 */
  avatar?: string;
  beg: number;
  int: number;
  exp: number;
  total: number;
  expTime: number;
  best: Record<VideoLevel, StnbBestVideo | null>;
}

export interface StnbRankingRow extends StnbRankingEntry {
  rank: number;
}

export interface StnbRankingResult {
  rows: StnbRankingRow[];
  total: number;
  pageSize: number;
  /** 各级别全站最高 STNB（进度条分母，2026-10-20 张老师定：渲染方式与 BV 榜一致，
   *  分母=该级别全站最高记录）与总计分母（三级最高之和） */
  den: Record<VideoLevel, number>;
  totalDen: number;
}

// STNB 榜全量聚合：口径 + 缓存形态说明。
// 口径（2026-10-20）：
//   · 录像须已通过审核（v.status=20 胜局）+ 用户正常（u.status=0），与 BV 榜同口径
//   · 每级取历史最高 STNB（video_metrics.stnb，与录像评级「判雷」轴同源）
//   · 运气盘限界与 3BV/s 成绩同款（MIN_3BV_FOR_3BVS：初 10 / 中 4 / 高 4；
//     中高级上传下限 30/100 本就高于 4，实际只约束初级——不限则 3BV=2 的 0.09s
//     秒开盘 STNB 4316 会霸榜，实测限界内 top 为 473.7）
//   · 默认混合统计；nf=true 时仅取 noflag=1，并使用独立缓存/落盘表
//   · 每级最优盘（成绩点击跳对应录像 + hover 气泡）：GROUP_CONCAT 组内按
//     stnb DESC, id ASC 排序取第一个（同分取注册序影像 id 较小者，与排序口径一致）。
//     注：窗口函数版实测 55s（全表 filesort），GROUP_CONCAT 组内排序 4.2s（本地）/
//     6.2s（生产，buffer pool 128M）——缓存必须命中，否则页面恒慢。
// ⚠️ 缓存载荷必须走紧凑元组形态（2026-10-20 线上 STNB 榜 7~12s 根因修复）：
// unstable_cache 落盘走 fetch-cache，**单条上限 2MB**（next 源码 incremental-cache：
// 超限 production 只 console.warn 后静默丢弃，不落盘）。对象形态 9851 用户序列化
// 3.05MB 恒超限（pm2 日志 "items over 2MB can not be cached (3048519 bytes)"），
// 缓存永远写不进 → 每个请求都现场重跑 6s 聚合 SQL。紧凑元组 + best 存原串后
// 1.14MB（Next 包装系数实测 ~1.14，落盘 ~1.3MB），余量 38%。
// 注意：①改查询逻辑必须升缓存键版本号（unstable_cache 文件持久化）；
// ②用户数涨到 ~1.6 万时将再触线，届时可退化为 TSV 整串（0.93MB，实测）。
type StnbCompactRow = [
  number, // id
  string, // chineseName
  number, // sex
  number, // beg
  number, // int
  number, // exp
  number, // total
  number, // expTime
  [string | null, string | null, string | null] // best 三级原串 "vid:realTime:noflag:createTime"
];

/** best 串 "vid:real_time(ms):noflag:create_time"——noflag 在 video_info 是 tinyint，
 *  CONCAT 时 0/1 仍按数值拼（MySQL 隐式转换），安全解析。 */
function parseStnbBest(raw: string | null): StnbBestVideo | null {
  if (!raw) return null;
  const [vid, rt, nf, ct] = raw.split(":");
  const v = parseInt(vid, 10);
  const timeMs = parseInt(rt, 10);
  const ctv = parseInt(ct, 10);
  if (!Number.isFinite(v) || !Number.isFinite(timeMs)) return null;
  return { vid: v, timeMs, nf: nf === "1", ct: Number.isFinite(ctv) ? ctv : 0 };
}

/** 紧凑元组 → StnbRankingEntry（出缓存后 inflate，9851 条 map 微秒级） */
function inflateStnbRow(c: StnbCompactRow): StnbRankingEntry {
  return {
    id: c[0],
    chineseName: c[1],
    sex: c[2],
    beg: c[3],
    int: c[4],
    exp: c[5],
    total: c[6],
    expTime: c[7],
    best: { beg: parseStnbBest(c[8][0]), int: parseStnbBest(c[8][1]), exp: parseStnbBest(c[8][2]) },
  };
}

// STNB 榜数据源（2026-10-20 落盘改版，张老师拍板）：
//   主源 = user_stnb_best 落盘表（~2.4 万行，全表读 ~0.1s；写入点见 lib/userstnb.ts）
//   回退 = 原实时聚合（表空时自愈窗口：首次部署回填前页面不空）
// 口径不变（与落盘表写入完全同源）：
//   · 录像须已通过审核（v.status=20 胜局）+ 用户正常（u.status=0），与 BV 榜同口径
//   · 每级取历史最高 STNB（video_metrics.stnb，与录像评级「判雷」轴同源）
//   · 运气盘限界与 3BV/s 成绩同款（MIN_3BV_FOR_3BVS：初 10 / 中 4 / 高 4；
//     中高级上传下限 30/100 本就高于 4，实际只约束初级——不限则 3BV=2 的 0.09s
//     秒开盘 STNB 4316 会霸榜，实测限界内 top 为 473.7）
//   · 默认混合统计；nf=true 时仅取 noflag=1，并使用独立缓存/落盘表
//   · 每级最优盘（成绩点击跳对应录像 + hover 气泡）：组内 stnb DESC, id ASC
//     排序取第一个（同分取注册序影像 id 较小者，与排序口径一致）。
// ⚠️ 缓存载荷仍走紧凑元组形态（2026-10-20 线上 STNB 榜 7~12s 根因教训）：
// unstable_cache 落盘走 fetch-cache，**单条上限 2MB**（next 源码 incremental-cache：
// 超限 production 只 console.warn 后静默丢弃，不落盘）。落盘表读回后组装的元组
// 形态实测 1.14MB 安全；保持紧凑形态是防未来膨胀的保险（2.4 万行全对象形态会到 ~3MB）。
// 缓存 60s（原 1h）：读表很快，重建成本低，破纪录上榜时效从最迟 1h 收敛到 1min 内。
// 注意：①改查询逻辑必须升缓存键版本号（unstable_cache 文件持久化）。

const fetchStnbFromTable = unstable_cache(
  async (nf: boolean = false): Promise<StnbCompactRow[] | null> => {
    // 落盘表 join user/user_scores 组装（榜行需要姓名/性别/军衔时间）。
    // 行数 ~2.4 万，全部走索引，实测亚秒级。
    const rows = await prisma.$queryRaw<
      {
        id: bigint;
        chinese_name: string;
        sex: number;
        exp_time: number | null;
        beg: number | null;
        inter: number | null;
        exp: number | null;
        best_beg: string | null;
        best_int: string | null;
        best_exp: string | null;
      }[]
    >`
      SELECT u.id, u.chinese_name, u.sex, us.exp_time,
        MAX(CASE WHEN b.level = 'beg' THEN b.stnb END) AS beg,
        MAX(CASE WHEN b.level = 'int' THEN b.stnb END) AS inter,
        MAX(CASE WHEN b.level = 'exp' THEN b.stnb END) AS exp,
        MAX(CASE WHEN b.level = 'beg' THEN CONCAT_WS(':', b.best_video, b.best_time, b.best_nf, b.best_ct) END) AS best_beg,
        MAX(CASE WHEN b.level = 'int' THEN CONCAT_WS(':', b.best_video, b.best_time, b.best_nf, b.best_ct) END) AS best_int,
        MAX(CASE WHEN b.level = 'exp' THEN CONCAT_WS(':', b.best_video, b.best_time, b.best_nf, b.best_ct) END) AS best_exp
      FROM ${Prisma.raw(nf ? "user_stnb_best_nf" : "user_stnb_best")} b
        JOIN user u ON u.id = b.user AND u.status = 0
        LEFT JOIN user_scores us ON us.id = b.user
      GROUP BY u.id, u.chinese_name, u.sex, us.exp_time`;
    if (!rows.length) return null; // 空表 → 回退实时聚合（首次部署自愈窗口）
    return rows.map((r) => {
      const beg = r.beg == null ? 0 : Math.round(N(r.beg) * 10) / 10;
      const inter = r.inter == null ? 0 : Math.round(N(r.inter) * 10) / 10;
      const exp = r.exp == null ? 0 : Math.round(N(r.exp) * 10) / 10;
      return [
        N(r.id),
        r.chinese_name,
        r.sex,
        beg,
        inter,
        exp,
        beg > 0 && inter > 0 && exp > 0 ? Math.round((beg + inter + exp) * 10) / 10 : 0,
        N(r.exp_time),
        [r.best_beg, r.best_int, r.best_exp],
      ] satisfies StnbCompactRow;
    });
  },
  ["stnb-table-v2"],
  { revalidate: 60, tags: ["stnb-collection"] }
);

// 原实时聚合（回退源，逻辑保持 v3 形态不动；表回填后此路径仅首次部署窗口/对账时走）
const fetchStnbCompact = unstable_cache(
  async (nf: boolean = false): Promise<StnbCompactRow[]> => {
    const rows = await prisma.$queryRaw<
      {
        id: bigint;
        chinese_name: string;
        sex: number;
        exp_time: number | null;
        beg: number;
        inter: number;
        exp: number;
        best_beg: string;
        best_int: string;
        best_exp: string;
      }[]
    >`
      SELECT u.id, u.chinese_name, u.sex, us.exp_time,
        SUM(CASE WHEN t.level = 'beg' THEN t.n ELSE 0 END) AS beg,
        SUM(CASE WHEN t.level = 'int' THEN t.n ELSE 0 END) AS inter,
        SUM(CASE WHEN t.level = 'exp' THEN t.n ELSE 0 END) AS exp,
        MAX(CASE WHEN t.level = 'beg' THEN t.best END) AS best_beg,
        MAX(CASE WHEN t.level = 'int' THEN t.best END) AS best_int,
        MAX(CASE WHEN t.level = 'exp' THEN t.best END) AS best_exp
      FROM (
        SELECT v.user, v.level, MAX(m.stnb) AS n,
          SUBSTRING_INDEX(GROUP_CONCAT(
            CONCAT_WS(':', m.id, vi.real_time, vi.noflag, v.create_time)
            ORDER BY m.stnb DESC, m.id ASC SEPARATOR ','), ',', 1) AS best
        FROM video_metrics m
          JOIN video v ON v.id = m.id
          JOIN video_info vi ON vi.id = m.id
        WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0
          ${nf ? Prisma.sql`AND vi.noflag = 1` : Prisma.empty}
          AND vi.board_3bv >= CASE v.level
            WHEN 'beg' THEN ${MIN_3BV_FOR_3BVS.beg}
            WHEN 'int' THEN ${MIN_3BV_FOR_3BVS.int}
            ELSE ${MIN_3BV_FOR_3BVS.exp} END
        GROUP BY v.user, v.level
      ) t
      JOIN user u ON u.id = t.user AND u.status = 0
      LEFT JOIN user_scores us ON us.id = t.user
      GROUP BY u.id, u.chinese_name, u.sex, us.exp_time`;
    return rows.map((r) => {
      // MAX/SUM 走 float 会带精度尾差（4316.399902…），统一回 1 位小数（stnb 落库即 1 位）
      const beg = Math.round(N(r.beg) * 10) / 10;
      const inter = Math.round(N(r.inter) * 10) / 10;
      const exp = Math.round(N(r.exp) * 10) / 10;
      return [
        N(r.id),
        r.chinese_name,
        r.sex,
        beg,
        inter,
        exp,
        // 总计与成绩榜同语义：三级都有有效成绩才算（缺级不上总计榜）
        beg > 0 && inter > 0 && exp > 0 ? Math.round((beg + inter + exp) * 10) / 10 : 0,
        N(r.exp_time),
        [r.best_beg, r.best_int, r.best_exp],
      ] satisfies StnbCompactRow;
    });
  },
  ["stnb-collection-v4"],
  { revalidate: 3600, tags: ["stnb-collection"] }
);

/** STNB 榜全量数据入口：落盘表（60s 缓存）优先，空表回退实时聚合（1h 缓存）。
 *  出缓存后 inflate 成对象形态；调用方（getStnbRanking / getStnbBoardIndex /
 *  getStnbRankOfUser）零改动。 */
async function fetchStnbCollection(nf = false): Promise<StnbRankingEntry[]> {
  const fromTable = await fetchStnbFromTable(nf).catch(() => null);
  const compact = fromTable ?? (await fetchStnbCompact(nf));
  return compact.map(inflateStnbRow);
}

/** 榜人口随排序列变化（与成绩榜同语义，异于 BV 榜恒定人口）：
 *  按总计 = 三级齐全；按级别 = 该级有有效成绩。 */
function stnbPopulation(all: StnbRankingEntry[], by: BvRankingBy): StnbRankingEntry[] {
  return all.filter((e) => e[by] > 0);
}

/** 排序口径（与 BV 榜一致）：所选列降序，同分用户 ID 小在前 */
function sortStnb(list: StnbRankingEntry[], by: BvRankingBy): StnbRankingEntry[] {
  return [...list].sort((a, b) => b[by] - a[by] || a.id - b.id);
}

/** 各级别全站最高 STNB（进度条分母）：从全量数组内存取 max，零额外查询。
 *  与 BV 榜 den（3BV 区间跨度）不同——STNB 榜分母=该级别全站最高记录（张老师 2026-10-20 定）。 */
function stnbDenoms(all: StnbRankingEntry[]): { den: Record<VideoLevel, number>; totalDen: number } {
  const den: Record<VideoLevel, number> = { beg: 0, int: 0, exp: 0 };
  for (const e of all) {
    if (e.beg > den.beg) den.beg = e.beg;
    if (e.int > den.int) den.int = e.int;
    if (e.exp > den.exp) den.exp = e.exp;
  }
  return { den, totalDen: Math.round((den.beg + den.int + den.exp) * 10) / 10 };
}

/** STNB 榜一页（by 复用 BvRankingBy：total/beg/int/exp 同构）。 */
export async function getStnbRanking(by: BvRankingBy, page: number, take?: number, nf = false): Promise<StnbRankingResult> {
  const all = await fetchStnbCollection(nf);
  const sorted = sortStnb(stnbPopulation(all, by), by);
  const { den, totalDen } = stnbDenoms(all);
  const size = take ?? RANKING_PAGESIZE;
  const pageRows = sorted.slice((page - 1) * RANKING_PAGESIZE, (page - 1) * RANKING_PAGESIZE + size);
  const avatars = await rankingAvatarsByIds(pageRows.map((e) => e.id));
  const rows = pageRows.map((e, i) => ({
    ...e,
    avatar: avatars.get(e.id) ?? "",
    rank: (page - 1) * RANKING_PAGESIZE + i + 1,
  }));
  return { rows, total: sorted.length, pageSize: RANKING_PAGESIZE, den, totalDen };
}

/** STNB 榜「用户 → 名次」索引（搜索下拉增强用）：一次内存排序构建 Map，零 DB 重活。 */
export async function getStnbBoardIndex(by: BvRankingBy, nf = false): Promise<{
  index: Map<number, number>;
  total: number;
}> {
  const all = await fetchStnbCollection(nf);
  const sorted = sortStnb(stnbPopulation(all, by), by);
  const index = new Map<number, number>();
  sorted.forEach((e, i) => index.set(e.id, i + 1));
  return { index, total: sorted.length };
}

/**
 * STNB 榜内求某人的名次与页码（「STNB 版我在哪里」，走 1 小时缓存全量数组，零 DB）。
 * 不在榜（无有效 STNB 成绩 / 当前列缺级）返回 null。
 */
export async function getStnbRankOfUser(
  id: number,
  by: BvRankingBy,
  nf = false
): Promise<{ rank: number; page: number } | null> {
  const { index } = await getStnbBoardIndex(by, nf);
  const rank = index.get(id);
  if (!rank) return null;
  return { rank, page: Math.floor((rank - 1) / RANKING_PAGESIZE) + 1 };
}

/**
 * 在线玩结算雷达的分位基准（2026-10-14 五期）：读取 video_metric_dist 全表，
 * 组织成 OnlinePlay 需要的 { `${level}${nf?"_nf":""}`: { bucket: { 指标: number[] } } }。
 * 表很小 —— 2026-10-14 起分组只按「级别 × 模式」、不细分 3BV，**恒 6 行**（bucket 一律 -1），
 * 整表读出内存分组；表不存在/空表时返回空对象（前端不显示雷达，只显示按钮）。
 */
export async function getOnlineMetricDists(): Promise<
  Record<string, Record<string, Record<string, number[]>>>
> {
  try {
    const rows = await prisma.videoMetricDist.findMany();
    const parse = (raw: string | null | undefined): number[] =>
      raw ? raw.split(",").filter((s) => s !== "").map(Number) : [];
    const out: Record<string, Record<string, Record<string, number[]>>> = {};
    for (const r of rows) {
      const key = r.level + (r.noflag ? "_nf" : "");
      if (!out[key]) out[key] = {};
      out[key][String(r.bucket)] = {
        bvs: parse(r.bvs),
        ioe: parse(r.ioe),
        corr: parse(r.corr),
        cls: parse(r.cls),
        ppc: parse(r.ppc),
        stnb: parse(r.stnb),
      };
    }
    return out;
  } catch {
    return {};
  }
}
