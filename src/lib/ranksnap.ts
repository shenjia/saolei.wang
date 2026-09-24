// 进步榜（移植 2008 版 Ranking_Grow + Top10_Grow）
// 2008 版靠「刷新排行」时保存 Old_Rank 得升降；新版实时计算、每日快照 rank_snapshot 替代

import { prisma } from "./db";
import { usersByIds, SCORE_FIELD, VIDEO_FIELD, type RankingRow, type UserBrief } from "./queries";
import { RANKING_BYS, byLevelOrder } from "./config";

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

/** 惰性快照：当天首次调用时把全量排行写入 rank_snapshot（每日一次）；force=true 强制重算 */
export async function ensureTodaySnapshot(force = false): Promise<void> {
  const today = dateStr();
  if (!force) {
    const existing = await prisma.rankSnapshot.findFirst({ where: { date: today }, select: { id: true } });
    if (existing) return;
  }
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

/** 进步榜行（RankingRow 同构 + 升降数据），GrowFeed / API 共享 */
export type GrowRow = RankingRow & GrowUser;

/** 进步榜（2026-09-24 张老师要求改为雷界排行同款表格）：行=RankingRow 同构（8 列成绩+录像），
 *  rank=今日总计时间名次（对齐 2008 版 Player_Rank 语义），delta=昨日-今日名次差（升为正）；
 *  表内排序按 delta 降序（进步幅度大在前）。 */
export async function getGrowRanking(
  page: number,
  pageSize = 20
): Promise<{ rows: GrowRow[]; total: number; pageSize: number }> {
  await ensureTodaySnapshot();
  const today = dateStr();
  const yesterday = dateStr(new Date(Date.now() - 86400_000));

  const rows = await prisma.$queryRawUnsafe<
    { user: bigint; today_rank: number; yesterday_rank: number; delta: number }[]
  >(
    // 注意：MySQL 算术表达式返回 BIGINT，delta 实际是 bigint（下方 N() 归一化，防 JSON 序列化炸）
    `SELECT t.user, t.sum_time_rank today_rank, y.sum_time_rank yesterday_rank,
            (y.sum_time_rank - t.sum_time_rank) delta
     FROM rank_snapshot t
     JOIN rank_snapshot y ON y.user = t.user AND y.date = ?
     WHERE t.date = ?
     ORDER BY delta DESC, t.sum_time_rank ASC
     LIMIT ? OFFSET ?`,
    yesterday,
    today,
    pageSize,
    (page - 1) * pageSize
  ) as { user: bigint; today_rank: number; yesterday_rank: number; delta: number | bigint }[];
  const countRows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) c FROM rank_snapshot t
     JOIN rank_snapshot y ON y.user = t.user AND y.date = ?
     WHERE t.date = ?`,
    yesterday,
    today
  );
  // 8 列成绩与录像：user_scores 主表批量取（与排行表同源）
  const scoreRows = rows.length
    ? await prisma.userScores.findMany({
        where: { id: { in: rows.map((r) => r.user) } },
      })
    : [];
  const scoreMap = new Map(scoreRows.map((s) => [s.id, s]));
  const authors = await usersByIds(rows.map((r) => N(r.user)));
  return {
    rows: rows.map((r) => {
      const brief: UserBrief = authors.get(N(r.user)) ?? {
        id: N(r.user),
        chineseName: "?",
        englishName: "",
        sex: 1,
      };
      const rec = (scoreMap.get(r.user) ?? {}) as unknown as Record<string, bigint | number | null>;
      const scores: Record<string, number> = {};
      const videos: Record<string, number> = {};
      for (const b of RANKING_BYS) {
        const lo = byLevelOrder(b);
        scores[b] = N(rec[SCORE_FIELD(lo.level, lo.order)] as number);
        videos[b] = lo.level === "sum" ? 0 : N(rec[VIDEO_FIELD(lo.level, lo.order)] as bigint);
      }
      return {
        ...brief,
        rank: r.today_rank, // 排名列=今日总计时间名次（与主榜同口径）
        scores,
        videos,
        todayRank: r.today_rank,
        yesterdayRank: r.yesterday_rank,
        delta: N(r.delta), // BIGINT 算术结果归一化为 number
      };
    }),
    total: N(countRows[0]?.c),
    pageSize,
  };
}
