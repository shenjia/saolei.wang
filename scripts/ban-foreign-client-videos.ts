// 屏蔽第三方客户端混入的录像（2026-11-07 张老师定：硬闸白名单 + 存量封禁）
// 「微信小游戏 - 95经典扫雷 0.4」经普通上传口混入（未知软件名在 checkProgramVersion
//  fall-through 放行）——本脚本走 reviewVideo 权威路径屏蔽：级联撤成绩/STNB/名次落盘
//  + 自动发屏蔽系统通知。
// 用法: DATABASE_URL=<prod-tunnel> jiti scripts/ban-foreign-client-videos.ts <ids.txt>
// ids.txt 每行: <videoId>
// 安全阀：先校验每盘 video_info.software 确属第三方客户端白名单外软件名，
// 目标库不对（软件名全为空/全是主流客户端）立即中止，防止隧道指错库误封。
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { reviewVideo } from "../src/lib/review";
import { VIDEO_STATUS } from "../src/lib/config";

const LEGIT_SOFTWARE = new Set([
  "Arbiter",
  "Clone",
  "Vienna",
  "Viennasweeper",
  "元扫雷",
  "Saolei.wang",
]);

const listFile = process.argv[2]!;
const ids = readFileSync(listFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
console.log(`待封 ${ids.length} 盘: ${ids.join(" ")}`);

// ---- 安全阀：逐盘核对 software，白名单内的出现即中止 ----
let foreign = 0;
for (const idStr of ids) {
  const info = await prisma.videoInfo.findUnique({
    where: { id: BigInt(idStr) },
    select: { software: true, version: true },
  });
  if (!info) {
    console.log(`#${idStr} ✗ video_info 行不存在，中止`);
    process.exit(1);
  }
  if (LEGIT_SOFTWARE.has(info.software)) {
    console.log(`#${idStr} ✗ software=${info.software} 属合法客户端，不在本脚本处置范围，中止`);
    process.exit(1);
  }
  console.log(`  #${idStr} software="${info.software}" version="${info.version}" → 确认第三方`);
  foreign++;
}
console.log(`安全阀通过：${foreign}/${ids.length} 盘均为白名单外软件\n`);

let ok = 0, fail = 0;
for (const idStr of ids) {
  const id = Number(idStr);
  try {
    const r = await reviewVideo(1, 100, id, VIDEO_STATUS.BANNED, { skipWatchCheck: true });
    if (r.ok) { ok++; console.log(`#${id} ✓ 已屏蔽（含系统通知）`); }
    else { fail++; console.log(`#${id} ✗ ${r.error}`); }
  } catch (e) {
    fail++;
    console.log(`#${id} ✗ 异常: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\n完成: 成功 ${ok}, 失败 ${fail}`);
await prisma.$disconnect();
process.exit(fail > 0 ? 1 : 0);
