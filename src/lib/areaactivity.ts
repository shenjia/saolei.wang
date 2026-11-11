// 地区活跃指数（2026-11-02 张老师需求）：area_activity 落盘表的唯一写入方。
//
// 权重口径（2026-11-08 四轮张老师定稿；2026-11-09 五轮：活跃人数权重 100→20）：
//   活跃指数 = 活跃人数 × 20
//            + 近 7 日练习活跃点（practice_daily.act_points 逐盘累计，口径见
//              track/practice 计点函数：初级胜=1 败=0；中级胜=2、败局完成率≥50%=1；
//              高级完成率≥50% 按 floor(率×10)，胜局恒=10；自定义胜=1。
//              ——2026-11-08 改：玩家反馈高级太难开，原「高级完成盘×10」对
//              打不满整盘的贡献为 0，改按 3BV 完成情况计点）
//            + 近 7 日上传录像数按级别加权（初×1 中×2 高×10，不变）
//   自定义盘无固定难度，防小盘刷分按胜局=1。录像侧本就是完成 100% 3BV 的盘，
//   与新口径高级胜局等值，不动。
//   调整只改相应常量/计点函数、重跑刷新脚本即生效；点数逐盘固化落库，
//   调练习口径后 7 日窗口一周自然补齐（与 wins 分级列同先例）。
//
// 三源口径（均限定 u.status=0、有效单地区 area<>'' 且不含 &）：
//   活跃人数 = 近 30 天登录过的人数（与地区榜「活跃人数」列同口径）
//   练习活跃点 = practice_daily 近 7 个自然日 act_points 之和
//             （+08:00 切天；user_id>0，游客聚合行不可归属地区不计；
//             act_points 起记日 2026-11-08，此前历史无此数据按 0 计——7 日窗口一周自然补齐）
//   录像数   = video 近 7 天上传且 status<>0（含待审 10，屏蔽 0 不计），按 v.level 加权
//             （2026-11-10 张老师定方案 A：剔除 video_info.software='Saolei.wang' 的
//              排行局在线录像——排行局终局已照发练习埋点计过练习点，上传再计录像分
//              即同一局双计；剔后在线玩只走练习点、站外软件上传才走录像点，
//              气泡展示用原始条数 videos_total 同口径剔除）
//
// 更新：每小时 crontab 调 scripts/area-activity-refresh.ts 全量重算、事务内整表覆盖
//（34 行小表，自愈：地区数据残留/权重变更下一轮自动对齐）。

import { prisma } from "./db";

/** 录像级别权重（初×1 中×2 高×10，2026-11-06 定，录像侧不动） */
export const LEVEL_WEIGHTS = { beg: 1, int: 2, exp: 10, cus: 1 } as const;
/** 活跃人数权重（2026-11-09 张老师定：100→20，防人数因子压过练习/录像点数） */
export const ACTIVE_WEIGHT = 20;

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
      act_points: bigint;
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
        SELECT u.area area, SUM(p.plays) plays, SUM(p.wins) wins, SUM(p.act_points) ap
        FROM practice_daily p JOIN user u ON u.id = p.user_id
        WHERE p.user_id > 0
          AND p.day >= FLOOR((UNIX_TIMESTAMP() + 28800) / 86400) - 6
          AND u.status = 0 AND u.area <> '' AND u.area NOT LIKE '%&%'
        GROUP BY u.area
      ),
      v7 AS (
        SELECT u.area area, COUNT(*) total,
               SUM(v.level = 'beg') vb, SUM(v.level = 'int') vi, SUM(v.level = 'exp') ve
        FROM video v
        JOIN video_info vin ON vin.id = v.id AND vin.software <> 'Saolei.wang'
        JOIN user u ON u.id = v.user
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
             COALESCE(p.ap, 0) act_points,
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
          Number(r.act_points), // 练习活跃点已逐盘计好落库，直接求和
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
