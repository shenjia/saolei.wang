// 地区活跃指数（2026-11-02 张老师需求）：area_activity 落盘表的唯一写入方。
//
// 权重口径（张老师未定具体权重，取可解释的整数档；调整只改本常量、重跑刷新脚本即生效）：
//   活跃指数 = 活跃人数 × 10 + 近 7 日练习盘数 × 0.2 + 近 7 日上传录像数 × 10
//   —— 1 个活跃用户 ≈ 5 盘练习 ≈ 1 条录像 的量级折算：练习盘数基数大（单人一天可上百盘）
//      压到 0.2 权重防止刷盘淹没人数信号；录像门槛高与「人」同权。
//
// 三源口径（均限定 u.status=0、有效单地区 area<>'' 且不含 &）：
//   活跃人数 = 近 30 天登录过的人数（与地区榜「活跃人数」列同口径）
//   练习盘数 = practice_daily 近 7 个自然日 plays 之和（+08:00 切天；user_id>0，
//              游客聚合行不可归属地区不计）
//   录像数   = video 近 7 天上传且 status<>0（含待审 10，屏蔽 0 不计）
//
// 更新：每小时 crontab 调 scripts/area-activity-refresh.ts 全量重算、事务内整表覆盖
//（34 行小表，自愈：地区数据残留/权重变更下一轮自动对齐）。

import { prisma } from "./db";

export const ACTIVITY_WEIGHTS = { active: 10, plays: 0.2, videos: 10 } as const;

export function activityScore(activeUsers: number, plays7d: number, videos7d: number): number {
  return Math.round(
    activeUsers * ACTIVITY_WEIGHTS.active +
      plays7d * ACTIVITY_WEIGHTS.plays +
      videos7d * ACTIVITY_WEIGHTS.videos,
  );
}

export interface AreaActivityRow {
  area: string;
  activeUsers: number;
  plays7d: number;
  videos7d: number;
  score: number;
}

export async function refreshAreaActivity(): Promise<{ areas: number; ms: number }> {
  const t0 = Date.now();
  // UNION 取三源地区并集（有任一活跃信号的地区都留行），逐源 LEFT JOIN 聚合
  const rows = await prisma.$queryRawUnsafe<
    { area: string; active: bigint; plays7d: bigint; videos7d: bigint }[]
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
        SELECT u.area area, SUM(p.plays) c
        FROM practice_daily p JOIN user u ON u.id = p.user_id
        WHERE p.user_id > 0
          AND p.day >= FLOOR((UNIX_TIMESTAMP() + 28800) / 86400) - 6
          AND u.status = 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
        GROUP BY u.area
      ),
      v7 AS (
        SELECT u.area area, COUNT(*) c
        FROM video v JOIN user u ON u.id = v.user
        WHERE v.status <> 0
          AND v.create_time > UNIX_TIMESTAMP() - 7 * 86400
          AND u.status = 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
        GROUP BY u.area
      ),
      areas AS (SELECT area FROM act UNION SELECT area FROM p7 UNION SELECT area FROM v7)
      SELECT a.area,
             COALESCE(x.c, 0) active,
             COALESCE(p.c, 0) plays7d,
             COALESCE(v.c, 0) videos7d
      FROM areas a
      LEFT JOIN act x ON x.area = a.area
      LEFT JOIN p7 p ON p.area = a.area
      LEFT JOIN v7 v ON v.area = a.area`,
  );

  const data = rows
    .map((r) => {
      const activeUsers = Number(r.active);
      const plays7d = Number(r.plays7d);
      const videos7d = Number(r.videos7d);
      return {
        area: r.area,
        activeUsers,
        plays7d,
        videos7d,
        score: activityScore(activeUsers, plays7d, videos7d),
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
