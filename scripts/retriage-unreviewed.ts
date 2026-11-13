// 未审核录像全量重分拣：对 status=10 且 auto_flag∈{0,2} 的录像逐盘跑 triageVideo
// （完整触发器组重算并覆盖 auto_flag/auto_reason；永不触碰 status）。
// 2026-11-13 按压口径改左键判（右键插旗误伤 184425 案）后跑本脚本重分拣。
// 跑法（生产）: env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/retriage-unreviewed.ts
import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";

async function main() {
  const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
    `SELECT id FROM video WHERE status=10 AND auto_flag IN (0,2) ORDER BY id DESC`
  );
  console.log(`待重分拣 ${rows.length} 盘（status=10 且需核定/分拣失败）`);
  let done = 0;
  const t0 = Date.now();
  for (const r of rows) {
    await triageVideo(Number(r.id));
    done++;
    if (done % 50 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`完成 ${done} 盘，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
