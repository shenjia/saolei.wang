// 进步榜（移植 2008 版 Ranking_Grow + Top10_Grow）
// 2008 版靠「刷新排行」时保存 Old_Rank 得升降；新版实时计算、每日快照 rank_snapshot 替代

import { prisma } from "./db";
import { usersByIds, type UserBrief } from "./queries";

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

function dateStr(d = new Date()): string {
  const p = (n: number) => (n < 10 ? "0" + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 排行升降（移植 2008 版 Ranking_All 的 Old_Rank 对比，新版用每日快照）：
 * 返回 Map<userId, delta>——delta 为正=进步名次数，负=下降，0=持平，null=今日新上榜（昨日无快照）。
 * 昨日快照整体缺失（新站首日）时全部按 0 持平处理。调用前需先 ensureTodaySnapshot()。
 */
export async function getSumTimeDeltas(ids: number[]): Promise<Map<number, number | null>> {
  const map = new Map<number, number | null>();
  if (!ids.length) return map;
  const today = dateStr();
  const yesterday = dateStr(new Date(Date.now() - 86400_000));
  const yesterdayCount = await prisma.rankSnapshot.count({ where: { date: yesterday } });
  if (!yesterdayCount) {
    for (const id of ids) map.set(id, 0);
    return map;
  }
  const rows = await prisma.rankSnapshot.findMany({
    where: { user: { in: ids.map(BigInt) }, date: { in: [today, yesterday] } },
    select: { user: true, date: true, sumTimeRank: true },
  });
  const tMap = new Map<number, number>();
  const yMap = new Map<number, number>();
  for (const r of rows) {
    if (r.date === today) tMap.set(N(r.user), r.sumTimeRank);
    else yMap.set(N(r.user), r.sumTimeRank);
  }
  for (const id of ids) {
    const t = tMap.get(id);
    const y = yMap.get(id);
    map.set(id, t && y ? y - t : null);
  }
  return map;
}

/** 惰性快照：当天首次调用时把全量排行写入 rank_snapshot（每日一次） */
export async function ensureTodaySnapshot(): Promise<void> {
  const today = dateStr();
  const existing = await prisma.rankSnapshot.findFirst({ where: { date: today }, select: { id: true } });
  if (existing) return;
  // MySQL 8+ 窗口函数一次算两个榜（sum_time 升序、sum_3bvs 降序），upsert 防并发重复
  await prisma.$executeRawUnsafe(
    `INSERT INTO rank_snapshot (user, date, sum_time_rank, sum_3bvs_rank, create_time, update_time)
     SELECT s.id, ?, tr.r, COALESCE(br.r, 0), UNIX_TIMESTAMP(), UNIX_TIMESTAMP()
     FROM user_scores s
     JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY sum_time ASC) r FROM user_scores WHERE sum_time > 0) tr ON tr.id = s.id
     LEFT JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY sum_3bvs DESC) r FROM user_scores WHERE sum_3bvs > 0) br ON br.id = s.id
     WHERE s.sum_time > 0
     ON DUPLICATE KEY UPDATE sum_time_rank = VALUES(sum_time_rank), sum_3bvs_rank = VALUES(sum_3bvs_rank)`,
    today
  );
}

export interface GrowUser extends UserBrief {
  rank: number;
  todayRank: number;
  yesterdayRank: number;
  delta: number;
}

/** 进步榜：今日快照 vs 昨日快照的 sum_time 名次差（移植 Ranking_Grow） */
export async function getGrowRanking(
  page: number,
  pageSize = 20
): Promise<{ users: GrowUser[]; total: number; pageSize: number }> {
  await ensureTodaySnapshot();
  const today = dateStr();
  const yesterday = dateStr(new Date(Date.now() - 86400_000));

  const rows = await prisma.$queryRawUnsafe<
    { user: bigint; today_rank: number; yesterday_rank: number; delta: number }[]
  >(
    `SELECT t.user, t.sum_time_rank today_rank, y.sum_time_rank yesterday_rank,
            (y.sum_time_rank - t.sum_time_rank) delta
     FROM rank_snapshot t
     JOIN rank_snapshot y ON y.user = t.user AND y.date = ?
     WHERE t.date = ?
     ORDER BY delta DESC
     LIMIT ? OFFSET ?`,
    yesterday,
    today,
    pageSize,
    (page - 1) * pageSize
  );
  const countRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) c FROM rank_snapshot t
     JOIN rank_snapshot y ON y.user = t.user AND y.date = ?
     WHERE t.date = ?`,
    yesterday,
    today
  );
  const authors = await usersByIds(rows.map((r) => N(r.user)));
  return {
    users: rows.map((r, i) => ({
      ...(authors.get(N(r.user)) ?? { id: N(r.user), chineseName: "?", englishName: "", sex: 1 }),
      rank: (page - 1) * pageSize + i + 1,
      todayRank: r.today_rank,
      yesterdayRank: r.yesterday_rank,
      delta: r.delta,
    })),
    total: N(countRows[0]?.c),
    pageSize,
  };
}
