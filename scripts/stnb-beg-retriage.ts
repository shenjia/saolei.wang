// 生产用：对受「初级 3BV<10 免查 STNB」口径影响的待审录像补跑 triage（2026-10-24）
//
// 背景：STNB 触发器新增豁免——初级 board_3bv<10 的运气盘 STNB 无意义，不再判
//（与 3BV/s 划线口径 MIN_3BV_FOR_3BVS.beg=10 一致）。存量待审池里已因 STNB 落
// 需核定的这类录像需补跑一次 triageVideo，清掉 STNB 位（其他触发器位保留重算）。
//
// 跑法（生产，项目根）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/stnb-beg-retriage.ts
// 幂等：triageVideo 直接覆盖写，重跑无害。

import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";

const STNB_BIT = 1 << 1;

async function main() {
  // 只挑待审、reason 含 STNB 位、初级且 3BV<10 的录像（video_info 有 board_3bv）
  const rows = await prisma.$queryRawUnsafe<{ id: bigint }[]>(
    `SELECT v.id FROM video v
      JOIN video_info vi ON vi.id = v.id
      WHERE v.status = 10 AND v.level = 'beg'
        AND (v.auto_reason & ${STNB_BIT}) <> 0
        AND vi.board_3bv < 10`
  );
  console.log(`命中 ${rows.length} 盘（初级 3BV<10 且 STNB 位命中的待审录像）`);

  let done = 0;
  for (const { id } of rows) {
    await triageVideo(Number(id));
    done++;
    if (done % 200 === 0) console.log(`  ... ${done}/${rows.length}`);
  }

  // 复查：还剩多少盘仍带 STNB 位（理论上应为 0）
  const rest = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*) c FROM video v
      JOIN video_info vi ON vi.id = v.id
      WHERE v.status = 10 AND v.level = 'beg'
        AND (v.auto_reason & ${STNB_BIT}) <> 0
        AND vi.board_3bv < 10`
  );
  console.log(`完成 ${done} 盘，补跑后仍带 STNB 位的存量：${Number(rest[0]?.c ?? 0)}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
