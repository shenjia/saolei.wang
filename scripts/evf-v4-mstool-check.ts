// EVF v4 产物 × ms-toollib（flop 播放器同源解析器）真值核验：
//   env -u NODE_OPTIONS ./node_modules/.bin/jiti scripts/evf-v4-mstool-check.ts
// buildRankedEvf(v4) → EvfVideo.parse()/analyse()：验证 Rust 端 evf v0.4 解析
// （含停顿事件桥接、增量坐标）不吃报错，头部字段与事件数一致。
import { buildRankedEvf } from "../src/lib/evfwrite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as MsToolBg from "ms-toollib/ms_toollib_bg.js";

/* —— msvalid.ts 同款手工 wasm 链接（绕开包入口的 wasm ESM 集成坑）—— */
async function loadMsTool(): Promise<typeof MsToolBg> {
  const mod = await import("ms-toollib/ms_toollib_bg.js");
  const wasmPath = createRequire(import.meta.url).resolve("ms-toollib/ms_toollib_bg.wasm");
  const imports: WebAssembly.Imports = { "./ms_toollib_bg.js": {} };
  const wbg = imports["./ms_toollib_bg.js"];
  for (const [k, v] of Object.entries(mod)) {
    if (k.startsWith("__w") && typeof v === "function") wbg[k] = v as WebAssembly.ImportValue;
  }
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), imports);
  mod.__wbg_set_wasm(instance.exports);
  (instance.exports as { __wbindgen_start(): void }).__wbindgen_start();
  return mod;
}

const ev = (mouse: number, x: number, y: number, ms: number) => ({
  mouse, x, y, sec: Math.floor(ms / 1000), hun: Math.floor(ms / 10) % 100, ms,
});
function board8x8(): Uint8Array {
  const b = new Uint8Array(64);
  for (let i = 0; i < 10; i++) b[i] = 1;
  return b;
}

const mod = await loadMsTool();
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function runCase(name: string, bytes: Uint8Array, asserts: (v: MsToolBg.EvfVideo) => void) {
  console.log(`== ${name} ==`);
  let video: MsToolBg.EvfVideo | null = null;
  try {
    video = new mod.EvfVideo(bytes, "test.evf");
    video.parse();
    video.analyse();
    console.log(`  parse+analyse 无异常`);
    asserts(video);
  } catch (e) {
    failed++;
    console.error(`  FAIL parse/analyse 抛错: ${e}`);
  } finally {
    try { video?.free(); } catch { /* swallow */ }
  }
}

/* 用例 1：标准胜局，事件齐全（mv/lc/lr/rc/rr/cc/mr），墙钟起止 */
{
  const events = [
    ev(1, 64, 64, 0), ev(3, 64, 64, 120), ev(5, 64, 64, 180),
    ev(1, 80, 96, 260), ev(9, 80, 96, 400), ev(17, 80, 96, 470),
    ev(11, 96, 64, 600), ev(65, 96, 64, 700),
  ];
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: true, nf: false, bbbv: 24,
    scoreCsec: 654, scoreMs: 6540, events,
    won: true, player: "#42 测试", uniqueIdentifier: "game-1",
    clientVersion: "0.5", startedAtMs: 1_700_000_000_000, endedAtMs: 1_700_000_006_540,
  });
  runCase("用例 1：标准胜局", bytes, (v) => {
    check("software", v.software === "Saolei.wang 0.5", v.software);
    check("is_completed", v.is_completed === true);
    check("is_official / is_fair", v.is_official === true && v.is_fair === true);
    check("bbbv=24", v.bbbv === 24, String(v.bbbv));
    check("rtime≈6.54s", Math.abs(v.rtime - 6.54) < 0.01, String(v.rtime));
    check("player_identifier", v.player_identifier === "#42 测试", v.player_identifier);
    check("start_time", v.start_time === BigInt(1_700_000_000_000_000), String(v.start_time));
    check("end_time", v.end_time === BigInt(1_700_000_006_540_000), String(v.end_time));
    /* use_question/nf/translated 位 wasm 未导出（undefined），由站内 parseEvf
       往返测试覆盖；这里只验导出字段 */
    const n = v.events.length;
    check("事件数 8", n === 8, String(n));
  });
}

/* 用例 2：>255ms 与 >65535ms 停顿桥接（Rust 端停顿累计是否精确） */
{
  const events = [
    ev(3, 16, 16, 400), ev(5, 16, 16, 450),
    ev(3, 32, 32, 1000), ev(5, 32, 32, 1050),
    ev(3, 48, 48, 80000), ev(5, 48, 48, 80050),
  ];
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: true, bbbv: 24,
    scoreCsec: 8005, scoreMs: 80050, events, won: true,
  });
  runCase("用例 2：停顿桥接", bytes, (v) => {
    check("rtime=80.05s", Math.abs(v.rtime - 80.05) < 0.01, String(v.rtime));
    check("事件数 6", v.events.length === 6, String(v.events.length));
  });
}

/* 用例 3：败局凭据（won=false → completed=0） */
{
  const bytes = buildRankedEvf({
    width: 8, height: 8, mines: 10, board: board8x8(),
    questionMarks: false, nf: false, bbbv: 24, scoreCsec: 30,
    events: [ev(1, 64, 64, 0), ev(3, 64, 64, 100), ev(5, 64, 64, 200)],
    won: false, player: "#42 凭据",
  });
  runCase("用例 3：败局凭据", bytes, (v) => {
    /* is_completed/is_official/is_fair 在 wasm 端经 analyse() 派生（不回读
       summary 位），不代表文件位；summary 位语义由站内 parseEvf 往返测试覆盖 */
    check("player_identifier", v.player_identifier === "#42 凭据", v.player_identifier);
    check("bbbv=24", v.bbbv === 24, String(v.bbbv));
    check("rtime=0.3s", Math.abs(v.rtime - 0.3) < 0.01, String(v.rtime));
    check("事件数 3", v.events.length === 3, String(v.events.length));
  });
}

console.log(failed === 0 ? "\nms-toollib 全部通过 ✅" : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
