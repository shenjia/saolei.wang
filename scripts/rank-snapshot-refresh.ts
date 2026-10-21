// 每日排行名次快照刷新（2026-10-22 进步榜重构，替代页面惰性生成为主通道）
// 语义：窗口函数算今日总计时间名次 → 每人 ranks JSON 滚动写入（保留 31 天）→ 预计算 delta 落库。
// 与页面惰性兜底共用 src/lib/ranksnap.ts 的 refreshRankSnapshots()（幂等：当日已刷新则跳过）。
//
// 用法（crontab 每天 00:05，见文件尾注释）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/rank-snapshot-refresh.ts [--force]
// --force：强制重算（当日数据异常时人工干预用，等价后台「立即重算今日快照」）。
//
// 运行环境：项目根目录（.env 由 src/lib/db 读入；生产在 /home/deploy/saolei.wang）。

import { refreshRankSnapshots } from "../src/lib/ranksnap";
import { prisma } from "../src/lib/db";

async function main() {
  const force = process.argv.includes("--force");
  const t0 = Date.now();
  console.log(`[rank-snapshot-refresh] start force=${force}`);
  await refreshRankSnapshots(force);
  const [{ c: rows }] = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) c FROM rank_snapshot`
  );
  const [{ up }] = await prisma.$queryRawUnsafe<{ up: number }[]>(
    `SELECT COALESCE(SUM(delta > 0), 0) up FROM rank_snapshot`
  );
  console.log(
    `[rank-snapshot-refresh] done in ${((Date.now() - t0) / 1000).toFixed(1)}s, rows=${rows}, delta>0=${up}`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[rank-snapshot-refresh] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

// ── crontab 配置（生产 deploy@60.205.137.210，2026-10-22 上线时配置）──────────
// 每天 00:05 刷新（惰性兜底仍在：cron 失败当天首个进步榜访问会补跑）：
//   5 0 * * * cd /home/deploy/saolei.wang && /usr/bin/env -u NODE_OPTIONS node \
//     --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/rank-snapshot-refresh.ts \
//     >> /home/deploy/logs/rank-snapshot.log 2>&1
// 注意：生产 node 需 ≥ 22.6（--experimental-transform-types）；日志目录需先建。
