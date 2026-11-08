// 用户近 7 日活跃快照每分钟刷新（2026-11-08 张老师定）。
// 全量重算 user_activity_snapshot；活跃排行与用户主页只读快照，不回退实时聚合。
//
// 用法（项目根目录）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/user-activity-snapshot-refresh.ts

import { refreshUserActivitySnapshot } from "../src/lib/useractivity";
import { prisma } from "../src/lib/db";

async function main() {
  console.log("[user-activity-snapshot-refresh] start");
  const result = await refreshUserActivitySnapshot();
  if (result.skipped) {
    console.log(`[user-activity-snapshot-refresh] skipped: another refresh holds the lock (${result.ms}ms)`);
    return;
  }
  const top = await prisma.$queryRawUnsafe<{ user_id: bigint; active_points: number }[]>(
    `SELECT user_id, active_points FROM user_activity_snapshot
     ORDER BY active_points DESC, user_id ASC LIMIT 3`,
  );
  console.log(
    `[user-activity-snapshot-refresh] ${result.rows} users in ${result.ms}ms, top: ` +
      top.map((r) => `${r.user_id}=${r.active_points}`).join(", "),
  );
}

main()
  .catch((e) => {
    console.error("[user-activity-snapshot-refresh] FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// ── crontab（生产 deploy@60.205.137.210，上线时配置）────────────────────
// 每分钟刷新；函数内 MySQL 命名锁防止 cron 与手工调用重入：
//   * * * * * cd /home/deploy/saolei.wang && /usr/bin/env -u NODE_OPTIONS node \
//     --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/user-activity-snapshot-refresh.ts \
//     >> /home/deploy/logs/user-activity-snapshot.log 2>&1
// 日志目录 /home/deploy/logs 已有（area-activity / rank-snapshot 在用）。
// 运维检查：日志持续 FAILED 或快照 update_time 超过 3 分钟未更新需要告警；
// 刷新失败不会清空旧快照，也不应让页面回退到四源实时聚合。
