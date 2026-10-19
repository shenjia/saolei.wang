// 存量录像分拣回填（2026-10-19 方案 v2）
//
// 跑法（项目根，建议后台）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/video-triage-backfill.ts [--only-pending]
//
// 对存量录像补算 auto_flag / auto_reason：
//   默认全量（status=10/20 全部，约 30 万盘 × ~7ms ≈ 35 分钟）；
//   --only-pending 只跑 status=10 待审（上线时清队列用）。
// 幂等：重跑覆盖（triageVideo 直接 update）。
//
// 与上传链路同一实现（lib/video-triage.ts triageVideo），口径永远一致。

import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";

async function main() {
  const onlyPending = process.argv.includes("--only-pending");
  const where = onlyPending ? { status: 10 } : { status: { in: [10, 20] } };

  const ids = await prisma.video.findMany({
    where,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  console.log(`待回填 ${ids.length} 盘（${onlyPending ? "仅待审" : "全部待审+已通过"}）`);

  const t0 = Date.now();
  let done = 0;
  let failed = 0;
  for (const { id } of ids) {
    await triageVideo(Number(id));
    done++;
    if (done % 2000 === 0) {
      console.log(`  ... ${done}/${ids.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  // 统计结果分布
  const dist = await prisma.$queryRawUnsafe<{ auto_flag: number; n: bigint }[]>(
    `SELECT auto_flag, COUNT(*) n FROM video WHERE status IN (10, 20) GROUP BY auto_flag`
  );
  console.log("\n===== 回填结果分布 =====");
  for (const d of dist) {
    const label = d.auto_flag === 1 ? "免核定" : d.auto_flag === 0 ? "需核定" : d.auto_flag === 2 ? "分拣失败" : "未分拣";
    console.log(`  auto_flag=${d.auto_flag}（${label}）: ${Number(d.n)}`);
  }
  console.log(`完成 ${done} 盘，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
