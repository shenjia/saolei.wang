// 扫雷历程（移植 2008 版 Player/History_*.asp：按月记事，同年月唯一）

import { prisma } from "./db";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export interface HistoryItem {
  id: number;
  month: string;
  content: string;
}

export async function getHistory(userId: number): Promise<HistoryItem[]> {
  const rows = await prisma.history.findMany({
    where: { user: BigInt(userId) },
    orderBy: { month: "desc" },
  });
  return rows.map((r) => ({ id: N(r.id), month: r.month, content: r.content }));
}

/** 新增历程（同年月唯一，重复返回 null） */
export async function addHistory(userId: number, month: string, content: string): Promise<number | null> {
  const now = nowSec();
  try {
    const row = await prisma.history.create({
      data: { user: BigInt(userId), month, content, createTime: now, updateTime: now },
    });
    return N(row.id);
  } catch {
    return null;
  }
}

/** 修改历程（仅本人） */
export async function updateHistory(id: number, userId: number, content: string): Promise<boolean> {
  const res = await prisma.history.updateMany({
    where: { id: BigInt(id), user: BigInt(userId) },
    data: { content, updateTime: nowSec() },
  });
  return res.count > 0;
}

/** 删除历程（仅本人） */
export async function deleteHistory(id: number, userId: number): Promise<boolean> {
  const res = await prisma.history.deleteMany({
    where: { id: BigInt(id), user: BigInt(userId) },
  });
  return res.count > 0;
}
