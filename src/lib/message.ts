// 站内信（移植 2008 版 Message/*：消息列表/读信/发信/清空 + 管理员广播）
// 2026-09-24 改版（张老师要求）：「收件箱」更名「消息」，作者列带军衔（论坛列表同款）

import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";
import { dualTitles } from "./title-system";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export const MESSAGE_CONTENT_LIMIT = 200;
export const MESSAGE_PAGESIZE = 15;

export interface MessageUserBrief extends UserBrief {
  /** 军衔（当前成绩评定，作者列 TitleBadge 用） */
  title: string;
  /** 旧版称号备选（Phase 5：观看者体系切换渲染） */
  classic: { name: string; color: string } | null;
}

export interface MessageItem {
  id: number;
  content: string;
  isRead: boolean;
  isSystem: boolean;
  createTime: number;
  from: MessageUserBrief | null;
  /** 收件人（仅「已发送」视角填充；此时 isRead 语义=对方是否已读） */
  to?: MessageUserBrief | null;
  /** true=「已发送」视角（我发出的私信，不可删除；isRead=对方已读与否） */
  sent?: boolean;
  /** true=评论/回复通知（系统代评论者发的通知，非手写私信——不给「回复」入口） */
  notice?: boolean;
  /** true=我在此条之后已给他发过信（仅手写私信有意义：行尾显示灰色「已回复」） */
  replied?: boolean;
}

/** usersByIds 之上补双体系称号（当前成绩评定；站内信无快照列，用实时值——
 *  站内信是瞬时通信场景，显示发信人当下称号合理） */
export async function messageAuthorsWithTitles(ids: number[]): Promise<Map<number, MessageUserBrief>> {
  const briefs = await usersByIds(ids);
  const scores = ids.length
    ? await prisma.userScores.findMany({
        where: { id: { in: ids.map(BigInt) } },
        select: { id: true, expTime: true },
      })
    : [];
  const statusRows = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids.map(BigInt) } }, select: { id: true, status: true } })
    : [];
  const expMap = new Map(scores.map((s) => [N(s.id), s.expTime ?? 0]));
  const statusMap = new Map(statusRows.map((u) => [N(u.id), u.status]));
  const pairList = await dualTitles(
    ids.map((id) => ({
      userId: id,
      expTime: expMap.get(id) ?? 0,
      ranked: (statusMap.get(id) ?? -1) === 0,
      sex: briefs.get(id)?.sex ?? 1,
    }))
  );
  // dualTitles 行序数组（2026-10-27）：ids 传入前已去重，一人一行无塌缩，下标一一对应
  const out = new Map<number, MessageUserBrief>();
  ids.forEach((id, i) => {
    const b = briefs.get(id);
    const p = pairList[i];
    if (b) out.set(id, { ...b, title: p?.m ?? "", classic: p?.c ?? null });
  });
  return out;
}

/**
 * 评论/回复通知消息的模板前缀（见 api/bbs/route.ts 发送处）。
 * 这类消息 is_system=false、寄件人=评论者，但**不是手写私信**：
 *   · 撤回逻辑（retractReplyNotice / retractPostNotices）靠它区分通知与私信；
 *   · 消息列表靠它决定不给「回复」入口（2026-10-27 张老师要求）。
 */
const REPLY_NOTICE_PREFIXES = ["我评论了你的文章", "我回复了你在"] as const;

/** 是否「评论/回复文章」通知（撤回逻辑专用，护栏必须窄） */
export function isReplyNotice(content: string): boolean {
  return REPLY_NOTICE_PREFIXES.some((p) => content.startsWith(p));
}

/**
 * 是否「通知类」消息（2026-10-27 张老师要求：只有单独手写的私信才给「回复」入口）。
 * 覆盖新站模板 + 2008 版迁移来的旧模板——这些全是系统代发通知，
 * 寄件人要么是评论者本人、要么是审核机器人，回复过去没有意义：
 *   · 我评论了你的文章… / 我评论了您的高?1.21秒录象!
 *   · 我回复了你在… / 我回复了您发表的主题"…"
 *   · 我评论了您的录像[url /video/…（2026-10-29 新模板，见 format.videoCommentNotice）
 *   · 您上传的高级53.36秒录象已经通过审核! / 您上传的高级56秒录像因为【…】被驳回
 *   · 录像文件损坏：原因是…
 */
const NOTICE_PREFIXES = [
  "我评论了你的文章",
  "我评论了您",
  "我回复了你在",
  "我回复了您",
  "您上传的",
  "录像文件损坏",
] as const;

export function isNoticeMessage(content: string): boolean {
  return NOTICE_PREFIXES.some((p) => content.startsWith(p));
}

export async function getUnreadCount(userId: number): Promise<number> {
  return prisma.message.count({ where: { toUser: BigInt(userId), isRead: false } });
}

export async function getMessageCount(userId: number): Promise<number> {
  return prisma.message.count({ where: { toUser: BigInt(userId) } });
}

/**
 * 消息列表（2026-10-14 加类型筛选：all=全部 / system=系统 / private=私信）。
 * total 随筛选联动——「加载更多」的剩余条数按当前筛选口径计算。
 * 2026-10-27（张老师要求）加 sent=已发送视角：我发出的全部记录（含广播逐条落行，
 * isSystem 一并保留），isRead 语义转为「对方是否已读」；行按 fromUser=我 查，
 * 天然不受「清空消息」（只删 toUser=我）影响——发出的记录不可删除。
 */
export type MessageTypeFilter = "all" | "system" | "private" | "sent";

export async function getMessageList(
  userId: number,
  page: number,
  type: MessageTypeFilter = "all"
): Promise<{ messages: MessageItem[]; total: number; pageSize: number }> {
  // sent 视角：fromUser=我（含 isSystem=true 的管理员广播行）
  if (type === "sent") {
    const where = { fromUser: BigInt(userId) };
    const total = await prisma.message.count({ where });
    const rows = await prisma.message.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * MESSAGE_PAGESIZE,
      take: MESSAGE_PAGESIZE,
    });
    const recipients = await messageAuthorsWithTitles([...new Set(rows.map((r) => N(r.toUser)))]);
    return {
      messages: rows.map((r) => ({
        id: N(r.id),
        content: r.content,
        isRead: r.isRead,
        isSystem: r.isSystem,
        createTime: N(r.createTime),
        from: null,
        to: recipients.get(N(r.toUser)) ?? null,
        sent: true,
      })),
      total,
      pageSize: MESSAGE_PAGESIZE,
    };
  }
  const where =
    type === "system"
      ? { toUser: BigInt(userId), isSystem: true }
      : type === "private"
        ? { toUser: BigInt(userId), isSystem: false }
        : { toUser: BigInt(userId) };
  const total = await prisma.message.count({ where });
  const rows = await prisma.message.findMany({
    where,
    orderBy: { id: "desc" },
    skip: (page - 1) * MESSAGE_PAGESIZE,
    take: MESSAGE_PAGESIZE,
  });
  const authors = await messageAuthorsWithTitles([...new Set(rows.map((r) => N(r.fromUser)))]);

  // 「已回复」判定（2026-10-27 张老师要求：只有手写私信给「回复」入口，回复过的显示灰色「已回复」）：
  // 口径＝我在此条消息之后给他发过信——按 id 比（自增序 = 投递序，避开同秒 createTime 平局）；
  // 对方之后再来新消息则新行重新可回复，老行仍显示「已回复」（一次查询 groupBy 拿每个收件人的最大 id）。
  const pendingFromIds = [
    ...new Set(rows.filter((r) => !r.isSystem && !isNoticeMessage(r.content)).map((r) => N(r.fromUser))),
  ].filter((id) => id > 0);
  const repliedMaxId = new Map<number, number>();
  if (pendingFromIds.length) {
    const grouped = await prisma.message.groupBy({
      by: ["toUser"],
      where: { fromUser: BigInt(userId), toUser: { in: pendingFromIds.map(BigInt) } },
      _max: { id: true },
    });
    for (const g of grouped) {
      if (g._max.id !== null) repliedMaxId.set(N(g.toUser), N(g._max.id));
    }
  }

  return {
    messages: rows.map((r) => {
      const notice = !r.isSystem && isNoticeMessage(r.content);
      const fromId = N(r.fromUser);
      return {
        id: N(r.id),
        content: r.content,
        isRead: r.isRead,
        isSystem: r.isSystem,
        createTime: N(r.createTime),
        from: authors.get(fromId) ?? null,
        notice,
        replied: !notice && (repliedMaxId.get(fromId) ?? 0) > N(r.id),
      };
    }),
    total,
    pageSize: MESSAGE_PAGESIZE,
  };
}

/** 标记单条已读（仅收件人可操作；2026-10-17 详情页下线，列表点击即读） */
export async function markMessageRead(id: number, userId: number): Promise<boolean> {
  const row = await prisma.message.findUnique({
    where: { id: BigInt(id) },
    select: { id: true, toUser: true, isRead: true },
  });
  if (!row || N(row.toUser) !== userId) return false;
  if (!row.isRead) {
    await prisma.message.update({ where: { id: row.id }, data: { isRead: true, updateTime: nowSec() } });
  }
  return true;
}

/**
 * 撤回「评论/回复文章」通知消息（2026-10-27 张老师要求：评论删了消息还在，
 * 点进去看不到评论——通知与内容生命周期同步）。
 *
 * 通知锚点格式（见 api/bbs/route.ts 发送处）：`?reply=<回复id>#reply-<回复id>`，
 * 按整段子串精确匹配（两段互为完整锚，`?reply=2447` 不会误配 `#reply-24474`）。
 * 三重护栏防误删普通私信：
 *   ① from_user 锁发送者=评论者本人；② 前缀必须是通知模板「我评论了你的文章」/「我回复了你在」；
 *   ③ 锚点整段匹配。
 */
export async function retractReplyNotice(
  fromUserId: number,
  replyId: number,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const db = tx ?? prisma;
  const res = await db.message.deleteMany({
    where: {
      fromUser: BigInt(fromUserId),
      isSystem: false,
      OR: REPLY_NOTICE_PREFIXES.map((prefix) => ({
        content: { startsWith: prefix, contains: `?reply=${replyId}#reply-${replyId}` },
      })),
    },
  });
  if (res.count > 0) console.log(`[message-retract] 撤回复 #${replyId} 通知：${res.count} 条`);
  return res.count;
}

/**
 * 撤回与某主题相关的全部评论通知（删帖场景：主题没了，任何指向它的通知都成死链）。
 * 按发送者=评论者 + 主题 id 维度整清；早期无锚点通知（`[url /bbs/<id>]` 直链）一并覆盖。
 * 前缀护栏同上——只清通知模板消息，绝不动用户手写私信。
 * 注意 Prisma 6 字符串过滤器的 OR 不能嵌在 StringFilter 里，只能在 where 顶层展开。
 */
export async function retractPostNotices(
  fromUserId: number,
  postId: number,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const db = tx ?? prisma;
  const res = await db.message.deleteMany({
    where: {
      fromUser: BigInt(fromUserId),
      isSystem: false,
      OR: [
        { content: { startsWith: "我评论了你的文章", contains: `/bbs/${postId}?reply=` } },
        { content: { startsWith: "我评论了你的文章", contains: `[url /bbs/${postId}]` } },
        { content: { startsWith: "我回复了你在", contains: `/bbs/${postId}?reply=` } },
        { content: { startsWith: "我回复了你在", contains: `[url /bbs/${postId}]` } },
      ],
    },
  });
  if (res.count > 0) console.log(`[message-retract] 撤主题 #${postId} 通知：${res.count} 条`);
  return res.count;
}

/**
 * 撤回「评论录像」通知（2026-10-29，评论删除/录像删除联动——口径同 retractReplyNotice）。
 * 锚点格式（见 format.videoCommentNotice）：`?comment=<cid>#comment-<cid>`，
 * 整段子串精确匹配；三重护栏防误删私信：① from_user 锁发送者=评论者本人
 * ② 前缀锁新模板「我评论了您的录像」③ 锚点整段匹配。
 * 旧站迁移的无链接通知（前缀同样以「我评论了您」开头）不带锚点，
 * contains 匹配不到，天然不会误删——与「不追撤历史」的方针一致。
 */
export async function retractVideoCommentNotice(
  fromUserId: number,
  commentId: number,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const db = tx ?? prisma;
  const res = await db.message.deleteMany({
    where: {
      fromUser: BigInt(fromUserId),
      isSystem: false,
      content: {
        startsWith: "我评论了您的录像",
        contains: `?comment=${commentId}#comment-${commentId}`,
      },
    },
  });
  if (res.count > 0) console.log(`[message-retract] 撤录像评论 #${commentId} 通知：${res.count} 条`);
  return res.count;
}

/** 发信 */
export async function sendMessage(fromUserId: number, toUserId: number, content: string): Promise<number> {
  const now = nowSec();
  const row = await prisma.message.create({
    data: {
      fromUser: BigInt(fromUserId),
      toUser: BigInt(toUserId),
      content,
      isRead: false,
      isSystem: false,
      createTime: now,
      updateTime: now,
    },
  });
  return N(row.id);
}

/**
 * 系统通知（is_system=true，无真实寄件人）。
 * 2026-09-24 新增：头像审核结果通知用户用（通过/驳回），避免用管理员 uid 当寄件人。
 */
export async function sendSystemMessage(toUserId: number, content: string): Promise<void> {
  const now = nowSec();
  await prisma.message.create({
    data: {
      fromUser: BigInt(0),
      toUser: BigInt(toUserId),
      content: content.slice(0, MESSAGE_CONTENT_LIMIT),
      isRead: false,
      isSystem: true,
      createTime: now,
      updateTime: now,
    },
  });
}

/** 清空消息列表（移植 Clear_Action） */export async function clearMessages(userId: number): Promise<number> {
  const res = await prisma.message.deleteMany({ where: { toUser: BigInt(userId) } });
  return res.count;
}

/** 全部标记已读（2026-09-24 张老师要求：消息页右上角「全部已读」按钮） */
export async function markAllRead(userId: number): Promise<number> {
  const res = await prisma.message.updateMany({
    where: { toUser: BigInt(userId), isRead: false },
    data: { isRead: true, updateTime: nowSec() },
  });
  return res.count;
}

/** 管理员全站广播（移植 Broad_Action：全员逐个写入；分批 insert 避免超长事务） */
export async function broadcast(fromUserId: number, content: string): Promise<number> {
  const now = nowSec();
  const BATCH = 500;
  let sent = 0;
  for (;;) {
    const users = await prisma.userAuth.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      skip: sent,
      take: BATCH,
    });
    if (!users.length) break;
    await prisma.message.createMany({
      data: users.map((u) => ({
        fromUser: BigInt(fromUserId),
        toUser: u.id,
        content,
        isRead: false,
        isSystem: true,
        createTime: now,
        updateTime: now,
      })),
    });
    sent += users.length;
    if (users.length < BATCH) break;
  }
  return sent;
}
