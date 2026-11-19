// EVF 导出语义闸门回归（2026-11-08，353969 漏 lc 案）。
// 运行：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/evf-export-guard-test.ts
import { buildRankedEvf, type RankedEvfInput } from "../src/lib/evfwrite";
import { EvfExportValidationError, validateRankedEvfExport } from "../src/lib/evf-export-guard";
import type { OnlineEvent } from "../src/lib/avfwrite";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ev = (mouse: number, x: number, y: number, ms: number): OnlineEvent => ({
  mouse, x, y, ms, sec: Math.floor(ms / 1000), hun: Math.floor(ms / 10) % 100,
});
const board = new Uint8Array(16);
board[0] = 1; // 4×4，仅左上角一颗雷

// 先开中央数字，再标雷；第 4 事件的 lc 让随后的 rc 不摘旗，最后中键 chord 完成胜局。
const source: OnlineEvent[] = [
  ev(3, 24, 24, 0), ev(5, 24, 24, 10),
  ev(9, 8, 8, 20), ev(17, 8, 8, 30),
  ev(3, 8, 8, 40), ev(9, 8, 8, 41), ev(5, 8, 8, 42), ev(17, 8, 8, 43),
  ev(33, 24, 24, 50), ev(65, 24, 24, 60),
];
const base = {
  width: 4, height: 4, mines: 1, board,
  questionMarks: false, nf: false, bbbv: 1,
  scoreCsec: 6, scoreMs: 60, won: true,
  player: "#1 回归", uniqueIdentifier: "evf-export-guard-test", clientVersion: "0.5",
} satisfies Partial<RankedEvfInput>;

console.log("== 正常原始流：编码后逐事件与重放均等价 ==");
const good = buildRankedEvf({ ...base, events: source.map((e) => ({ ...e })) });
const goodResult = validateRankedEvfExport({ ...base, events: source }, good);
check("正常 EVF 通过", goodResult.ok, goodResult.errors.join("；"));
check("原始流与导出流均为胜局", goodResult.sourceOutcome === "win" && goodResult.exportedOutcome === "win");

console.log("== 353969 同类：漏写 lc → rc 误摘旗 → 胜局变未完成 ==");
const corrupted = source.filter((_, i) => i !== 4).map((e) => ({ ...e }));
// 先构造一份「输入本身已坏」的文件；随后必须用转换前 source 才能识别，不可自证。
const bad = buildRankedEvf({ ...base, events: corrupted });
const badResult = validateRankedEvfExport({ ...base, events: source, validationEvents: source }, bad);
check("坏 EVF 被拦截", !badResult.ok);
check("定位到漏写导致的事件错位", badResult.errors.some((e) => e.includes("事件数不一致") || e.includes("类型不一致")), badResult.errors.join("；"));
check("识别胜负分叉", badResult.sourceOutcome === "win" && badResult.exportedOutcome === "incomplete", JSON.stringify(badResult));

const recovered = buildRankedEvf({ ...base, events: corrupted, validationEvents: source });
const recoveredResult = validateRankedEvfExport({ ...base, events: source, validationEvents: source }, recovered);
check("首次失败后绕过坏预处理，从权威原始流重导成功", recoveredResult.ok && recoveredResult.exportedOutcome === "win", recoveredResult.errors.join("；"));

let threw = false;
try {
  // 非整数毫秒无法被 v4 的整数增量时间轴忠实编码；原始流直出也必须失败，不能放行。
  const fractional = source.map((e) => ({ ...e, ms: (e.ms ?? e.sec * 1000 + e.hun * 10) + 0.5 }));
  buildRankedEvf({ ...base, events: fractional, validationEvents: fractional });
} catch (e) {
  threw = e instanceof EvfExportValidationError;
}
check("原始流直出仍失败则抛错，不返回坏字节", threw);

console.log("== 中段多写一组插旗/摘旗：终态相同也必须拦截 ==");
const transient = [
  ...source.slice(0, 4),
  ev(9, 8, 8, 31), ev(17, 8, 8, 32), // 摘旗
  ev(9, 8, 8, 33), ev(17, 8, 8, 34), // 再插回，终盘旗位不变
  ...source.slice(4),
];
const transientBytes = buildRankedEvf({ ...base, events: transient, scoreMs: 60 });
const transientResult = validateRankedEvfExport({ ...base, events: source, validationEvents: source }, transientBytes);
check("终态相同但事件流不同仍失败", !transientResult.ok && transientResult.errors.some((e) => e.includes("事件数不一致")), transientResult.errors.join("；"));

console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
