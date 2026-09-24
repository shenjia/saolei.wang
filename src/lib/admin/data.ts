// 后台列表 / 详情查询（2026-09-24 管理后台）
//
// 设计：
// · 列表一律「raw SQL 只取 id 页 + Prisma 批量补数据」，避免 30 万行大表的 N+1。
// · 一切用户输入走 ? 占位符绑定；只有列名/排序方向这种白名单枚举才拼进 SQL 串。
// · 后台每页 25 条。

import { prisma } from "@/lib/db";
import { title as assessTitle } from "@/lib/assess";
import { usersByIds, type UserBrief } from "@/lib/queries";
import { BBS_BOARD_NAMES, BBS_BOARDS, ubb } from "@/lib/bbs";
import { VIDEO_STATUS, type VideoLevel } from "@/lib/config";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

export const ADMIN_PAGESIZE = 25;

// ---------- 玩家 ----------

export interface AdminUserRow extends UserBrief {
  username: string;
  area: string;
  status: number;
  role: number;
  createTime: number;
  lastLoginTime: number;
  title: string;
  sumTime: number;
  /** 录像总数 */
  videos: number;
}

const USER_ORDERS: Record<string, string> = {
  reg: "u.create_time DESC, u.id DESC",
  old: "u.create_time ASC, u.id ASC",
  last: "u.last_login_time DESC, u.id DESC",
  sum: "(s.sum_time IS NULL OR s.sum_time = 0) ASC, s.sum_time ASC",
  name: "u.chinese_name ASC, u.id ASC",
};

export interface UserFilter {
  q?: string;
  status?: string;
  role?: string;
  sex?: string;
  area?: string;
  ranked?: string;
  order?: string;
  page?: number;
}

/** 列表筛选条件 → SQL 片段 + 参数（页面与「导出/计数」共用） */
function userWhere(f: UserFilter): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) {
      conds.push("u.id = ?");
      params.push(BigInt(q));
    } else {
      conds.push("(u.chinese_name LIKE ? OR u.english_name LIKE ? OR a.username LIKE ? OR i.nickname LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
  }
  if (f.status === "banned") conds.push("u.status <> 0");
  if (f.status === "normal") conds.push("u.status = 0");
  if (f.role && /^\d+$/.test(f.role)) {
    conds.push("a.role = ?");
    params.push(parseInt(f.role, 10));
  }
  if (f.sex === "1" || f.sex === "0") {
    conds.push("u.sex = ?");
    params.push(parseInt(f.sex, 10));
  }
  if (f.area) {
    conds.push("u.area = ?");
    params.push(f.area);
  }
  if (f.ranked === "1") conds.push("s.sum_time > 0");
  if (f.ranked === "0") conds.push("(s.sum_time IS NULL OR s.sum_time = 0)");
  return { sql: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}

const USER_FROM = `FROM user u
  LEFT JOIN user_auth a ON a.id = u.id
  LEFT JOIN user_scores s ON s.id = u.id
  LEFT JOIN user_info i ON i.id = u.id`;

export async function getUserList(
  f: UserFilter
): Promise<{ rows: AdminUserRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const { sql, params } = userWhere(f);
  const order = USER_ORDERS[f.order ?? "reg"] ?? USER_ORDERS.reg;

  const [ids, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT u.id ${USER_FROM} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      ADMIN_PAGESIZE,
      (page - 1) * ADMIN_PAGESIZE
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) c ${USER_FROM} ${sql}`, ...params),
  ]);

  const uidList = ids.map((r) => N(r.id));
  const bigIds = uidList.map(BigInt);
  const [users, auths, scores, videoCounts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: bigIds } } }),
    prisma.userAuth.findMany({ where: { id: { in: bigIds } }, select: { id: true, username: true, role: true } }),
    prisma.userScores.findMany({ where: { id: { in: bigIds } } }),
    uidList.length
      ? prisma.$queryRawUnsafe<{ user: bigint; c: bigint }[]>(
          `SELECT user, COUNT(*) c FROM video WHERE user IN (${uidList.map(() => "?").join(",")}) GROUP BY user`,
          ...bigIds
        )
      : Promise.resolve([] as { user: bigint; c: bigint }[]),
  ]);

  const uMap = new Map(users.map((u) => [N(u.id), u]));
  const authMap = new Map(auths.map((a) => [N(a.id), a]));
  const scoreMap = new Map(scores.map((s) => [N(s.id), s]));
  const vcMap = new Map(videoCounts.map((v) => [N(v.user), N(v.c)]));

  const rows: AdminUserRow[] = [];
  for (const id of uidList) {
    const u = uMap.get(id);
    if (!u) continue;
    const auth = authMap.get(id);
    const sumTime = N(scoreMap.get(id)?.sumTime);
    rows.push({
      id,
      chineseName: u.chineseName,
      englishName: u.englishName,
      sex: u.sex,
      username: auth?.username ?? "",
      area: u.area,
      status: u.status,
      role: auth?.role ?? 0,
      createTime: N(u.createTime),
      lastLoginTime: N(u.lastLoginTime),
      title: await assessTitle(sumTime),
      sumTime,
      videos: vcMap.get(id) ?? 0,
    });
  }

  return { rows, total: N(countRows[0]?.c), pageSize: ADMIN_PAGESIZE, page };
}

export interface AdminUserDetail {
  row: AdminUserRow;
  qq: string;
  nickname: string;
  mouse: string;
  pad: string;
  selfIntro: string;
  interest: string;
  loginTimes: number;
  loginIp: string;
  clicks: number;
  newsCount: number;
  commentCount: number;
  bbsCount: number;
  messageCount: number;
  /** 总计时间名次（0 = 未上榜） */
  sumRank: number;
  ranks: { beg: number; int: number; exp: number };
  recentVideos: { id: number; level: string; status: number; createTime: number; realTime: number; board3bv: number }[];
  oauth: { provider: string; nickname: string; createTime: number }[];
  recentLogs: { action: string; detail: string; createTime: number; user: number }[];
}

export async function getUserDetailAdmin(id: number): Promise<AdminUserDetail | null> {
  const uid = BigInt(id);
  const [user, auth, score, info, stat] = await Promise.all([
    prisma.user.findUnique({ where: { id: uid } }),
    prisma.userAuth.findUnique({ where: { id: uid } }),
    prisma.userScores.findUnique({ where: { id: uid } }),
    prisma.userInfo.findUnique({ where: { id: uid } }),
    prisma.userStat.findUnique({ where: { id: uid } }),
  ]);
  if (!user) return null;

  const [newsCount, commentCount, bbsCount, messageCount, clicks, videos, oauth, logs] = await Promise.all([
    prisma.news.count({ where: { user: uid } }),
    prisma.comment.count({ where: { user: uid, status: 0 } }),
    prisma.bbsPost.count({ where: { user: uid, status: 0 } }),
    prisma.message.count({ where: { toUser: uid } }),
    prisma.click.count({ where: { user: uid } }),
    prisma.video.findMany({
      where: { user: uid },
      orderBy: { id: "desc" },
      take: 10,
      select: { id: true, level: true, status: true, createTime: true },
    }),
    prisma.userOauth.findMany({ where: { userId: uid }, select: { provider: true, nickname: true, createTime: true } }),
    prisma.adminLog.findMany({ where: { target: "user", targetId: uid }, orderBy: { id: "desc" }, take: 10 }),
  ]);

  const infos = videos.length
    ? await prisma.videoInfo.findMany({ where: { id: { in: videos.map((v) => v.id) } } })
    : [];
  const infoMap = new Map(infos.map((i) => [N(i.id), i]));

  const sumTime = N(score?.sumTime);
  // 名次 = 成绩更好的人数 + 1（同分并列取小）
  const rankRows = sumTime
    ? await prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM user_scores WHERE sum_time > 0 AND sum_time < ?`,
        sumTime
      )
    : [];

  // 名次 = 成绩更好的人数 + 1（同分并列取小）；SQL 里必须用 snake_case 列名（Prisma 字段是 camelCase）
  const [begRank, intRank, expRank] = await Promise.all(
    (
      [
        ["beg_time", score?.begTime],
        ["int_time", score?.intTime],
        ["exp_time", score?.expTime],
      ] as [string, number | null | undefined][]
    ).map(async ([col, raw]) => {
      const v = N(raw);
      if (!v) return 0;
      const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
        `SELECT COUNT(*) c FROM user_scores WHERE ${col} > 0 AND ${col} < ?`,
        v
      );
      return N(rows[0]?.c) + 1;
    })
  );

  const brief = (await usersByIds([id])).get(id) ?? {
    id,
    chineseName: user.chineseName,
    englishName: user.englishName,
    sex: user.sex,
  };

  return {
    row: {
      ...brief,
      username: auth?.username ?? "",
      area: user.area,
      status: user.status,
      role: auth?.role ?? 0,
      createTime: N(user.createTime),
      lastLoginTime: N(user.lastLoginTime),
      title: await assessTitle(sumTime),
      sumTime,
      videos: await prisma.video.count({ where: { user: uid } }),
    },
    qq: info?.qq ?? "",
    nickname: info?.nickname ?? "",
    mouse: info?.mouse ?? "",
    pad: info?.pad ?? "",
    selfIntro: info?.selfIntro ?? "",
    interest: info?.interest ?? "",
    loginTimes: N(stat?.loginTimes),
    loginIp: stat?.loginIp ?? "",
    clicks,
    newsCount,
    commentCount,
    bbsCount,
    messageCount,
    sumRank: sumTime ? N(rankRows[0]?.c) + 1 : 0,
    ranks: { beg: begRank, int: intRank, exp: expRank },
    recentVideos: videos.map((v) => ({
      id: N(v.id),
      level: v.level,
      status: v.status,
      createTime: N(v.createTime),
      realTime: infoMap.get(N(v.id))?.realTime ?? 0,
      board3bv: infoMap.get(N(v.id))?.board3bv ?? 0,
    })),
    oauth: oauth.map((o) => ({ provider: o.provider, nickname: o.nickname, createTime: N(o.createTime) })),
    recentLogs: logs.map((l) => ({ action: l.action, detail: l.detail, createTime: N(l.createTime), user: N(l.user) })),
  };
}

// ---------- 录像 ----------

export interface AdminVideoRow {
  id: number;
  user: number;
  author: UserBrief | null;
  level: string;
  status: number;
  noflag: boolean;
  board3bv: number;
  realTime: number;
  software: string;
  version: string;
  hash: string;
  createTime: number;
  reviewUser: number | null;
  reviewer: UserBrief | null;
  reviewTime: number | null;
  clicks: number;
  downloads: number;
  comments: number;
  /** 是否有解析信息（false = 上传中断/解析失败） */
  hasInfo: boolean;
}

const VIDEO_ORDERS: Record<string, string> = {
  new: "v.id DESC",
  old: "v.id ASC",
  time: "vi.real_time ASC",
  board: "vi.board_3bv DESC",
  click: "t.clicks DESC",
};

export interface VideoFilter {
  level?: string;
  status?: string;
  nf?: string;
  q?: string;
  from?: string;
  to?: string;
  order?: string;
  page?: number;
}

function videoWhere(f: VideoFilter): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.level && ["beg", "int", "exp"].includes(f.level)) {
    conds.push("v.level = ?");
    params.push(f.level);
  }
  if (f.status && ["0", "10", "20"].includes(f.status)) {
    conds.push("v.status = ?");
    params.push(parseInt(f.status, 10));
  }
  if (f.nf === "1") conds.push("vi.noflag = 1");
  if (f.nf === "0") conds.push("vi.noflag = 0");
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) {
      conds.push("(v.id = ? OR v.user = ?)");
      params.push(BigInt(q), BigInt(q));
    } else {
      conds.push("u.chinese_name LIKE ?");
      params.push(`%${q}%`);
    }
  }
  // 日期（本地日边界）
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) {
    conds.push("v.create_time >= ?");
    params.push(Math.floor(new Date(`${f.from}T00:00:00`).getTime() / 1000));
  }
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) {
    conds.push("v.create_time < ?");
    params.push(Math.floor(new Date(`${f.to}T00:00:00`).getTime() / 1000) + 86400);
  }
  return { sql: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}

const VIDEO_FROM = `FROM video v
  LEFT JOIN video_info vi ON vi.id = v.id
  LEFT JOIN user u ON u.id = v.user
  LEFT JOIN video_stat t ON t.id = v.id`;

export async function getVideoListAdmin(
  f: VideoFilter
): Promise<{ rows: AdminVideoRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const { sql, params } = videoWhere(f);
  const order = VIDEO_ORDERS[f.order ?? "new"] ?? VIDEO_ORDERS.new;

  const [ids, countRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: bigint }[]>(
      `SELECT v.id ${VIDEO_FROM} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      ADMIN_PAGESIZE,
      (page - 1) * ADMIN_PAGESIZE
    ),
    prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) c ${VIDEO_FROM} ${sql}`, ...params),
  ]);

  const rows = await fillVideos(ids.map((r) => N(r.id)));
  return { rows, total: N(countRows[0]?.c), pageSize: ADMIN_PAGESIZE, page };
}

/** 按 id 批量补齐录像行（保持传入顺序，缺 video_info 的照样列出并标记） */
export async function fillVideos(ids: number[]): Promise<AdminVideoRow[]> {
  if (!ids.length) return [];
  const bigIds = ids.map(BigInt);
  const [videos, infos, stats] = await Promise.all([
    prisma.video.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoInfo.findMany({ where: { id: { in: bigIds } } }),
    prisma.videoStat.findMany({ where: { id: { in: bigIds } } }),
  ]);
  const authors = await usersByIds(videos.map((v) => N(v.user)));
  const reviewers = await usersByIds([...new Set(videos.map((v) => N(v.reviewUser)))].filter((x) => x > 0));
  const vMap = new Map(videos.map((v) => [N(v.id), v]));
  const iMap = new Map(infos.map((i) => [N(i.id), i]));
  const sMap = new Map(stats.map((s) => [N(s.id), s]));

  const out: AdminVideoRow[] = [];
  for (const id of ids) {
    const v = vMap.get(id);
    if (!v) continue;
    const info = iMap.get(id);
    const st = sMap.get(id);
    out.push({
      id,
      user: N(v.user),
      author: authors.get(N(v.user)) ?? null,
      level: v.level,
      status: v.status,
      noflag: info?.noflag ?? false,
      board3bv: info?.board3bv ?? 0,
      realTime: info?.realTime ?? 0,
      software: info?.software ?? "",
      version: info?.version ?? "",
      hash: v.hash,
      createTime: N(v.createTime),
      reviewUser: v.reviewUser == null ? null : N(v.reviewUser),
      reviewer: reviewers.get(N(v.reviewUser)) ?? null,
      reviewTime: v.reviewTime == null ? null : N(v.reviewTime),
      clicks: st?.clicks ?? 0,
      downloads: st?.downloads ?? 0,
      comments: st?.comments ?? 0,
      hasInfo: Boolean(info),
    });
  }
  return out;
}

// ---------- 评论 ----------

export interface AdminCommentRow {
  id: number;
  user: number;
  author: UserBrief | null;
  video: number;
  videoLevel: string;
  videoUser: number;
  content: string;
  status: number;
  createTime: number;
}

export async function getCommentListAdmin(f: {
  q?: string;
  status?: string;
  page?: number;
}): Promise<{ rows: AdminCommentRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.status === "1") where.status = -1;
  else if (f.status === "0") where.status = 0;
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ id: BigInt(q) }, { user: BigInt(q) }, { video: BigInt(q) }];
    else where.content = { contains: q };
  }

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.comment.count({ where }),
  ]);

  const authors = await usersByIds(comments.map((c) => N(c.user)));
  const vids = [...new Set(comments.map((c) => N(c.video)))];
  const videos = vids.length
    ? await prisma.video.findMany({ where: { id: { in: vids.map(BigInt) } }, select: { id: true, level: true, user: true } })
    : [];
  const vMap = new Map(videos.map((v) => [N(v.id), v]));

  return {
    rows: comments.map((c) => ({
      id: N(c.id),
      user: N(c.user),
      author: authors.get(N(c.user)) ?? null,
      video: N(c.video),
      videoLevel: vMap.get(N(c.video))?.level ?? "",
      videoUser: N(vMap.get(N(c.video))?.user),
      content: c.content ?? "",
      status: c.status,
      createTime: N(c.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

// ---------- 论坛 ----------

export interface AdminPostRow {
  id: number;
  board: number;
  boardName: string;
  user: number;
  author: UserBrief | null;
  title: string;
  replies: number;
  clicks: number;
  isTop: boolean;
  isNice: boolean;
  isLocked: boolean;
  status: number;
  lastReplyTime: number;
  createTime: number;
}

export async function getPostListAdmin(f: {
  board?: string;
  q?: string;
  flag?: string;
  status?: string;
  page?: number;
}): Promise<{ rows: AdminPostRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.board && /^\d+$/.test(f.board)) where.board = parseInt(f.board, 10);
  if (f.status === "1") where.status = -1;
  else if (f.status === "0") where.status = 0;
  if (f.flag === "top") where.isTop = true;
  if (f.flag === "nice") where.isNice = true;
  if (f.flag === "locked") where.isLocked = true;
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ id: BigInt(q) }, { user: BigInt(q) }];
    else where.OR = [{ title: { contains: q } }, { content: { contains: q } }];
  }

  const [posts, total] = await Promise.all([
    prisma.bbsPost.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
      select: {
        id: true, board: true, user: true, title: true, replies: true, clicks: true,
        isTop: true, isNice: true, isLocked: true, status: true, lastReplyTime: true, createTime: true,
      },
    }),
    prisma.bbsPost.count({ where }),
  ]);
  const authors = await usersByIds(posts.map((p) => N(p.user)));

  return {
    rows: posts.map((p) => ({
      id: N(p.id),
      board: p.board,
      boardName: BBS_BOARD_NAMES[p.board] ?? String(p.board),
      user: N(p.user),
      author: authors.get(N(p.user)) ?? null,
      title: p.title,
      replies: p.replies,
      clicks: p.clicks,
      isTop: p.isTop,
      isNice: p.isNice,
      isLocked: p.isLocked,
      status: p.status,
      lastReplyTime: N(p.lastReplyTime),
      createTime: N(p.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

export interface AdminReplyRow {
  id: number;
  post: number;
  user: number;
  author: UserBrief | null;
  content: string;
  status: number;
  createTime: number;
}

export async function getReplyListAdmin(postId: number): Promise<{
  post: { id: number; title: string; board: number } | null;
  rows: AdminReplyRow[];
}> {
  const post = await prisma.bbsPost.findUnique({
    where: { id: BigInt(postId) },
    select: { id: true, title: true, board: true },
  });
  if (!post) return { post: null, rows: [] };
  const replies = await prisma.bbsReply.findMany({ where: { post: post.id }, orderBy: { id: "asc" }, take: 200 });
  const authors = await usersByIds(replies.map((r) => N(r.user)));
  return {
    post: { id: N(post.id), title: post.title, board: post.board },
    rows: replies.map((r) => ({
      id: N(r.id),
      post: N(r.post),
      user: N(r.user),
      author: authors.get(N(r.user)) ?? null,
      content: ubb(r.content ?? ""),
      status: r.status,
      createTime: N(r.createTime),
    })),
  };
}

// ---------- 动态 ----------

export interface AdminNewsRow {
  id: number;
  type: number;
  user: number;
  author: UserBrief | null;
  userScore: number;
  reference: number;
  detailsData: string;
  createTime: number;
}

export async function getNewsListAdmin(f: {
  type?: string;
  q?: string;
  page?: number;
}): Promise<{ rows: AdminNewsRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.type && /^\d+$/.test(f.type)) where.type = parseInt(f.type, 10);
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ id: BigInt(q) }, { user: BigInt(q) }, { reference: BigInt(q) }];
    else where.detailsData = { contains: q };
  }

  const [news, total] = await Promise.all([
    prisma.news.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.news.count({ where }),
  ]);
  const authors = await usersByIds(news.map((n) => N(n.user)));

  return {
    rows: news.map((n) => ({
      id: N(n.id),
      type: n.type,
      user: N(n.user),
      author: authors.get(N(n.user)) ?? null,
      userScore: n.userScore,
      reference: N(n.reference),
      detailsData: n.detailsData,
      createTime: N(n.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

// ---------- 操作日志 ----------

export interface AdminLogRow {
  id: number;
  user: number;
  author: UserBrief | null;
  action: string;
  target: string;
  targetId: number;
  detail: string;
  ip: string;
  createTime: number;
}

export async function getAdminLogs(f: {
  q?: string;
  action?: string;
  page?: number;
}): Promise<{ rows: AdminLogRow[]; total: number; pageSize: number; page: number }> {
  const page = Math.max(1, f.page ?? 1);
  const where: Record<string, unknown> = {};
  if (f.action) where.action = f.action;
  const q = (f.q ?? "").trim();
  if (q) {
    if (/^\d+$/.test(q)) where.OR = [{ user: BigInt(q) }, { targetId: BigInt(q) }];
    else where.detail = { contains: q };
  }

  const [logs, total] = await Promise.all([
    prisma.adminLog.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * ADMIN_PAGESIZE,
      take: ADMIN_PAGESIZE,
    }),
    prisma.adminLog.count({ where }),
  ]);
  const authors = await usersByIds([...new Set(logs.map((l) => N(l.user)))]);

  return {
    rows: logs.map((l) => ({
      id: N(l.id),
      user: N(l.user),
      author: authors.get(N(l.user)) ?? null,
      action: l.action,
      target: l.target,
      targetId: N(l.targetId),
      detail: l.detail,
      ip: l.ip,
      createTime: N(l.createTime),
    })),
    total,
    pageSize: ADMIN_PAGESIZE,
    page,
  };
}

/** 日志页动作下拉选项 */
export async function getLogActions(): Promise<{ action: string; count: number }[]> {
  const rows = await prisma.adminLog.groupBy({ by: ["action"], _count: { _all: true } });
  return rows.map((r) => ({ action: r.action, count: r._count._all })).sort((a, b) => b.count - a.count);
}

// ---------- 下拉选项数据 ----------

export async function getAreaOptions(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ area: string }[]>(
    `SELECT DISTINCT area FROM user WHERE area <> '' ORDER BY area`
  );
  return rows.map((r) => r.area);
}

// ---------- 首页信息流（仪表盘右侧栏） ----------

export async function getLatestUsers(limit = 8): Promise<AdminUserRow[]> {
  const users = await prisma.user.findMany({ orderBy: { id: "desc" }, take: limit });
  const ids = users.map((u) => u.id);
  const [auths, scores] = await Promise.all([
    prisma.userAuth.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, role: true } }),
    prisma.userScores.findMany({ where: { id: { in: ids } } }),
  ]);
  const aMap = new Map(auths.map((a) => [N(a.id), a]));
  const sMap = new Map(scores.map((s) => [N(s.id), s]));
  const rows: AdminUserRow[] = [];
  for (const u of users) {
    const id = N(u.id);
    const sumTime = N(sMap.get(id)?.sumTime);
    rows.push({
      id,
      chineseName: u.chineseName,
      englishName: u.englishName,
      sex: u.sex,
      username: aMap.get(id)?.username ?? "",
      area: u.area,
      status: u.status,
      role: aMap.get(id)?.role ?? 0,
      createTime: N(u.createTime),
      lastLoginTime: N(u.lastLoginTime),
      title: await assessTitle(sumTime),
      sumTime,
      videos: 0,
    });
  }
  return rows;
}

export async function getLatestVideosBrief(limit = 8): Promise<(AdminVideoRow & { authorName: string })[]> {
  const ids = await prisma.video.findMany({ orderBy: { id: "desc" }, take: limit, select: { id: true } });
  const rows = await fillVideos(ids.map((r) => N(r.id)));
  return rows.map((r) => ({ ...r, authorName: r.author?.chineseName ?? `#${r.user}` }));
}

// ---------- 站内信广播历史 ----------

export interface BroadcastRow {
  content: string;
  fromUser: number;
  author: UserBrief | null;
  receivers: number;
  readCount: number;
  createTime: number;
}

/** 广播历史：按「发送人 + 内容 + 时间」聚合成一次广播（逐条写入 message 表，故用聚合还原） */
export async function getBroadcastHistory(limit = 20): Promise<BroadcastRow[]> {
  const rows = await prisma.$queryRawUnsafe<
    { content: string; from_user: bigint; c: bigint; read_c: bigint; t: bigint }[]
  >(
    `SELECT content, from_user, COUNT(*) c, SUM(is_read = 1) read_c, MIN(create_time) t
     FROM message WHERE is_system = 1
     GROUP BY content, from_user, create_time
     ORDER BY t DESC LIMIT ${limit}`
  );
  const authors = await usersByIds(rows.map((r) => N(r.from_user)));
  return rows.map((r) => ({
    content: r.content,
    fromUser: N(r.from_user),
    author: authors.get(N(r.from_user)) ?? null,
    receivers: N(r.c),
    readCount: N(r.read_c),
    createTime: N(r.t),
  }));
}

/** 站内信总览 */
export async function getMessageStats(): Promise<{ total: number; unread: number; system: number; today: number }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = BigInt(Math.floor(today.getTime() / 1000));
  const [total, unread, system, todayCount] = await Promise.all([
    prisma.message.count(),
    prisma.message.count({ where: { isRead: false } }),
    prisma.message.count({ where: { isSystem: true } }),
    prisma.message.count({ where: { createTime: { gte: since } } }),
  ]);
  return { total, unread, system, today: todayCount };
}

// ---------- 每日一星 ----------

export interface StarRow {
  date: string;
  user: number;
  author: UserBrief | null;
  createTime: number;
}

export async function getStarHistory(limit = 14): Promise<StarRow[]> {
  const rows = await prisma.star.findMany({ orderBy: { date: "desc" }, take: limit });
  const authors = await usersByIds(rows.map((r) => N(r.user)));
  return rows.map((r) => ({
    date: r.date,
    user: N(r.user),
    author: authors.get(N(r.user)) ?? null,
    createTime: N(r.createTime),
  }));
}

/** 搜索玩家（供「指定每日一星」表单用）：按姓名 / 账号模糊匹配 */
export async function searchUsersBrief(q: string, limit = 10): Promise<{ id: number; name: string; username: string }[]> {
  const kw = q.trim();
  if (!kw) return [];
  const like = `%${kw}%`;
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; chinese_name: string; username: string }[]>(
    `SELECT u.id, u.chinese_name, COALESCE(a.username, '') username
     FROM user u LEFT JOIN user_auth a ON a.id = u.id
     WHERE u.chinese_name LIKE ? OR u.english_name LIKE ? OR a.username LIKE ?
     ORDER BY u.id DESC LIMIT ${limit}`,
    like,
    like,
    like
  );
  return rows.map((r) => ({ id: N(r.id), name: r.chinese_name, username: r.username }));
}

export { BBS_BOARDS, VIDEO_STATUS, type VideoLevel, type VideoLevel as VLevel };
