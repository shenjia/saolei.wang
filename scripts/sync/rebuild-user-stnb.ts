// STNB 榜落盘表全量重建（幂等，对账/回填用）——2026-10-20 落盘改版配套
// 用法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/sync/rebuild-user-stnb.ts
// ⚠️ 生产避峰守卫（2026-10-27）：生产库 + 高峰时段（本地 14-17 点）拒绝执行，
//   2026-10-26 15:15 曾有会话高峰期直跑致 DELETE+INSERT 万行级写与前台抢资源；
//   低峰期运行，或加 --off-peak-ok 显式放行。本地库不受限。
import { rebuildUserStnbBest, rebuildUserStnbBestNf } from "../../src/lib/userstnb";
import { prisma } from "../../src/lib/db";

const url = process.env.DATABASE_URL ?? "";
const isProd = !/localhost|127\.0\.0\.1/.test(url);
const hour = new Date().getHours();
if (isProd && hour >= 14 && hour < 17 && !process.argv.includes("--off-peak-ok")) {
  console.error(
    `[避峰守卫] 当前 ${hour} 点处于生产高峰期（14-17 点），拒绝执行 STNB 全量重建。` +
      `请在低峰期运行，或确认无碍后加 --off-peak-ok 放行。`
  );
  process.exit(1);
}

const t0 = Date.now();
const { rows } = await rebuildUserStnbBest();
const { rows: nfRows } = await rebuildUserStnbBestNf();
console.log(`user_stnb_best 重建完成：${rows} 行；user_stnb_best_nf 重建完成：${nfRows} 行，耗时 ${Date.now() - t0}ms`);
await prisma.$disconnect();
