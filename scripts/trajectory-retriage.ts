// 人类相似度触发器（bit17~22，2026-11-12 红客合成录像 360671 案 + 钮志锋
// 360420/347805「带抖动合成流」案）+ 短局超快按压（bit23，2026-11-13 沈正刚
// 28122 案）存量补判：
// 全站扫描事件流，命中新触发器的录像以「增量 OR 位码」写 auto_reason 并转需核定
// （auto_flag 0）——不重跑整组触发器、不清除既有判定（幂等，可重复跑）。
//
// 跑法（本地 / 生产）:
//   扫描（只报不写）: env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/trajectory-retriage.ts [--where "..."]
//   落库: 同上 + --apply
// 可选 --where "v.create_time>..." 限定范围；--id N[,N] 指定盘。
//
// 注意：本脚本只加位不清位（bit23 只补 SHORT_PRESS 位，bit0 不经此脚本补）。
// 若要按完整新口径重算单盘（覆盖清除旧位），走 triageVideo
// （scripts/path-anomaly-retriage.ts 同款）；bit24 账号聚合走
// account-press-retriage.ts（按用户分组单遍扫描）。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";
import { humanLikeStats, humanLikeTriggers, pressPairStats, pressTriggers } from "../src/lib/video-triage";
import { AUTO_REASON } from "../src/lib/video-triage-limits";
import { RANKED_SOFTWARE } from "../src/lib/evfwrite";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const MASK_BITS: [number, string][] = [
  [AUTO_REASON.PATH_SPARSE, "PATH_SPARSE"],
  [AUTO_REASON.PATH_DT, "PATH_DT"],
  [AUTO_REASON.PRESS_UNIFORM, "PRESS_UNIFORM"],
  [AUTO_REASON.CLICK_OFFSET, "CLICK_OFFSET"],
  [AUTO_REASON.ZERO_PRESS, "ZERO_PRESS"],
  [AUTO_REASON.GAP_MODE, "GAP_MODE"],
  [AUTO_REASON.SHORT_PRESS, "SHORT_PRESS"],
];

interface Row {
  id: bigint;
  level: string;
  status: number;
  auto_flag: number;
  auto_reason: number;
  software: string;
  evf_sig: string | null;
  filepath: string;
  chinese_name: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const whereIdx = process.argv.indexOf("--where");
  const idIdx = process.argv.indexOf("--id");
  let rows: Row[];
  if (idIdx >= 0) {
    const ids = process.argv[idIdx + 1].split(",").map((s) => BigInt(s.trim()));
    rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT v.id, v.level, v.status, v.auto_flag, v.auto_reason, vi.software, vi.evf_sig, vi.filepath, u.chinese_name
       FROM video v JOIN video_info vi ON vi.id=v.id LEFT JOIN user u ON u.id=v.user
       WHERE v.id IN (${ids.map(String).join(",")})`
    );
  } else {
    const where = whereIdx >= 0 ? process.argv[whereIdx + 1] : "1=1";
    rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT v.id, v.level, v.status, v.auto_flag, v.auto_reason, vi.software, vi.evf_sig, vi.filepath, u.chinese_name
       FROM video v JOIN video_info vi ON vi.id=v.id LEFT JOIN user u ON u.id=v.user
       WHERE ${where}
       ORDER BY v.id ASC`
    );
  }
  console.log(`待扫 ${rows.length} 盘${apply ? "（--apply 落库）" : "（只报不写）"}…`);

  let readFail = 0, parseFail = 0, hits = 0, done = 0, applied = 0;
  const t0 = Date.now();
  for (const r of rows) {
    done++;
    if (done % 20000 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 60000).toFixed(1)}min) 命中 ${hits}`);
    let buf: Buffer;
    try {
      const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; continue; }
      buf = readFileSync(full);
    } catch { readFail++; continue; }
    const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(new Uint8Array(buf), ext);
    if (!v) { parseFail++; continue; }

    const clientOwned = r.software === RANKED_SOFTWARE || r.evf_sig !== null;
    const bits = humanLikeTriggers(humanLikeStats(v), r.software, clientOwned)
      // bit23 短局超快按压：只增量补 SHORT_PRESS 位（bit0 常规线不经本脚本补，
      // 历史判定维持原样）
      | (pressTriggers(pressPairStats(v), r.level) & AUTO_REASON.SHORT_PRESS);
    if (bits === 0) continue;
    hits++;
    const names = MASK_BITS.filter(([b]) => bits & b).map(([, n]) => n).join("+");
    console.log(`⚠️ id=${r.id} status=${r.status} ${r.level} ${r.chinese_name ?? "?"} software=${r.software} [${names}]`);

    if (apply) {
      const newReason = r.auto_reason | bits;
      // 增量语义：只加位、命中即转需核定；已需核定的行只补位码
      await prisma.video.update({
        where: { id: r.id },
        data: { autoReason: newReason, ...(r.auto_flag === 1 ? { autoFlag: 0 } : {}) },
      });
      applied++;
    }
  }
  console.log(`\n===== 扫描结果 =====`);
  console.log(`扫描 ${rows.length} 盘（读失败 ${readFail} 解析失败 ${parseFail}），命中 ${hits} 盘${apply ? `，已落库 ${applied}` : "（dry，未写库，加 --apply 落库）"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
