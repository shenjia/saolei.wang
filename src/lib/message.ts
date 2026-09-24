// 站内信（移植 2008 版 Message/*：消息列表/读信/发信/清空 + 管理员广播）
// 2026-09-24 改版（张老师要求）：「收件箱」更名「消息」，作者列带军衔（论坛列表同款）

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";
import { title as assessTitle } from "./assess";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export const MESSAGE_CONTENT_LIMIT = 200;
export const MESSAGE_PAGESIZE = 15;

export interface MessageUserBrief extends UserBrief {
  /** 18 级军衔（按 sum_time 评定，作者列 TitleBadge 用） */
  title: string;
}

export interface MessageItem {
  id: number;
  content: string;
  isRead: boolean;
  isSystem: boolean;
  createTime: number;
  from: MessageUserBrief | null;
}

/** usersByIds 之上补军衔（distribution 阈值在 assess 内缓存；模式同 bbs.ts authorsWithTitles） */
export async function messageAuthorsWithTitles(ids: number[]): Promise<Map<number, MessageUserBrief>> {
  const briefs = await usersByIds(ids);
  const scores = ids.length
    ? await prisma.userScores.findMany({
        where: { id: { in: ids.map(BigInt) } },
        select: { id: true, sumTime: true },
      })
    : [];
  const sumMap = new Map(scores.map((s) => [N(s.id), s.sumTime ?? 0]));
  const out = new Map<number, MessageUserBrief>();
  for (const [id, b] of briefs) {
    out.set(id, { ...b, title: await assessTitle(sumMap.get(id) ?? 0) });
  }
  return out;
}

export async function getUnreadCount(userId: number): Promise<number> {
  return prisma.message.count({ where: { toUser: BigInt(userId), isRead: false } });
}

export async function getMessageCount(userId: number): Promise<number> {
  return prisma.message.count({ where: { toUser: BigInt(userId) } });
}

export async function getMessageList(
  userId: number,
  page: number
): Promise<{ messages: MessageItem[]; total: number; pageSize: number }> {
  const where = { toUser: BigInt(userId) };
  const total = await prisma.message.count({ where });
  const rows = await prisma.message.findMany({
    where,
    orderBy: { id: "desc" },
    skip: (page - 1) * MESSAGE_PAGESIZE,
    take: MESSAGE_PAGESIZE,
  });
  const authors = await messageAuthorsWithTitles([...new Set(rows.map((r) => N(r.fromUser)))]);
  return {
    messages: rows.map((r) => ({
      id: N(r.id),
      content: r.content,
      isRead: r.isRead,
      isSystem: r.isSystem,
      createTime: N(r.createTime),
      from: authors.get(N(r.fromUser)) ?? null,
    })),
    total,
    pageSize: MESSAGE_PAGESIZE,
  };
}

/** 读信并标记已读（仅收件人可读；系统信没有寄件人页） */
export async function readMessage(id: number, userId: number): Promise<MessageItem | null> {
  const row = await prisma.message.findUnique({ where: { id: BigInt(id) } });
  if (!row || N(row.toUser) !== userId) return null;
  if (!row.isRead) {
    await prisma.message.update({ where: { id: row.id }, data: { isRead: true, updateTime: nowSec() } });
  }
  const authors = await messageAuthorsWithTitles([N(row.fromUser)]);
  return {
    id: N(row.id),
    content: row.content,
    isRead: true,
    isSystem: row.isSystem,
    createTime: N(row.createTime),
    from: authors.get(N(row.fromUser)) ?? null,
  };
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
