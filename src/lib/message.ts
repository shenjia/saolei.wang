// 站内信（移植 2008 版 Message/*：收件箱/读信/发信/清空 + 管理员广播）

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export const MESSAGE_CONTENT_LIMIT = 200;
export const MESSAGE_PAGESIZE = 10;

export interface MessageItem {
  id: number;
  content: string;
  isRead: boolean;
  isSystem: boolean;
  createTime: number;
  from: UserBrief | null;
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
  const authors = await usersByIds([...new Set(rows.map((r) => N(r.fromUser)))]);
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
  const authors = await usersByIds([N(row.fromUser)]);
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

/** 清空收件箱（移植 Clear_Action） */
export async function clearMessages(userId: number): Promise<number> {
  const res = await prisma.message.deleteMany({ where: { toUser: BigInt(userId) } });
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
