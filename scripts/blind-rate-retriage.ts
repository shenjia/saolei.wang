// 盲区率触发器重判（随 2026-10-28 STNB 联合门槛口径）
//
// 历史：2026-10-27 盲区率触发器上线（<2% 即需核定）；2026-10-28 张老师收窄——
//       新手往往不猜雷，慢速稳扎局盲区率低是正常行为，只有 STNB 超同级触发线
//       且盲区率低才需核定（348259 案定标）。本脚本对存量命中 bit14 的录像重跑
//       分拣（triageVideo 内置排名 evf 审计复算，无需上传时的 audit 透传值），
//       新口径下不达标的清位回到免核定池。
//
// 跑法（生产，项目根）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/blind-rate-retriage.ts
// 幂等：triageVideo 直接覆盖写，重跑无害。带 --dry 只列清单不写库。

import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";

const BLIND_BIT = 1 << 14;

const dry = process.argv.slice(2).includes("--dry");

const rows = await prisma.$queryRawUnsafe<{ id: bigint; level: string; status: number; auto_reason: number }[]>(
  `SELECT v.id, v.level, v.status, v.auto_reason
     FROM video v JOIN video_info i ON i.id = v.id
    WHERE (v.auto_reason & ${BLIND_BIT}) <> 0
    ORDER BY v.id ASC`
);
console.log(`命中 bit14（盲区率旧口径）存量：${rows.length} 盘${dry ? "（dry 模式，不写库）" : ""}`);

for (const r of rows) {
  if (!dry) await triageVideo(Number(r.id));
  const after = dry ? null : await prisma.video.findUnique({
    where: { id: r.id },
    select: { autoFlag: true, autoReason: true },
  });
  console.log(
    `  id=${r.id} level=${r.level} status=${r.status} 旧 reason=${r.auto_reason}` +
    (after ? ` → 新 flag=${after.autoFlag} reason=${after.autoReason}` : "")
  );
}

const rest = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
  `SELECT COUNT(*) c FROM video v WHERE (v.auto_reason & ${BLIND_BIT}) <> 0`
);
console.log(`完成后仍带 bit14 的存量：${Number(rest[0]?.c ?? 0)}（新口径命中，需人工复核）`);
await prisma.$disconnect();
process.exit(0);
