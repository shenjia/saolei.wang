// evf 上传链路验证：evfToRawvf → formatRawvf → judgeVideoOutcome 全链路
// 用法：env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/evf-upload-check.ts <file.evf>
import { readFileSync } from "node:fs";
import { evfToRawvf } from "../src/lib/evf";
import { formatRawvf } from "../src/lib/rawvf";
import { judgeVideoOutcome } from "../src/lib/videowin";
import { LEVEL_MIN_3BV } from "../src/lib/config";

const file = process.argv[2];
if (!file) {
  console.error("用法: node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/evf-upload-check.ts <file.evf>");
  process.exit(1);
}

const buf = readFileSync(file);
const lines = evfToRawvf(new Uint8Array(buf));

console.log("== RawVF 头 15 行 ==");
console.log(lines.slice(0, 15).join("\n"));
console.log("...");
console.log("== 事件行前 8 行 + 末 3 行 ==");
const evStart = lines.findIndex((l) => l === "Events:") + 1;
console.log(lines.slice(evStart, evStart + 8).join("\n"));
console.log("...");
console.log(lines.slice(-3).join("\n"));

const parsed = formatRawvf(lines);
console.log("\n== formatRawvf 结构化 ==");
console.log({
  level: parsed.level,
  player: parsed.player,
  program: parsed.program,
  version: parsed.version,
  mode: parsed.mode,
  width: parsed.width,
  height: parsed.height,
  mines: parsed.mines,
  timeMs: parsed.timeMs,
  bbbv: parsed.bbbv,
  noflag: parsed.noflag,
  marks: parsed.marks,
  boardLen: parsed.board.length,
  events: parsed.events.length,
});

console.log("\n== 上传校验链路 ==");
const checks: [string, boolean][] = [];
checks.push(["level ∈ beg/int/exp", parsed.level in LEVEL_MIN_3BV]);
checks.push(["mode === classic", parsed.mode === "classic"]);
const outcome = judgeVideoOutcome(parsed);
checks.push([`judgeVideoOutcome = ${outcome}（需 win）`, outcome === "win"]);
const minBbbv = LEVEL_MIN_3BV[parsed.level as keyof typeof LEVEL_MIN_3BV];
checks.push([`3BV ${parsed.bbbv} ≥ ${minBbbv}`, (parsed.bbbv ?? 0) >= minBbbv]);
// 3bvs 口径核对（文件名 3.281）
const bbbvs = Math.round((parsed.bbbv! * 1e6) / parsed.timeMs);
console.log(`3BV/s = ${bbbvs}（文件名应为 3281 ≈ 3.281）`);

let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) fail++;
}
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
