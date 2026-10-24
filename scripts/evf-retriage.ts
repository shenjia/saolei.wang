// evf 存量录像补跑 ms-toollib is_valid 校验位（bit12 不通过 / bit13 可疑）（2026-10-24）
//
// 跑法（项目根）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/evf-retriage.ts [--id=123 | --all]
//
// 无参数：只列出 evf 存量清单，不写库
// --id=N：补判单盘；--all：重新分拣全部 evf 录像（只重写 auto_flag/auto_reason，不碰 status）
// 上传链路的新 evf 由 after() 钩子自动覆盖，本脚本只管存量与补判。

import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";

const args = process.argv.slice(2);
const idArg = args.find((a) => a.startsWith("--id="));
const all = args.includes("--all");

const evfs = await prisma.videoInfo.findMany({
  where: { filepath: { endsWith: ".evf" } },
  select: { id: true, filepath: true },
  orderBy: { id: "asc" },
});
console.log(`evf 存量：${evfs.length} 盘`);
if (!idArg && !all) {
  for (const e of evfs) console.log(`  ${e.id} ${e.filepath}`);
  await prisma.$disconnect();
  process.exit(0);
}

const targets = idArg ? evfs.filter((e) => String(e.id) === idArg.slice(5)) : evfs;
if (idArg && targets.length === 0) {
  console.error(`未找到 id=${idArg.slice(5)} 的 evf 录像`);
  await prisma.$disconnect();
  process.exit(1);
}

let i = 0;
for (const e of targets) {
  await triageVideo(Number(e.id));
  i++;
  if (i % 200 === 0) console.log(`  已处理 ${i}/${targets.length}`);
}
console.log(`完成：${i} 盘已重新分拣`);
await prisma.$disconnect();
