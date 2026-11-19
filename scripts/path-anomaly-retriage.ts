// 生产用：对 4 盘 path 异常录像补跑 triage（写 auto_flag/auto_reason）
// 跑法（生产）: env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/path-anomaly-retriage.ts [id ...]
// 不带参数默认跑 347022 + 已屏蔽 3 盘。

import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";

async function main() {
  const ids = process.argv.slice(2).map(Number);
  const targets = ids.length ? ids : [347022, 345945, 345953, 345955];
  for (const id of targets) {
    await triageVideo(id);
    const row = await prisma.video.findUnique({ where: { id: BigInt(id) }, select: { autoFlag: true, autoReason: true, status: true } });
    console.log(`id=${id} status=${row?.status} auto_flag=${row?.autoFlag} auto_reason=${row?.autoReason}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
