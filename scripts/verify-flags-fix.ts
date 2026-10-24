// Flags 口径修复验证（2026-10-22）：
//   runReplay 的 buildStats.flags 从「rstate===2 现数」改为 playerFlags 增量计数后，
//   终值必须只计玩家实际插旗（胜利自动补旗不计）。flop 真值：338799 胜局 Flags=29。
//   方法：离线 1:1 复刻 VideoReplay.runReplay 状态机（flop 语义，与 videowin.ts 同源），
//   对真实 avf 全事件流重演，比对三值：
//     rstateFlags（终局盘面旗数，含自动补旗）—— 修复前 Flags 的取值（应=99 全旗之类）
//     playerFlags（rc 增量计数）—— 修复后 Flags 的取值（应=29）
//     对照 flop 官方（run-flop.mjs 时代截图真值 29）
//   再对 338721（chord 收官局，终局玩家手插 99 旗滑键收尾）验证边界：自动补旗=0 时两口径相等。
// 跑法：env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/verify-flags-fix.ts
import { readFileSync } from "fs";
import { avfToRawvf } from "../src/lib/avf";
import { formatRawvf } from "../src/lib/rawvf";

function simulate(fp: string) {
  const raw = avfToRawvf(new Uint8Array(readFileSync(fp)));
  if (!raw) throw new Error("avf 解析失败: " + fp);
  const v = formatRawvf(raw);
  const rows = v.height, cols = v.width, N = rows * cols;
  const mines = new Uint8Array(N), nums = new Uint8Array(N);
  let mineCount = 0;
  for (let i = 0; i < N; i++) {
    const ch = v.board[i];
    if (ch === "*") { mines[i] = 1; mineCount++; }
    else nums[i] = ch.charCodeAt(0) - 48;
  }
  const rstate = new Uint8Array(N); // 0/1/2/3
  const evs = v.events
    .map((line) => {
      const m = /^(-?[\d.]+) (lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
      return m ? { ev: m[2], px: +m[5], py: +m[6] } : null;
    })
    .filter(Boolean) as { ev: string; px: number; py: number }[];

  const inside = (px: number, py: number) => px >= 0 && py >= 0 && px < cols * 16 && py < rows * 16;
  const idxOf = (px: number, py: number) => ((py / 16) | 0) * cols + ((px / 16) | 0);
  let marks = v.marks ?? false;
  let lp = false, lv = false, rp = false, rv = false, sv = false;
  let dead = false, won = false;
  let playerFlags = 0; // 修复后的口径

  const nb = (i: number) => {
    const x = i % cols, y = (i / cols) | 0, r: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) r.push(ny * cols + nx);
      }
    return r;
  };
  const flagsAround = (i: number) => nb(i).filter((a) => rstate[a] === 2).length;

  let openedCount = 0;
  const openRaw: number[] = [];
  function open(px: number, py: number): boolean {
    if (!inside(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] === 1 || rstate[i] === 2) return false;
    if (mines[i]) { dead = true; openRaw.push(i); return true; }
    rstate[i] = 1; openedCount++;
    if (nums[i] === 0) {
      const stack = [i];
      while (stack.length) {
        const c = stack.pop()!;
        for (const a of nb(c)) {
          if (rstate[a] === 0 && !mines[a]) {
            rstate[a] = 1; openedCount++;
            if (nums[a] === 0) stack.push(a);
          }
        }
      }
    }
    checkWin();
    return true;
  }
  function openAround(px: number, py: number): boolean {
    if (!inside(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] !== 1) return false;
    if (!(nums[i] === 0 || nums[i] === flagsAround(i))) return false;
    let any = false;
    for (const a of nb(i)) {
      if (rstate[a] === 0) {
        const x = a % cols, y = (a / cols) | 0;
        any = open(x * 16, y * 16) || any;
        if (dead) return any;
      }
    }
    return any;
  }
  function toggleLabel(px: number, py: number): boolean {
    if (!inside(px, py)) return false;
    const i = idxOf(px, py);
    if (rstate[i] === 1) return false;
    if (marks && rstate[i] === 2) { rstate[i] = 3; playerFlags--; }
    else if (rstate[i] === 2 || rstate[i] === 3) { if (rstate[i] === 2) playerFlags--; rstate[i] = 0; }
    else { rstate[i] = 2; playerFlags++; }
    return true;
  }
  let winAt = -1;
  function checkWin() {
    if (won || dead) return;
    let opened = 0;
    for (let i = 0; i < N; i++) if (rstate[i] === 1) opened++;
    if (opened < N - mineCount) return;
    won = true;
    winAt = playerFlags; // 胜利瞬间的玩家旗数快照
    for (let i = 0; i < N; i++)
      if (mines[i] && rstate[i] !== 2) rstate[i] = 2; // 自动补旗（视觉）
  }

  for (const e of evs) {
    if (dead || won) break; // 终局事件守卫（修复后的 applyEv 口径）
    switch (e.ev) {
      case "lc": lp = lv = true; break;
      case "lr":
        if (rp || sv) openAround(e.px, e.py);
        else if (lv) open(e.px, e.py);
        lp = lv = rv = sv = false;
        break;
      case "rc":
        if (!lp) { if (toggleLabel(e.px, e.py)) rv = false; else rv = true; }
        rp = true;
        break;
      case "rr":
        if (lp) openAround(e.px, e.py);
        rp = lv = rv = sv = false;
        break;
      case "mr": openAround(e.px, e.py); break;
      case "sc": lp = lv = sv = true; break;
      case "mt": marks = !marks; break;
    }
  }

  let rstateFlags = 0;
  for (let i = 0; i < N; i++) if (rstate[i] === 2) rstateFlags++;
  let openedEnd = 0;
  for (let i = 0; i < N; i++) if (rstate[i] === 1) openedEnd++;
  return { won, dead, playerFlags, rstateFlags, winAt, mineCount, openedEnd, safeTotal: N - mineCount, openRaw: openRaw.length };
}

/* 338799：flop 真值 Flags=29（3BV 132/132 胜局） */
const a = simulate("videos/2026/04/06/1b194bca789f3f2a1d19ac94791b51ee.avf");
const vaRaw = avfToRawvf(new Uint8Array(readFileSync("videos/2026/04/06/1b194bca789f3f2a1d19ac94791b51ee.avf")));
if (!vaRaw) throw new Error("avf 解析失败（事件统计段）");
const va = formatRawvf(vaRaw);
const evCnt: Record<string, number> = {};
for (const l of va.events) {
  const m = /^-?[\d.]+ (lc|lr|rc|rr|mc|mr|sc|mt) /.exec(l);
  if (m) evCnt[m[1]] = (evCnt[m[1]] || 0) + 1;
}
console.log("[338799] evs:", JSON.stringify(evCnt), "time:", va.timeMs, "marks:", va.marks);
console.log("[338799]", JSON.stringify(a));
if (a.won && a.playerFlags === 29 && a.rstateFlags === 99)
  console.log("[338799] PASS：胜利局 playerFlags=29（flop 真值）✓，盘面全旗 99（自动补旗曾污染 Flags）✓");
else {
  console.error("[338799] FAIL");
  process.exit(1);
}

/* 338721：滑键收官局，玩家手插 99 旗 —— 两口径应相等（自动补旗=0） */
const b = simulate("videos/2026/04/05/ff209dd103b6aa805e5e433175e1243e.avf");
console.log("[338721]", JSON.stringify(b));
if (b.won && b.playerFlags === b.rstateFlags)
  console.log("[338721] PASS：全手插旗局两口径一致 =", b.playerFlags, "✓");
else {
  console.error("[338721] FAIL");
  process.exit(1);
}
console.log("ALL PASS");
