// 用户近 7 日活跃快照（2026-11-08）：唯一刷新入口。
//
// 事实源与计分口径：
//   练习 = practice_daily 近 7 个 +08:00 自然日；
//   录像/评论/回复 = 滚动 7×86400 秒；全部来源只计 user.status=0。
//   初/中/高列 = 录像上传数 + 练习完成盘数；活跃总分 = 练习点 + 录像加权 + 评论数。
//
// 2026-11-09 张老师反馈：活跃榜翻到最后出现整行全空（活跃指数等八列全 0）的人——
// 成因＝近 7 日玩过练习但全是低完成率败局（逐盘计点全 0），评论/录像也无，
// 四源聚合得分 0 仍进快照。修复：HAVING 过滤零活跃用户不入快照（榜单与 total 同步收敛）。
//
// 2026-11-10 张老师定：新增第五源「登录」——每日访问雷网记 1 点（user_daily_visit
// 打卡表，写入点= getSession 活跃心跳 lib/auth.ts touchLastLogin，每日唯一键去重）。
// login_points = 近 7 个自然日访问天数，计入 active_points 总分；HAVING 同步含登录点
// （只每天来逛一圈、零练习/录像/评论的用户也进活跃榜，正是本需求的初衷）。
//
// 2026-11-10 二批 张老师定：新增第六源「观看」——录像原地回放累计观看时长
// （user_watch_daily，/api/track/watch 上报，登录态才落库），每满 1 分钟记 1 点：
// watch_points = ROUND(近 7 日 watch_ms 合计 / 60000)；HAVING 同步含观看点。
//
// 每分钟全量重算并单事务替换快照。审核、屏蔽、恢复、删除、数据修复均在下一轮
// 自动纠正，避免逐事件增量冲正漂移。读取方由 MVCC 看到完整旧版或新版；
// 刷新失败回滚并保留旧快照，不在页面请求里回退实时聚合。

import { prisma } from "./db";

/** 六源分别按用户聚合后再合并；参数依次为 dayW、tsW、tsW、tsW、dayW、dayW（登录/观看窗口同练习自然日）。 */
function unionSql(): string {
  return `SELECT g.uid uid,
         COALESCE(SUM(g.cb), 0) cb, COALESCE(SUM(g.ci), 0) ci, COALESCE(SUM(g.ce), 0) ce,
         COALESCE(SUM(g.cc), 0) cc, COALESCE(SUM(g.pts), 0) pts, COALESCE(SUM(g.vs), 0) vs,
         COALESCE(SUM(g.lp), 0) lp, COALESCE(SUM(g.wp), 0) wp
       FROM (
         SELECT p.user_id uid, SUM(p.wins_beg) cb, SUM(p.wins_int) ci, SUM(p.wins_exp) ce,
                0 cc, SUM(p.act_points) pts, 0 vs, 0 lp, 0 wp
         FROM practice_daily p JOIN user u ON u.id = p.user_id AND u.status = 0
         WHERE p.user_id > 0 AND p.day >= ?
         GROUP BY p.user_id
         UNION ALL
         SELECT v.user uid, SUM(v.level = 'beg') cb, SUM(v.level = 'int') ci, SUM(v.level = 'exp') ce,
                0 cc, 0 pts, SUM(v.level = 'beg') + 2 * SUM(v.level = 'int') + 10 * SUM(v.level = 'exp') vs, 0 lp, 0 wp
         FROM video v JOIN user u ON u.id = v.user AND u.status = 0
         WHERE v.status <> 0 AND v.create_time >= ?
         GROUP BY v.user
         UNION ALL
         SELECT c.user uid, 0 cb, 0 ci, 0 ce, COUNT(*) cc, 0 pts, 0 vs, 0 lp, 0 wp
         FROM comment c JOIN user u ON u.id = c.user AND u.status = 0
         WHERE c.status = 0 AND c.create_time >= ?
         GROUP BY c.user
         UNION ALL
         SELECT r.user uid, 0 cb, 0 ci, 0 ce, COUNT(*) cc, 0 pts, 0 vs, 0 lp, 0 wp
         FROM bbs_reply r JOIN user u ON u.id = r.user AND u.status = 0
         WHERE r.status = 0 AND r.create_time >= ?
         GROUP BY r.user
         UNION ALL
         SELECT w.user_id uid, 0 cb, 0 ci, 0 ce, 0 cc, 0 pts, 0 vs, COUNT(*) lp, 0 wp
         FROM user_daily_visit w FORCE INDEX (user_daily_visit_day_user_id_idx)
         JOIN user u ON u.id = w.user_id AND u.status = 0
         WHERE w.day >= ?
         GROUP BY w.user_id
         UNION ALL
         SELECT t.user_id uid, 0 cb, 0 ci, 0 ce, 0 cc, 0 pts, 0 vs, 0 lp,
                ROUND(SUM(t.watch_ms) / 60000) wp
         FROM user_watch_daily t FORCE INDEX (user_watch_daily_day_user_id_watch_ms_idx)
         JOIN user u ON u.id = t.user_id AND u.status = 0
         WHERE t.day >= ?
         GROUP BY t.user_id
       ) g
       GROUP BY g.uid
       HAVING SUM(g.pts) + SUM(g.vs) + SUM(g.cc) + SUM(g.lp) + SUM(g.wp) > 0`;
}

export interface ActivityRefreshResult {
  /** 另一刷新进程持锁时跳过，不排队叠加数据库压力 */
  skipped: boolean;
  rows: number;
  ms: number;
}

/** 全量重建近 7 日活跃快照；可在 cron 或手工对账时调用。 */
export async function refreshUserActivitySnapshot(): Promise<ActivityRefreshResult> {
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  const dayW = Math.floor((nowSec + 28800) / 86400) - 6;
  const tsW = nowSec - 7 * 86400;

  const result = await prisma.$transaction(
    async (tx) => {
      const lockRows = await tx.$queryRawUnsafe<{ got: number | bigint }[]>(
        `SELECT GET_LOCK('user_activity_snapshot_refresh', 0) got`,
      );
      const locked = Number(lockRows[0]?.got ?? 0) === 1;
      if (!locked) return { skipped: true, rows: 0 };

      try {
        await tx.$executeRawUnsafe(`DELETE FROM user_activity_snapshot`);
        const rows = await tx.$executeRawUnsafe(
          `INSERT INTO user_activity_snapshot
             (user_id, beg_count, int_count, exp_count, comment_count,
              practice_points, video_points, login_points, watch_points, active_points,
              window_start, window_end, update_time)
           SELECT t.uid, t.cb, t.ci, t.ce, t.cc, t.pts, t.vs, t.lp, t.wp,
                  t.pts + t.vs + t.cc + t.lp + t.wp,
                  0, 0, 0
           FROM (${unionSql()}) t`,
          dayW,
          tsW,
          tsW,
          tsW,
          dayW,
          dayW,
        );
        // 窗口元数据与指标分两条写，避免 INSERT SELECT 派生表内外占位符顺序歧义；
        // 同事务执行，读取方不会看到元数据为 0 的中间态。
        await tx.$executeRawUnsafe(
          `UPDATE user_activity_snapshot
           SET window_start = ?, window_end = ?, update_time = ?`,
          tsW,
          nowSec,
          nowSec,
        );
        return { skipped: false, rows };
      } finally {
        // 命名锁不随事务回滚；必须在同一事务连接内显式释放。
        await tx.$queryRawUnsafe(`SELECT RELEASE_LOCK('user_activity_snapshot_refresh')`);
      }
    },
    { maxWait: 5000, timeout: 30000 },
  );

  return { ...result, ms: Date.now() - t0 };
}
