// BBS 论坛（移植 2008 版 BBS/*：板块/主题/回复/置顶/精华/锁定/移动/删除 + UBB 渲染）

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";
import { title as assessTitle } from "./assess";
import { oldTitle, type OldTitle } from "./oldtitle";
import { NEWS_TYPE } from "./config";
import { publishNews } from "./news";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

// 板块（移植 2008 版 Model 分类：公告/技术/杂谈/问答）
export const BBS_BOARDS = [
  { id: 0, key: "notice", name: "公告" },
  { id: 1, key: "skill", name: "技术" },
  { id: 2, key: "other", name: "杂谈" },
  { id: 3, key: "ask", name: "问答" },
] as const;
export const BBS_BOARD_NAMES: Record<number, string> = Object.fromEntries(
  BBS_BOARDS.map((b) => [b.id, b.name])
);

export const BBS_PAGESIZE = 19;
export const BBS_REPLY_PAGESIZE = 10;
export const BBS_TITLE_LIMIT = 100;
export const BBS_CONTENT_LIMIT = 5000;

// 排序文案（2026-09-24 张老师要求：去「按」前缀；「回复时间」改「更新时间」；
// 同日三轮：去掉「点击数/回复数」两种排序，只留时间类）
// 2026-09-25 六轮：排序筛选器已取消，列表固定更新时间排序（order="reply"）；
//   BBS_ORDERS/BbsOrder 保留供 getPostList 类型签名使用，页面不再暴露 order 参数
export const BBS_ORDERS = {
  reply: "更新时间",
  post: "发布时间",
} as const;
export type BbsOrder = keyof typeof BBS_ORDERS;

// ---------- UBB 渲染（移植 Models/Include/UBB.asp；先 HTML 转义再做白名单替换，杜绝注入） ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MINE_MAP: Record<string, string> = {
  " ": "Blank",
  ".": "Black",
  Q: "Block",
  "!": "Flag",
  "?": "Mark",
  "-": "Num",
  "+": "IsMine",
  "*": "Mine",
};

export function ubb(raw: string): string {
  // 2008 版 UBB 不做 HTML 转义直接输出，MSSQL 老数据里混有字面 <br> 与 &nbsp;（[&nbsp;] 是扫雷空格符号）
  // 转义前先把这些老遗留标记归一化，否则转义后会在页面上原样显示
  // 旧站链接重写（2026-09-25）：
  // ① 静态图热链：历史帖子里 36 处 [img]http://(www.)saolei.(net|wang)/Models/Images/…
  //    旧域名（net 已被抢注跳垃圾站、wang 未来下线）不可依赖 → 重写为新站本地路径
  //    /models/images/…（旧站 Models/Images 已全量拷到 public/models/images/，288 文件 ~8M）
  // ② 页面绝对链接：274 处 [url http://www.saolei.net/BBS/Title.asp?Id=1970/] 形态——
  //    域名改写成相对路径后交由 src/proxy.ts 的旧站 301 规则接管（.asp 请求全量拦截），
  //    Id/Page 等查询串原样保留，落在正确的帖子/玩家/录像页
  const normalized = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[&nbsp;\]/gi, "[ ]")
    .replace(/&nbsp;/gi, "\u00a0")
    .replace(
      /https?:\/\/(?:www\.)?saolei\.(?:net|wang)(\/models\/images\/[^\s\[\]"]+)/gi,
      (_m, p: string) => p.toLowerCase()
    )
    .replace(
      /https?:\/\/(?:www\.)?saolei\.(?:net|wang)(\/(?:player|bbs|video|ranking|news|message|about|download|guide|help|hero|team|world|update|history|online|main|index)[^\s\[\]"]*)/gi,
      (_m, p: string) => p
    );
  let text = escapeHtml(normalized);
  // 标题/签名颜色 span（2013 legacy CSS 里有 .Title/.Sign/.Signest）
  text = text
    .replace(/\[Title\]/gi, '<span class="Title">')
    .replace(/\[\/Title\]/gi, "</span>")
    .replace(/\[Sign\]/gi, '<span class="Sign">')
    .replace(/\[\/Sign\]/gi, "</span>")
    .replace(/\[Signest\]/gi, '<span class="Signest">')
    .replace(/\[\/Signest\]/gi, "</span>");
  // 粗斜下划线
  text = text
    .replace(/\[b\]/gi, "<strong>")
    .replace(/\[\/b\]/gi, "</strong>")
    .replace(/\[i\]/gi, "<em>")
    .replace(/\[\/i\]/gi, "</em>")
    .replace(/\[u\]/gi, "<u>")
    .replace(/\[\/u\]/gi, "</u>");
  // 图片（转义后的引号是 &quot;，URL 中不可能有 < >）
  text = text.replace(/\[img\]([^\[\]]+?)\[\/img\]/gi, '<img align="top" src="$1">');
  // 链接：[url 地址]文字[/url] 与 [url]地址[/url]
  text = text.replace(
    /\[url\s+([^\[\]\s]+?)\]([^\[\]]*?)\[\/url\]/gi,
    '<a href="$1" target="_blank" rel="noreferrer">$2</a>'
  );
  text = text.replace(
    /\[url\]([^\[\]]+?)\[\/url\]/gi,
    '<a href="$1" target="_blank" rel="noreferrer">$1</a>'
  );
  // 引用
  text = text.replace(/\[quote\]/gi, "<blockquote>").replace(/\[\/quote\]/gi, "</blockquote>");
  // 表情：[face]N[/face]（N=0-29，白名单数字）
  text = text.replace(
    /\[face\](\d{1,2})\[\/face\]/gi,
    (_, n) => `<img src="/images/face/${Math.min(29, parseInt(n, 10))}.gif" alt="">`
  );
  // 扫雷符号：[1]-[8] 数字格 + 功能格
  for (let i = 0; i <= 8; i++) {
    text = text.replaceAll(`[${i}]`, `<img src="/images/mine/${i}.gif" alt="${i}">`);
  }
  for (const [key, name] of Object.entries(MINE_MAP)) {
    text = text.replaceAll(`[${key}]`, `<img src="/images/mine/${name.toLowerCase()}.gif" alt="">`);
  }
  // 换行与制表
  const out = text.replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;").replace(/\r?\n/g, "<br>");
  // 摆雷图行（2026-09-24 张老师要求：纯雷图行行距为 0，多行 gif 拼成完整地图）
  // 连续纯雷图行（含行间的单个 <br>）合并包进 <div class="mine-map">：块内 line-height=16px=图高，行间零缝隙；
  // 空行（<br><br>）与文字行（含 [Title]/face 等）终止分组，保持正常正文行高
  const isMineOnly = (line: string) =>
    line.length > 0 && /^(\s|<img src="\/images\/mine\/[^"]*" alt="[^"]*">)+$/.test(line);
  const isBr = (p: string) => /^<br\s*\/?>$/.test(p);
  const parts = out.split(/(<br\s*\/?>)/);
  let result = "";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      result += `<div class="mine-map">${buf.join("")}</div>`;
      buf = [];
    }
  };
  parts.forEach((p, i) => {
    if (isMineOnly(p)) {
      buf.push(p);
      return;
    }
    // 组内行间 <br>：仅当下一段内容仍是纯雷图行时并入组，否则组到此为止
    if (isBr(p) && buf.length && isMineOnly(parts[i + 1] ?? "")) {
      buf.push(p);
      return;
    }
    flush();
    result += p;
  });
  flush();
  return result;
}

// ---------- 查询 ----------

/** 作者信息 + 军衔/旧版称号（2026-09-23 张老师要求：详情页人名旁带性别标记与军衔） */
export interface BbsAuthor extends UserBrief {
  /** 18 级军衔（按 sum_time 评定，详情页 TitleBadge 徽章用） */
  title: string;
  /** 旧版称号（按高级纪录+性别，列表页 [称号] 用） */
  old: OldTitle;
}

/** usersByIds 之上补军衔与旧版称号（distribution 阈值在 assess 内缓存） */
async function authorsWithTitles(ids: number[]): Promise<Map<number, BbsAuthor>> {
  const [briefs, scores] = await Promise.all([
    usersByIds(ids),
    ids.length
      ? prisma.userScores.findMany({
          where: { id: { in: ids.map(BigInt) } },
          select: { id: true, sumTime: true, expTime: true },
        })
      : Promise.resolve([]),
  ]);
  const sumMap = new Map(scores.map((s) => [N(s.id), { sum: s.sumTime ?? 0, exp: s.expTime ?? 0 }]));
  const out = new Map<number, BbsAuthor>();
  for (const [id, b] of briefs) {
    const sc = sumMap.get(id) ?? { sum: 0, exp: 0 };
    out.set(id, { ...b, title: await assessTitle(sc.sum), old: oldTitle(sc.exp, b.sex) });
  }
  return out;
}

export interface BbsPostItem {
  id: number;
  board: number;
  title: string;
  replies: number;
  clicks: number;
  isTop: boolean;
  isNice: boolean;
  isLocked: boolean;
  createTime: number;
  lastReplyTime: number;
  author: BbsAuthor | null;
}

export async function getPostList(opts: {
  board?: number;
  order: BbsOrder;
  nice?: boolean;
  page: number;
}): Promise<{ posts: BbsPostItem[]; total: number; pageSize: number }> {
  const { board, order, nice, page } = opts;
  const where = {
    status: 0,
    ...(board !== undefined ? { board } : {}),
    ...(nice ? { isNice: true } : {}),
  };
  const total = await prisma.bbsPost.count({ where });
  // 2008 版置顶(IsHigh)不提前排序，只加标记（BBS_All 存储过程仅按时间列排序）
  const orderField = order === "post" ? "id" : "lastReplyTime";
  const rows = await prisma.bbsPost.findMany({
    where,
    orderBy: [{ [orderField]: "desc" }],
    skip: (page - 1) * BBS_PAGESIZE,
    take: BBS_PAGESIZE,
  });
  const authors = await authorsWithTitles([...new Set(rows.map((r) => N(r.user)).filter((x) => x > 0))]);
  return {
    posts: rows.map((r) => ({
      id: N(r.id),
      board: r.board,
      title: r.title,
      replies: r.replies,
      clicks: r.clicks,
      isTop: r.isTop,
      isNice: r.isNice,
      isLocked: r.isLocked,
      createTime: N(r.createTime),
      lastReplyTime: N(r.lastReplyTime),
      author: authors.get(N(r.user)) ?? null,
    })),
    total,
    pageSize: BBS_PAGESIZE,
  };
}

export interface BbsPostDetail extends BbsPostItem {
  content: string;
}

/** 读主题并点击 +1（移植 Title_Check；编辑预载等场景传 bump=false 避免误计） */
export async function getPost(id: number, bump = true): Promise<BbsPostDetail | null> {
  const row = await prisma.bbsPost.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return null;
  if (bump) {
    await prisma.bbsPost.update({ where: { id: row.id }, data: { clicks: { increment: 1 } } });
  }
  const authors = await authorsWithTitles([N(row.user)].filter((x) => x > 0));
  return {
    id: N(row.id),
    board: row.board,
    title: row.title,
    content: row.content,
    replies: row.replies,
    clicks: row.clicks + (bump ? 1 : 0),
    isTop: row.isTop,
    isNice: row.isNice,
    isLocked: row.isLocked,
    createTime: N(row.createTime),
    lastReplyTime: N(row.lastReplyTime),
    author: authors.get(N(row.user)) ?? null,
  };
}

export interface BbsReplyItem {
  id: number;
  floor: number;
  content: string;
  createTime: number;
  author: BbsAuthor | null;
}

export async function getReplies(
  postId: number,
  page: number
): Promise<{ replies: BbsReplyItem[]; total: number; pageSize: number }> {
  const where = { post: BigInt(postId), status: 0 };
  const total = await prisma.bbsReply.count({ where });
  const rows = await prisma.bbsReply.findMany({
    where,
    orderBy: { id: "asc" },
    skip: (page - 1) * BBS_REPLY_PAGESIZE,
    take: BBS_REPLY_PAGESIZE,
  });
  const authors = await authorsWithTitles([...new Set(rows.map((r) => N(r.user)))]);
  return {
    replies: rows.map((r, i) => ({
      id: N(r.id),
      floor: (page - 1) * BBS_REPLY_PAGESIZE + i + 2, // 1 楼是主题
      content: r.content,
      createTime: N(r.createTime),
      author: authors.get(N(r.user)) ?? null,
    })),
    total,
    pageSize: BBS_REPLY_PAGESIZE,
  };
}

/** 最新主题（首页右栏用，移植 Title_Index_New） */
export async function getLatestPosts(limit = 8): Promise<BbsPostItem[]> {
  const { posts } = await getPostList({ order: "post", page: 1 });
  return posts.slice(0, limit);
}

/** 加载更多（页码语义，BbsFeed 客户端组件 + /api/bbs/more 复用 getPostList） */
export async function getPostPage(opts: {
  board?: number;
  order: BbsOrder;
  nice?: boolean;
  page: number;
}): Promise<{ posts: BbsPostItem[]; total: number; pageSize: number; hasMore: boolean }> {
  const r = await getPostList(opts);
  return { ...r, hasMore: opts.page * r.pageSize < r.total };
}

// ---------- 写操作 ----------

/** 发帖资格：已加入排行（任一级别有成绩，移植 2008 版「加入排行后才能发布主题」） */
export async function canPost(userId: number): Promise<boolean> {
  const row = await prisma.userScores.findUnique({
    where: { id: BigInt(userId) },
    select: { sumTime: true, begTime: true, intTime: true, expTime: true },
  });
  return !!row && (row.sumTime ?? 0) + (row.begTime ?? 0) + (row.intTime ?? 0) + (row.expTime ?? 0) > 0;
}

export async function createPost(userId: number, board: number, title: string, content: string): Promise<number> {
  const now = nowSec();
  // 事务内同发「论坛文章」动态（2026-09-24 张老师要求；仅个人主页可见，不进首页新闻流）
  return prisma.$transaction(async (tx) => {
    const row = await tx.bbsPost.create({
      data: {
        board,
        user: BigInt(userId),
        title,
        content,
        lastReplyTime: now,
        lastReplyUser: BigInt(userId),
        createTime: now,
        updateTime: now,
      },
    });
    await publishNews({
      tx,
      type: NEWS_TYPE.ARTICLE,
      userId,
      reference: N(row.id),
      details: { t: title.slice(0, 50) },
      createTime: N(now),
    });
    return N(row.id);
  });
}

export async function updatePost(
  id: number,
  userId: number,
  isAdmin: boolean,
  data: { title?: string; content?: string; board?: number }
): Promise<boolean> {
  const row = await prisma.bbsPost.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return false;
  if (!isAdmin && N(row.user) !== userId) return false;
  await prisma.bbsPost.update({
    where: { id: row.id },
    data: { ...data, updateTime: nowSec() },
  });
  return true;
}

/** 回帖（锁定帖仅管理员可回；事务更新计数与最后回复，移植 Title_Reply） */
export async function createReply(
  postId: number,
  userId: number,
  content: string,
  isAdmin = false
): Promise<number | "locked" | null> {
  const post = await prisma.bbsPost.findFirst({ where: { id: BigInt(postId), status: 0 } });
  if (!post) return null;
  if (post.isLocked && !isAdmin) return "locked";
  const now = nowSec();
  // 事务内同发「评论」动态（BBS 回帖=评论文章，2026-09-24 张老师要求；仅个人主页可见）
  return prisma.$transaction(async (tx) => {
    const reply = await tx.bbsReply.create({
      data: { post: BigInt(postId), user: BigInt(userId), content, createTime: now, updateTime: now },
    });
    await tx.bbsPost.update({
      where: { id: BigInt(postId) },
      data: { replies: { increment: 1 }, lastReplyTime: now, lastReplyUser: BigInt(userId) },
    });
    await publishNews({
      tx,
      type: NEWS_TYPE.COMMENT,
      userId,
      reference: postId,
      details: { kind: "bbs", t: post.title.slice(0, 50) },
      createTime: N(now),
    });
    return N(reply.id);
  });
}

/** 删主题（软删；本人或管理员，移植 Title_Del / Del_My） */
export async function deletePost(id: number, userId: number, isAdmin: boolean): Promise<boolean> {
  const row = await prisma.bbsPost.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return false;
  if (!isAdmin && N(row.user) !== userId) return false;
  await prisma.bbsPost.update({ where: { id: row.id }, data: { status: -1, updateTime: nowSec() } });
  return true;
}

/** 删回复（本人/楼主/管理员，移植 2008 版录像评论删除的权限语义） */
export async function deleteReply(id: number, userId: number, isAdmin: boolean): Promise<boolean> {
  const row = await prisma.bbsReply.findFirst({ where: { id: BigInt(id), status: 0 } });
  if (!row) return false;
  const post = await prisma.bbsPost.findUnique({ where: { id: row.post } });
  if (!post) return false;
  if (!isAdmin && N(row.user) !== userId && N(post.user) !== userId) return false;
  await prisma.$transaction([
    prisma.bbsReply.update({ where: { id: row.id }, data: { status: -1, updateTime: nowSec() } }),
    prisma.bbsPost.update({ where: { id: row.post }, data: { replies: { decrement: 1 } } }),
  ]);
  return true;
}

/** 管理员：置顶/精华/锁定/移动板块（移植 Nice/High/Lock/Move Action） */
export async function adminSetPost(
  id: number,
  data: { isTop?: boolean; isNice?: boolean; isLocked?: boolean; board?: number }
): Promise<void> {
  await prisma.bbsPost.update({ where: { id: BigInt(id) }, data: { ...data, updateTime: nowSec() } });
}
