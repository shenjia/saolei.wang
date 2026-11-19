// 人类相似度触发器单盘验证：scripts/traj-verify.ts <file> <ext> <level> [software]
import { readFileSync } from "fs";
import { parseVideoBinary } from "../src/lib/videoradar";
import { triageParsed, humanLikeStats } from "../src/lib/video-triage";

const [file, ext, level, software] = process.argv.slice(2);
const v = parseVideoBinary(new Uint8Array(readFileSync(file)), ext);
if (!v) { console.error("parse fail"); process.exit(1); }
const hl = humanLikeStats(v);
console.log("humanLikeStats:", JSON.stringify(hl, null, 1));
const r = triageParsed(v, level, null, false, {}, v.timeMs, false, false, software ?? null);
console.log(`triageParsed(${level}, software=${software ?? "?"}):`, r);
// bit17~22 命中明细
const names = ["PATH_SPARSE", "PATH_DT", "PRESS_UNIFORM", "CLICK_OFFSET", "ZERO_PRESS", "GAP_MODE"];
names.forEach((n, i) => {
  if (r.reason & (1 << (17 + i))) console.log(`  命中 bit${17 + i} ${n}`);
});
