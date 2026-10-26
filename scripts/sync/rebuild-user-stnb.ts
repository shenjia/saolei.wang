// STNB 榜落盘表全量重建（幂等，对账/回填用）——2026-10-20 落盘改版配套
// 用法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/sync/rebuild-user-stnb.ts
import { rebuildUserStnbBest, rebuildUserStnbBestNf } from "../../src/lib/userstnb";
import { prisma } from "../../src/lib/db";

const t0 = Date.now();
const { rows } = await rebuildUserStnbBest();
const { rows: nfRows } = await rebuildUserStnbBestNf();
console.log(`user_stnb_best 重建完成：${rows} 行；user_stnb_best_nf 重建完成：${nfRows} 行，耗时 ${Date.now() - t0}ms`);
await prisma.$disconnect();
