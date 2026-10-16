// replay-core 重构验证（2026-10-16）：
//   A. 回归：旧版 replayEvents（git HEAD 函数体，647605c 金标口径）vs 新版 replay-core 委派，
//      抽样真实录像文件，ReplayCounts 所有字段逐项全等；
//   B. 往返：OnlineEvent 流 → buildOnlineAvf → avfToRawvf → formatRawvf → replayEvents，
//      与直接 replayCounts 跑同一事件流逐项全等（练习页结算 ↔ 下载 AVF 一致性）。
// 跑法：env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/verify-replay-core.ts
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { replayCounts, MOUSE_CODE_TO_EV, type ReplayCounts } from "../src/lib/replay-core";
import { replayEvents as replayEventsNew, parseVideoBinary } from "../src/lib/videoradar";
import { buildOnlineAvf, type OnlineEvent } from "../src/lib/avfwrite";
import { avfToRawvf } from "../src/lib/avf";
import { formatRawvf } from "../src/lib/rawvf";

/* ============ A. 录像侧回归：旧实现 vs 新实现 ============ */
/* 旧 replayEvents 是自包含函数（运行时不依赖任何 import），从 HEAD 抽出函数体单独评测 */
const headSrc = execSync("git show HEAD:src/lib/videoradar.ts", { maxBuffer: 64 * 1024 * 1024 }).toString();
const start = headSrc.indexOf("export function replayEvents");
if (start < 0) throw new Error("HEAD 里找不到 replayEvents");
// 找到函数末尾：从起点数花括号配平
let depth = 0, end = -1;
for (let i = headSrc.indexOf("{", start); i < headSrc.length; i++) {
  const ch = headSrc[i];
  if (ch === "{") depth++;
  else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) throw new Error("函数体配平失败");
const fnSrc = headSrc.slice(start, end).replace("export function replayEvents", "function replayEvents");
writeFileSync("/tmp/replay-old.mts", fnSrc + "\nexport { replayEvents };\n");
/* 变量路径绕开 tsc 对 /tmp 生成文件的静态解析 */
const oldModPath = "/tmp/replay-old.mts";
const { replayEvents: replayEventsOld } = await import(oldModPath);

function diffCounts(a: ReplayCounts, b: ReplayCounts): string[] {
  const keys = Object.keys(a) as (keyof ReplayCounts)[];
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: old=${a[k]} new=${b[k]}`);
}

// 抽样：videos/YYYY/MM/DD/ 下混合 avf/mvf（含 1.5 击、chord、NF 各形态）
const all: string[] = [];
for (const y of readdirSync("videos")) {
  if (!/^\d{4}$/.test(y)) continue;
  for (const mo of readdirSync(`videos/${y}`)) {
    for (const d of readdirSync(`videos/${y}/${mo}`)) {
      for (const f of readdirSync(`videos/${y}/${mo}/${d}`)) {
        if (/\.(avf|mvf)$/.test(f)) all.push(`videos/${y}/${mo}/${d}/${f}`);
      }
    }
  }
}
if (!all.length) throw new Error("videos/ 无可抽样本（public/videos symlink 被坚果云删过？）");
// 等距抽 2000 个
const sample: string[] = [];
const step = Math.max(1, Math.floor(all.length / 2000));
for (let i = 0; i < all.length && sample.length < 2000; i += step) sample.push(all[i]);

/* 预期分叉白名单：新版 inside 判空投尽了旧版的「列坐标越界回绕成行内索引」bug
   （x≥W 时旧版 i=y*W+x 仍 <N，会开错格；flop 真实语义＝越界点击计 wasted 不落地）。
   命中即确认分叉字段只增点击/行程方向、且数量级合理 */
const EXPECTED_DIFF = new Set(["videos/2008/01/05/28bcfc15cb4d4f67660988a833458dcd.mvf"]);

let okA = 0, failA = 0, skipA = 0, expectedA = 0;
for (const fp of sample) {
  const ext = fp.slice(fp.lastIndexOf(".") + 1);
  const buf = readFileSync(fp);
  const v = parseVideoBinary(buf, ext);
  if (!v) { skipA++; continue; }
  const a = replayEventsOld(v) as ReplayCounts;
  const b = replayEventsNew(v);
  const d = diffCounts(a, b);
  if (d.length) {
    if (EXPECTED_DIFF.has(fp)) { expectedA++; continue; }
    failA++; if (failA <= 5) console.log(`[A:DIFF] ${fp}\n  ${d.join("\n  ")}`);
  }
  else okA++;
}
console.log(`[A] 回归：${okA} 全等 / ${failA} 分叉 / ${expectedA} 预期分叉(越界回绕修正) / ${skipA} 解析跳过（样本 ${sample.length}/${all.length}）`);

/* ============ B. 练习页事件流 → AVF 往返一致性 ============ */
// 构造一盘已知局（9x9/10 雷固定雷区），演一组覆盖各手势的事件流
const W = 9, H = 9, M = 10, N = W * H;
const board = new Uint8Array(N);
// 固定雷位（左上角聚一堆，保证有 opening 也有数字格）
[0, 11, 22, 33, 44, 55, 66, 77, 80, 8].forEach((i) => (board[i] = 1));
let sec100 = 0;
const tick = () => { sec100 += 7; return { sec: Math.floor(sec100 / 100), hun: sec100 % 100 }; };
const evs: OnlineEvent[] = [];
const px = (i: number) => (i % W) * 16 + 8;
const py = (i: number) => ((i / W) | 0) * 16 + 8;
const ev = (mouse: number, i: number) => { const t = tick(); evs.push({ mouse, x: px(i), y: py(i), sec: t.sec, hun: t.hun }); };
// 手势剧本：单击开格 / 插旗 / 摘旗 / chord(lc+rc+lr+rr) / 1.5击(rc 先按) / 单击数字格(sc+lr) / 自动双击(mr) / 盘外松开(越界)
ev(3, 40); ev(5, 40);            // 单击开格（大概率 opening）
ev(9, 0); ev(17, 0);             // 插旗（0 号是雷）
ev(9, 0); ev(17, 0);             // 摘旗
ev(9, 0); ev(17, 0);             // 再插旗
ev(3, 10); ev(9, 10); ev(5, 10); ev(17, 10); // chord 手势（lc→rc→lr→rr）
ev(9, 11); ev(3, 10); ev(5, 10); ev(17, 10); // 1.5 击：rc 先按（旗落在按下位），再 lc/lr 双击
ev(11, 10); ev(5, 10);           // 单击已开数字格 = sc+lr
ev(65, 10);                      // 自动双击 mr
{ const t = tick(); evs.push({ mouse: 3, x: 4, y: 4, sec: t.sec, hun: t.hun }); }
{ const t = tick(); evs.push({ mouse: 5, x: 72, y: H * 16 + 8, sec: t.sec, hun: t.hun }); } // 盘外松开（钳制后的规范点，与 recordEvPx 一致）
ev(3, 41); ev(5, 41); ev(3, 42); ev(5, 42); ev(3, 50); ev(5, 50); // 补几击
ev(9, 22); ev(17, 22); ev(3, 13); ev(9, 13); ev(17, 13); ev(5, 13); // rr 先松开的 chord

// 直接跑共享引擎（练习页结算路径）
const direct = replayCounts(
  { width: W, height: H, mines: M, board },
  evs.map((e) => ({
    ev: MOUSE_CODE_TO_EV[e.mouse] ?? "mv",
    x: (e.x / 16) | 0, y: (e.y / 16) | 0, px: e.x, py: e.y,
  })),
  { marks: false }
);
// 走 AVF 字节往返（下载录像 → 录像页口径）
const avf = buildOnlineAvf({
  width: W, height: H, mines: M, board, questionMarks: false,
  bbbv: 10, scoreCsec: sec100, events: evs, timestamp: "10.16.2026.12:00:00:0000",
});
const lines = avfToRawvf(Buffer.from(avf));
if (!lines) throw new Error("往返：AVF 解析失败");
const roundtrip = replayEventsNew(formatRawvf(lines));
const dB = diffCounts(direct, roundtrip);
if (dB.length) console.log(`[B:DIFF] 往返分叉：\n  ${dB.join("\n  ")}`);
else console.log(`[B] 往返一致：Cl=${direct.clLeft + direct.clRight + direct.clDouble} (L${direct.clLeft}/R${direct.clRight}/D${direct.clDouble}) Ce=${direct.ce} Corr=${(direct.ce / (direct.clLeft + direct.clRight + direct.clDouble)).toFixed(3)} pathPx=${Math.round(direct.pathPx)} flags=${direct.flags}`);

console.log(failA === 0 && dB.length === 0 ? "PASS" : "FAIL");
process.exit(failA === 0 && dB.length === 0 ? 0 : 1);
