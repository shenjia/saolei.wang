// 人气（Click）与每日一星（Star）——移植 2008 ASP 版 Click/Star 表逻辑

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 人气 ----------

/** 看地盘计人气（同一 IP 同一天对同一地盘只计一次，移植 2008 版 Click 表） */
export async function recordClick(userId: number, ip: string): Promise<void> {
  if (!ip) return;
  const now = nowSec();
  try {
    await prisma.click.create({
      data: { user: BigInt(userId), ip, date: todayStr(), createTime: now, updateTime: now },
    });
  } catch {
    // 唯一键冲突 = 该 IP 今天已计过，忽略
  }
}

/** 地盘人气（总数 + 今日） */
export async function getClicks(userId: number): Promise<{ total: number; today: number }> {
  const [total, today] = await Promise.all([
    prisma.click.count({ where: { user: BigInt(userId) } }),
    prisma.click.count({ where: { user: BigInt(userId), date: todayStr() } }),
  ]);
  return { total, today };
}

// ---------- 每日一星 ----------

export interface StarInfo {
  date: string;
  user: UserBrief | null;
}

/**
 * 保证今日之星已评选（首页专用触发点）：首页卡片已于 2026-09-24 按张老师要求移除，
 * 但评选仍需照常进行——/admin/rank 的每日一星列表与 /page/help/star 说明页都依赖这份数据，
 * 2008 版的评选时机就是「首次访问首页」。故首页保留一次静默调用，不渲染任何内容。
 */
export async function ensureTodayStar(): Promise<void> {
  await getTodayStar();
}

/**
 * 取今日之星，没有则评选（移植 2008 版 Star_Read + 评选规则）：
 * 候选 = 神界（sum_time 前 41） ∪ 近 30 天有破纪录动态的人界雷友；
 * 本月已当选者不再参与；按日期哈希确定性随机取一位。
 */
export async function getTodayStar(): Promise<StarInfo | null> {
  const today = todayStr();
  const existing = await prisma.star.findUnique({ where: { date: today } });
  if (existing) {
    const authors = await usersByIds([N(existing.user)]);
    return { date: today, user: authors.get(N(existing.user)) ?? null };
  }

  const monthPrefix = today.slice(0, 7);
  const picked = await prisma.star.findMany({
    where: { date: { startsWith: monthPrefix } },
    select: { user: true },
  });
  const excluded = new Set(picked.map((p) => N(p.user)));

  // 神界：sum_time 前 41（大元帅/元帅/大将编制）
  const hero = await prisma.userScores.findMany({
    where: { sumTime: { gt: 0 } },
    select: { id: true },
    orderBy: { sumTime: "asc" },
    take: 41,
  });
  // 人界进步者：近 30 天有个人纪录动态（news.type=20 PERSON_RECORD）
  const since = BigInt(Math.floor(Date.now() / 1000) - 30 * 86400);
  const improved = await prisma.news.findMany({
    where: { type: 20, user: { gt: 0 }, createTime: { gte: since } },
    select: { user: true },
    distinct: ["user"],
  });

  const candidates = [
    ...new Set([...hero.map((h) => N(h.id)), ...improved.map((n) => N(n.user))]),
  ].filter((id) => !excluded.has(id));
  if (!candidates.length) return null;

  // 日期哈希确定性随机（同一天多次请求结果一致，避免并发重复插入时再兜底唯一键）
  let hash = 0;
  for (const ch of today) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const winner = candidates[hash % candidates.length];

  const now = nowSec();
  try {
    await prisma.star.create({
      data: { user: BigInt(winner), date: today, createTime: now, updateTime: now },
    });
  } catch {
    // 并发下另一请求已写入，以其为准
  }
  const row = await prisma.star.findUnique({ where: { date: today } });
  if (!row) return null;
  const authors = await usersByIds([N(row.user)]);
  return { date: today, user: authors.get(N(row.user)) ?? null };
}
