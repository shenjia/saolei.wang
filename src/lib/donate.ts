// 赞助清单查询（2026-10-30 后台赞助管理 + 前台赞助页共用）
// donate 表沿用 2013 版结构：amount 单位为分（BigInt），user=0 表示匿名赞助。
// 人名与军衔取实时值（赞助者基本不会变号；快照制只覆盖动态/评论等 UGC 场景）。

import { prisma } from "@/lib/db";
import { dualTitles } from "@/lib/title-system";

export interface DonateRow {
  id: number;
  /** 赞助者 uid（0=匿名） */
  user: number;
  /** 金额（分） */
  amount: number;
  createTime: number;
  /** 实时人名（匿名=匿名雷友，渲染层处理）；已删号行也给 null */
  chineseName: string | null;
  englishName: string | null;
  sex: number;
  /** 军衔（按实时高级成绩评定；匿名/查无为 null） */
  militaryTitle: string | null;
  /** 旧版称号备选（TitleBadge 按观看者体系渲染） */
  classic: { name: string; color: string } | null;
}

export interface DonateList {
  rows: DonateRow[];
  /** 全量合计（分）——不受 take 截断影响 */
  totalCents: number;
  /** 全量笔数 */
  total: number;
}

/** 赞助清单（时间倒序）。后台与前台赞助页共用。 */
export async function getDonateList(limit = 50): Promise<DonateList> {
  const [records, agg, total] = await Promise.all([
    prisma.donate.findMany({ orderBy: [{ createTime: "desc" }, { id: "desc" }], take: limit }),
    prisma.donate.aggregate({ _sum: { amount: true } }),
    prisma.donate.count(),
  ]);
  const uids = [...new Set(records.filter((r) => r.user > BigInt(0)).map((r) => Number(r.user)))];
  const [users, scoreRows] = await Promise.all([
    uids.length
      ? prisma.user.findMany({
          where: { id: { in: uids.map(BigInt) } },
          select: { id: true, chineseName: true, englishName: true, sex: true, status: true },
        })
      : Promise.resolve([]),
    uids.length
      ? prisma.userScores.findMany({
          where: { id: { in: uids.map(BigInt) } },
          select: { id: true, expTime: true },
        })
      : Promise.resolve([]),
  ]);
  const uMap = new Map(users.map((u) => [Number(u.id), u]));
  const expMap = new Map(scoreRows.map((s) => [Number(s.id), Number(s.expTime ?? 0)]));
  // dualTitles 返回与传入行序严格对齐的数组（2026-10-27 修复后口径）
  const pairs = await dualTitles(
    uids.map((uid) => ({
      userId: uid,
      expTime: expMap.get(uid) ?? 0,
      ranked: uMap.get(uid)?.status === 0,
      sex: uMap.get(uid)?.sex ?? 1,
    }))
  );
  const pairMap = new Map(uids.map((uid, i) => [uid, pairs[i]]));

  const rows: DonateRow[] = records.map((r) => {
    const uid = Number(r.user);
    const u = uid > 0 ? uMap.get(uid) : undefined;
    const pair = uid > 0 ? pairMap.get(uid) : undefined;
    return {
      id: Number(r.id),
      user: uid,
      amount: Number(r.amount),
      createTime: Number(r.createTime),
      chineseName: u?.chineseName ?? null,
      englishName: u?.englishName ?? null,
      sex: u?.sex ?? 1,
      militaryTitle: pair && u ? pair.m : null,
      classic: pair && u ? pair.c : null,
    };
  });
  return { rows, totalCents: Number(agg._sum.amount ?? 0), total };
}

/** 金额格式化：分 → 「¥xx.xx」 */
export function donateYuan(cents: number): string {
  return `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 金额格式化（前台赞助记录用，2026-10-30 三轮张老师定）：不显示小数——
 *  整数金额直接「¥500」；确有小数（如 27.70→¥27.7）去尾零保留。 */
export function donateYuanPlain(cents: number): string {
  const yuan = cents / 100;
  const s = yuan.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return `¥${s}`;
}

// ---------- 支出（2026-10-30 收支管理） ----------

export interface ExpenseRow {
  id: number;
  /** 用途 */
  purpose: string;
  /** 金额（分） */
  amount: number;
  /** 凭据图片 URL（空串=无） */
  evidence: string;
  createTime: number;
}

export interface ExpenseList {
  rows: ExpenseRow[];
  totalCents: number;
  total: number;
}

/** 支出清单（时间倒序）。后台与前台支出记录共用。 */
export async function getExpenseList(limit = 200): Promise<ExpenseList> {
  const [records, agg, total] = await Promise.all([
    prisma.donateExpense.findMany({ orderBy: [{ createTime: "desc" }, { id: "desc" }], take: limit }),
    prisma.donateExpense.aggregate({ _sum: { amount: true } }),
    prisma.donateExpense.count(),
  ]);
  return {
    rows: records.map((r) => ({
      id: Number(r.id),
      purpose: r.purpose,
      amount: Number(r.amount),
      evidence: r.evidence,
      createTime: Number(r.createTime),
    })),
    totalCents: Number(agg._sum.amount ?? 0),
    total,
  };
}
