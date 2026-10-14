// 人气（Click）——移植 2008 ASP 版 Click 表逻辑
// 2026-10-13 张老师要求：每日一星（Star）功能整体下线，本文件只保留人气计数。
// star 表与每日一星评选/后台指定入口已同步移除（库表保留作历史数据，不再读写）。
//
// 2026-10-14 口径修正（方案 B，张老师定）：
//   人气总数改以 user_stat.clicks 为准——它是旧站 Player.Player_Click 累计值的同步镜像，
//   含 2017 年 Click 表重建前的早期历史（旧站 Click 明细最早仅到 2017-02-07）。
//   此前误用 click 明细表 count，导致人气普遍显示为 0~个位数（明细里只有新站上线后的记录）。
//   click 明细表继续写入，职责降为「今日人气」统计 + 「同 IP 同日只计一次」的去重闸门。

import { prisma } from "./db";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 人气 ----------

/** 看地盘计人气（同一 IP 同一天对同一地盘只计一次）
 *  明细插入成功才累计总数 +1：同一事务，唯一键冲突则整体回滚（= 今天已计过）。 */
export async function recordClick(userId: number, ip: string): Promise<void> {
  if (!ip) return;
  const now = nowSec();
  const id = BigInt(userId);
  try {
    await prisma.$transaction([
      prisma.click.create({
        data: { user: id, ip, date: todayStr(), createTime: now, updateTime: now },
      }),
      prisma.userStat.upsert({
        where: { id },
        create: { id, clicks: 1 },
        update: { clicks: { increment: 1 } },
      }),
    ]);
  } catch {
    // 唯一键冲突 = 该 IP 今天已计过，忽略
  }
}

/** 地盘人气（总数 + 今日）
 *  总数 = user_stat.clicks（旧站累计镜像，含 2017 前历史）；今日 = click 明细当日条数 */
export async function getClicks(userId: number): Promise<{ total: number; today: number }> {
  const [stat, today] = await Promise.all([
    prisma.userStat.findUnique({ where: { id: BigInt(userId) }, select: { clicks: true } }),
    prisma.click.count({ where: { user: BigInt(userId), date: todayStr() } }),
  ]);
  return { total: stat?.clicks ?? 0, today };
}
