// 人气（Click）——移植 2008 ASP 版 Click 表逻辑
// 2026-10-13 张老师要求：每日一星（Star）功能整体下线，本文件只保留人气计数。
// star 表与每日一星评选/后台指定入口已同步移除（库表保留作历史数据，不再读写）。

import { prisma } from "./db";

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
