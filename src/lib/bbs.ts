// BBS 论坛（移植 2008 版 BBS/*：板块/主题/回复/置顶/精华/锁定/移动/删除 + UBB 渲染）

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";

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

export const BBS_ORDERS = {
  reply: "按回复时间",
  post: "按发布时间",
  clicks: "按点击数",
  replies: "按回复数",
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
  let text = escapeHtml(raw);
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
  return text.replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;").replace(/\r?\n/g, "<br>");
}

// ---------- 查询 ----------

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
  author: UserBrief | null;
  lastReplyAuthor: UserBrief | null;
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
  // 置顶帖永远在最前（移植 2008 版 High 语义）
  const orderField =
    order === "post" ? "id" : order === "clicks" ? "clicks" : order === "replies" ? "replies" : "lastReplyTime";
  const rows = await prisma.bbsPost.findMany({
    where,
    orderBy: [{ isTop: "desc" }, { [orderField]: "desc" }],
    skip: (page - 1) * BBS_PAGESIZE,
    take: BBS_PAGESIZE,
  });
  const authors = await usersByIds([
    ...new Set([...rows.map((r) => N(r.user)), ...rows.map((r) => N(r.lastReplyUser))].filter((x) => x > 0)),
  ]);
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
      lastReplyAuthor: authors.get(N(r.lastReplyUser)) ?? null,
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
  const authors = await usersByIds([N(row.user), N(row.lastReplyUser)].filter((x) => x > 0));
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
    lastReplyAuthor: authors.get(N(row.lastReplyUser)) ?? null,
  };
}

export interface BbsReplyItem {
  id: number;
  floor: number;
  content: string;
  createTime: number;
  author: UserBrief | null;
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
  const authors = await usersByIds([...new Set(rows.map((r) => N(r.user)))]);
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
  const row = await prisma.bbsPost.create({
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
  return N(row.id);
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
  const [reply] = await prisma.$transaction([
    prisma.bbsReply.create({
      data: { post: BigInt(postId), user: BigInt(userId), content, createTime: now, updateTime: now },
    }),
    prisma.bbsPost.update({
      where: { id: BigInt(postId) },
      data: { replies: { increment: 1 }, lastReplyTime: now, lastReplyUser: BigInt(userId) },
    }),
  ]);
  return N(reply.id);
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
