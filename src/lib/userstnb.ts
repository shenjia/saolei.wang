// STNB 榜落盘表 user_stnb_best 的读写模块（2026-10-20 张老师拍板落盘）
//
// 为什么落盘：实时聚合（video_metrics⋈video⋈video_info 30 万行三表 GROUP BY，
// 生产实测 4~6s）即使挂 1h 缓存，每小时缓存过期的首个访客仍要吃 6s；
// 落盘后榜查询全表 ~2.4 万行 ~0.1s，且新录像过审即时上榜（原来最迟滞后 1h）。
//
// 口径与原实时聚合（fetchStnbCollection，2026-10-20 前形态）完全同源：
//   · 参与条件：v.status=20（过审胜局）+ m.stnb>0 + board_3bv ≥ MIN_3BV_FOR_3BVS（初10/中4/高4）
//   · 组内排序：stnb DESC, id ASC（同分取 id 小者——注册序影像）
//   · 用户须正常（u.status=0，重算时 JOIN 过滤）
//
// ⚠️ 失同步风险与写入点（四处，改录像指标/状态相关逻辑时必查）：
//   ① lib/review.ts reviewVideo —— 审核通过（可能破纪录）/屏蔽（可能撤纪录），
//      调 refreshUserStnb(user, level, tx)（单组重算，索引查询 <50ms）
//   ② scripts/video-metrics.ts 跑批 —— stnb 值全量变的场景（引擎修 bug 重放），
//      结束时调 rebuildUserStnbBest()（全量重建，~5s）
//   ③ 数据修正脚本（改 level/board_3bv/real_time/status）——受影响 (user, level) 组重算
//   ④ 对账命令 rebuildUserStnbBest() —— 幂等，随时可跑
// 消费端（fetchStnbCollection）保留了「表空则回退实时聚合」的自愈路径，
// 首次部署空表窗口期页面不空。

import { prisma } from "./db";
import { VIDEO_STATUS, MIN_3BV_FOR_3BVS, VIDEO_LEVELS, type VideoLevel } from "./config";

/** Prisma 事务类型（与 review.ts 同款引用方式） */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Db = typeof prisma | Tx;

/** 单组重算：某用户某级的最高 STNB + 最优盘快照，写回 user_stnb_best。
 *  幂等：无合格盘时删除该行（屏蔽最高盘后正确撤纪录）。
 *  幂等 SQL：一条 INSERT ... SELECT ... ON DUPLICATE KEY UPDATE，行不存在自动插、
 *  存在则覆盖——避免「先查后写」在事务内的竞态。 */
export async function refreshUserStnb(user: number, level: string, db: Db = prisma): Promise<void> {
  const uid = BigInt(user);
  const lim =
    level === "beg" ? MIN_3BV_FOR_3BVS.beg : level === "int" ? MIN_3BV_FOR_3BVS.int : MIN_3BV_FOR_3BVS.exp;
  await db.$executeRaw`
    DELETE FROM user_stnb_best WHERE user = ${uid} AND level = ${level}
  `;
  await db.$executeRaw`
    INSERT INTO user_stnb_best (user, level, stnb, best_video, best_time, best_nf, best_ct, update_time)
    SELECT ${uid}, ${level}, t.stnb, t.vid, t.rt, t.nf, t.ct, UNIX_TIMESTAMP()
    FROM (
      SELECT m.stnb, m.id AS vid, vi.real_time AS rt, vi.noflag AS nf, v.create_time AS ct
      FROM video_metrics m
        JOIN video v ON v.id = m.id
        JOIN video_info vi ON vi.id = m.id
      WHERE v.user = ${uid} AND v.level = ${level}
        AND v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0
        AND vi.board_3bv >= ${lim}
      ORDER BY m.stnb DESC, m.id ASC
      LIMIT 1
    ) t
  `;
}

/** 全量重建（幂等）：跑批/对账用。重建窗口内有读请求会看到部分新部分旧
 *  （无事务包裹的万行级写不现实）——对账请选低峰期，或接受窗口内毫秒级不一致。 */
export async function rebuildUserStnbBest(db: Db = prisma): Promise<{ rows: number }> {
  const lim = (lv: string) =>
    lv === "beg" ? MIN_3BV_FOR_3BVS.beg : lv === "int" ? MIN_3BV_FOR_3BVS.int : MIN_3BV_FOR_3BVS.exp;
  // 每级一条 INSERT…SELECT（CASE 限界直接内联，与 fetchStnbCollection 同款）
  await db.$executeRaw`
    DELETE FROM user_stnb_best
    WHERE (user, level) NOT IN (
      SELECT v.user, v.level FROM video v
        JOIN video_metrics m ON m.id = v.id
        JOIN video_info vi ON vi.id = v.id
      WHERE v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0
        AND vi.board_3bv >= CASE v.level
          WHEN 'beg' THEN ${MIN_3BV_FOR_3BVS.beg}
          WHEN 'int' THEN ${MIN_3BV_FOR_3BVS.int}
          ELSE ${MIN_3BV_FOR_3BVS.exp} END
      GROUP BY v.user, v.level
    )
  `;
  for (const lv of VIDEO_LEVELS) {
    // MySQL 不允许 INSERT ... SELECT 里子查询引用目标表——但这里子查询只读
    // video 系表，安全。ON DUPLICATE KEY UPDATE 覆盖已有行（幂等重跑）。
    await db.$executeRaw`
      INSERT INTO user_stnb_best (user, level, stnb, best_video, best_time, best_nf, best_ct, update_time)
      SELECT t.user, t.level, t.stnb, t.vid, t.rt, t.nf, t.ct, UNIX_TIMESTAMP()
      FROM (
        SELECT v.user, v.level, m.stnb, m.id AS vid, vi.real_time AS rt, vi.noflag AS nf, v.create_time AS ct,
               ROW_NUMBER() OVER (PARTITION BY v.user, v.level ORDER BY m.stnb DESC, m.id ASC) AS rn
        FROM video_metrics m
          JOIN video v ON v.id = m.id
          JOIN video_info vi ON vi.id = m.id
        WHERE v.level = ${lv}
          AND v.status = ${VIDEO_STATUS.REVIEWED} AND m.stnb > 0
          AND vi.board_3bv >= ${lim(lv)}
      ) t
      JOIN user u ON u.id = t.user AND u.status = 0
      WHERE t.rn = 1
      ON DUPLICATE KEY UPDATE
        stnb = VALUES(stnb), best_video = VALUES(best_video), best_time = VALUES(best_time),
        best_nf = VALUES(best_nf), best_ct = VALUES(best_ct), update_time = VALUES(update_time)
    `;
  }
  const cnt = await db.userStnbBest.count();
  return { rows: cnt };
}

/** 榜数据读取：全表（~2.4 万行）直接读。供 fetchStnbCollection 消费。 */
export async function getUserStnbBestRows(): Promise<
  { user: bigint; level: string; stnb: number; bestVideo: bigint; bestTime: number; bestNf: boolean; bestCt: bigint }[]
> {
  return prisma.userStnbBest.findMany();
}
