// 地区活跃指数（2026-11-02 张老师需求）：area_activity 落盘表的唯一写入方。
//
// 权重口径（2026-11-06 三轮张老师定稿）：
//   活跃指数 = 活跃人数 × 100
//            + 近 7 日练习完成盘数按级别加权（初级×1 中级×2 高级×10，自定义×1）
//            + 近 7 日上传录像数按级别加权（同比例）
//   2026-11-02 初版练习按尝试盘数、录像不分级；本轮改按完成口径——尝试可以刷，
//   完成需要付出努力；难度越高级别权重越高。自定义盘无固定难度，防小盘刷分按×1。
//   调整只改下方常量、重跑刷新脚本即生效。
//
// 三源口径（均限定 u.status=0、有效单地区 area<>'' 且不含 &）：
//   活跃人数 = 近 30 天登录过的人数（与地区榜「活跃人数」列同口径）
//   练习完成 = practice_daily 近 7 个自然日 wins 及分级别 wins_beg/int/exp/cus 之和
//             （+08:00 切天；user_id>0，游客聚合行不可归属地区不计；
//             分级别列起记日 2026-11-06，此前历史无分级数据按 0 计——7 日窗口一周自然补齐）
//   录像数   = video 近 7 天上传且 status<>0（含待审 10，屏蔽 0 不计），按 v.level 加权
//
// 更新：每小时 crontab 调 scripts/area-activity-refresh.ts 全量重算、事务内整表覆盖
//（34 行小表，自愈：地区数据残留/权重变更下一轮自动对齐）。

import { prisma } from "./db";

/** 级别权重（2026-11-06 张老师定：初级×1 中级×2 高级×10；练习与录像共用同比例） */
export const LEVEL_WEIGHTS = { beg: 1, int: 2, exp: 10, cus: 1 } as const;
/** 活跃人数权重 */
export const ACTIVE_WEIGHT = 100;

/** 练习完成盘数分级别加权计分 */
export function practiceWeighted(
  winsBeg: number,
  winsInt: number,
  winsExp: number,
  winsCus: number,
): number {
  return winsBeg * LEVEL_WEIGHTS.beg + winsInt * LEVEL_WEIGHTS.int + winsExp * LEVEL_WEIGHTS.exp + winsCus * LEVEL_WEIGHTS.cus;
}

/** 录像条数分级别加权计分（未知级别按初级×1 兜底，不炸分数） */
export function videosWeighted(videosBeg: number, videosInt: number, videosExp: number): number {
  return videosBeg * LEVEL_WEIGHTS.beg + videosInt * LEVEL_WEIGHTS.int + videosExp * LEVEL_WEIGHTS.exp;
}

export function activityScore(
  activeUsers: number,
  practiceWeightedScore: number,
  videosWeightedScore: number,
): number {
  return Math.round(activeUsers * ACTIVE_WEIGHT + practiceWeightedScore + videosWeightedScore);
}

export interface AreaActivityRow {
  area: string;
  activeUsers: number;
  plays7d: number;
  wins7d: number;
  videos7d: number;
  score: number;
}

export async function refreshAreaActivity(): Promise<{ areas: number; ms: number }> {
  const t0 = Date.now();
  // UNION 取三源地区并集（有任一活跃信号的地区都留行），逐源 LEFT JOIN 聚合
  const rows = await prisma.$queryRawUnsafe<
    {
      area: string;
      active: bigint;
      plays7d: bigint;
      wins7d: bigint;
      wins_beg: bigint;
      wins_int: bigint;
      wins_exp: bigint;
      wins_cus: bigint;
      videos_beg: bigint;
      videos_int: bigint;
      videos_exp: bigint;
      videos_total: bigint;
    }[]
  >(
    `WITH act AS (
        SELECT u.area area, COUNT(*) c
        FROM user u
        WHERE u.status = 0
          AND u.last_login_time > UNIX_TIMESTAMP() - 30 * 86400
          AND u.area <> '' AND u.area NOT LIKE '%&%'
        GROUP BY u.area
      ),
      p7 AS (
        SELECT u.area area, SUM(p.plays) plays, SUM(p.wins) wins,
               SUM(p.wins_beg) wb, SUM(p.wins_int) wi, SUM(p.wins_exp) we, SUM(p.wins_cus) wc
        FROM practice_daily p JOIN user u ON u.id = p.user_id
        WHERE p.user_id > 0
          AND p.day >= FLOOR((UNIX_TIMESTAMP() + 28800) / 86400) - 6
          AND u.status = 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
        GROUP BY u.area
      ),
      v7 AS (
        SELECT u.area area, COUNT(*) total,
               SUM(v.level = 'beg') vb, SUM(v.level = 'int') vi, SUM(v.level = 'exp') ve
        FROM video v JOIN user u ON u.id = v.user
        WHERE v.status <> 0
          AND v.create_time > UNIX_TIMESTAMP() - 7 * 86400
          AND u.status = 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
        GROUP BY u.area
      ),
      areas AS (SELECT area FROM act UNION SELECT area FROM p7 UNION SELECT area FROM v7)
      SELECT a.area,
             COALESCE(x.c, 0) active,
             COALESCE(p.plays, 0) plays7d,
             COALESCE(p.wins, 0) wins7d,
             COALESCE(p.wb, 0) wins_beg, COALESCE(p.wi, 0) wins_int,
             COALESCE(p.we, 0) wins_exp, COALESCE(p.wc, 0) wins_cus,
             COALESCE(v.vb, 0) videos_beg, COALESCE(v.vi, 0) videos_int,
             COALESCE(v.ve, 0) videos_exp, COALESCE(v.total, 0) videos_total
      FROM areas a
      LEFT JOIN act x ON x.area = a.area
      LEFT JOIN p7 p ON p.area = a.area
      LEFT JOIN v7 v ON v.area = a.area`,
  );

  const data = rows
    .map((r) => {
      const activeUsers = Number(r.active);
      const plays7d = Number(r.plays7d);
      const wins7d = Number(r.wins7d);
      const videos7d = Number(r.videos_total); // 原始条数（气泡展示用）；计分走分级别加权
      return {
        area: r.area,
        activeUsers,
        plays7d,
        wins7d,
        videos7d,
        score: activityScore(
          activeUsers,
          practiceWeighted(
            Number(r.wins_beg),
            Number(r.wins_int),
            Number(r.wins_exp),
            Number(r.wins_cus),
          ),
          videosWeighted(
            Number(r.videos_beg),
            Number(r.videos_int),
            Number(r.videos_exp),
          ),
        ),
      };
    })
    .sort((a, b) => b.score - a.score);

  const now = Math.floor(Date.now() / 1000);
  await prisma.$transaction([
    prisma.areaActivity.deleteMany(),
    prisma.areaActivity.createMany({ data: data.map((d) => ({ ...d, updateTime: now })) }),
  ]);

  return { areas: data.length, ms: Date.now() - t0 };
}
