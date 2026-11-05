// EVF v4 漂移窗口录像修复（2026-11-05，一次性）：
// 8863e79（v4 writer，坐标增量漂移 bug）与 1b663e6（修复）部署之间落库的 4 盘
// 排行 evf（353635-353638），文件已于 07:15 批次重生成（内容正确），但
// video_metrics / auto_flag / auto_reason 仍是漂移版重放结果（如 353636 cl=5 触发 bit4）。
// 修复：删 metrics 行 → ensureVideoTriage（重算 metrics + 重跑分拣 + 刷 STNB 落盘表）。
// 幂等：重复执行结果一致。用法：node ... scripts/evf-v4-metrics-repair.ts [id...]
import { prisma } from "../src/lib/db";
import { ensureVideoTriage } from "../src/lib/videometrics";

const DEFAULT_IDS = [353635, 353636, 353637, 353638];
const ids = process.argv.slice(2).map(Number).filter(Boolean);
const targets = ids.length ? ids : DEFAULT_IDS;

for (const id of targets) {
  const before = await prisma.videoMetrics.findUnique({ where: { id: BigInt(id) } });
  console.log(`--- video ${id} 修复前: cl=${before?.cl} stnb=${before?.stnb} path=${before?.path}`);
  await prisma.videoMetrics.deleteMany({ where: { id: BigInt(id) } });
  await ensureVideoTriage(id);
  const [m, v] = await Promise.all([
    prisma.videoMetrics.findUnique({ where: { id: BigInt(id) } }),
    prisma.video.findUnique({ where: { id: BigInt(id) }, select: { autoFlag: true, autoReason: true, status: true } }),
  ]);
  console.log(`    修复后: cl=${m?.cl} clLeft=${m?.clLeft} ce=${m?.ce} path=${m?.path} stnb=${m?.stnb} | status=${v?.status} auto_flag=${v?.autoFlag} auto_reason=${v?.autoReason}`);
}

await prisma.$disconnect();
console.log("done");
