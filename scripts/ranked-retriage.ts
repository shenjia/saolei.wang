// 在线排行模式录像分拣重判（随临时口径开关 RANKED_FORCE_MANUAL_REVIEW 配套）
//
// 历史：2026-10-27 张老师指令排名局全部强制转手审（本脚本为存量回填）；
//       2026-10-28 张老师指令关闭强制——排名局走正常分拣，本脚本用于清掉
//       存量已打的 bit16（重跑分拣即覆盖，零命中的回到免核定池）。
//
// 跑法（项目根）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/ranked-retriage.ts [--apply] [--all]
//
// 无参数：只列清单 + 现状分布，不写库；
// --apply：对排名录像重跑分拣（口径同上传链路 lib/video-triage.ts）：
//          开关开=一律 auto_flag=0 + bit16 进需核定池；开关关（现状）=按正常
//          触发器重判，覆盖清掉存量 bit16，零命中的回到免核定池；
// --all  ：连已通过（status=20）的排名录像一起重判（只动 auto_flag/auto_reason，不碰 status）。
//
// 识别口径：software='Saolei.wang'（排名局 evf 的 Program 字段）或 evf_sig 非空。

import { prisma } from "../src/lib/db";
import { triageVideo } from "../src/lib/video-triage";
import { RANKED_FORCE_MANUAL_REVIEW } from "../src/lib/video-triage-limits";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");

const rows = await prisma.$queryRawUnsafe<{ id: bigint; status: number; auto_flag: number; auto_reason: number }[]>(
  `SELECT v.id, v.status, v.auto_flag, v.auto_reason
     FROM video v JOIN video_info i ON i.id = v.id
    WHERE (i.software = 'Saolei.wang' OR i.evf_sig IS NOT NULL)
      ${all ? "" : "AND v.status = 10"}
    ORDER BY v.id ASC`
);

console.log(`排名录像 ${rows.length} 盘（${all ? "待审+已通过" : "仅待审"}）· 开关 RANKED_FORCE_MANUAL_REVIEW=${RANKED_FORCE_MANUAL_REVIEW}`);
if (!apply) {
  for (const r of rows) {
    console.log(`  ${r.id} status=${r.status} auto_flag=${r.auto_flag} auto_reason=${r.auto_reason}`);
  }
  console.log("\n（只列清单，未写库；加 --apply 执行重判）");
  await prisma.$disconnect();
  process.exit(0);
}

let i = 0;
for (const r of rows) {
  await triageVideo(Number(r.id));
  i++;
}
console.log(`完成 ${i} 盘重判`);

const after = await prisma.$queryRawUnsafe<{ auto_flag: number; n: bigint }[]>(
  `SELECT v.auto_flag, COUNT(*) n
     FROM video v JOIN video_info i ON i.id = v.id
    WHERE (i.software = 'Saolei.wang' OR i.evf_sig IS NOT NULL)
      ${all ? "" : "AND v.status = 10"}
    GROUP BY v.auto_flag`
);
for (const d of after) {
  const label = d.auto_flag === 1 ? "免核定" : d.auto_flag === 0 ? "需核定" : d.auto_flag === 2 ? "分拣失败" : "未分拣";
  console.log(`  auto_flag=${d.auto_flag}（${label}）: ${Number(d.n)}`);
}
await prisma.$disconnect();
process.exit(0);
