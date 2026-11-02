// 地区活跃指数每小时刷新（2026-11-02 张老师需求）：全量重算 area_activity 落盘表。
// 口径与权重见 src/lib/areaactivity.ts；页面查询只读该表（LEFT JOIN），与刷新解耦。
//
// 用法（crontab 每小时 17 分，见文件尾注释）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/area-activity-refresh.ts
//
// 运行环境：项目根目录（.env 由 src/lib/db 读入；生产在 /home/deploy/saolei.wang）。

import { refreshAreaActivity } from "../src/lib/areaactivity";
import { prisma } from "../src/lib/db";

async function main() {
  const t0 = Date.now();
  console.log("[area-activity-refresh] start");
  const { areas, ms } = await refreshAreaActivity();
  const top = await prisma.$queryRawUnsafe<{ area: string; score: number }[]>(
    `SELECT area, score FROM area_activity ORDER BY score DESC LIMIT 3`,
  );
  console.log(
    `[area-activity-refresh] ${areas} areas in ${ms}ms, top: ` +
      top.map((r) => `${r.area}=${r.score}`).join(", "),
  );
  console.log(`[area-activity-refresh] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[area-activity-refresh] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

// ── crontab 配置（生产 deploy@60.205.137.210，上线部署时配置）──────────
// 每小时 17 分刷新（避开整点其他任务）：
//   17 * * * * cd /home/deploy/saolei.wang && /usr/bin/env -u NODE_OPTIONS node \
//     --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/area-activity-refresh.ts \
//     >> /home/deploy/logs/area-activity.log 2>&1
// 注意：日志目录 /home/deploy/logs 已有（rank-snapshot 在用）。
