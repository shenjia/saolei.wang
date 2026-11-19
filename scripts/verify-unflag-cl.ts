// 临时验证脚本：Clone mvf 头部计数（官方口径地面真值）vs 重放引擎修复前后对齐度
// 用法：env -u NODE_OPTIONS node --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs scripts/verify-unflag-cl.ts
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { mvfToRawvf } from "../src/lib/mvf";
import { formatRawvf, type ParsedVideo } from "../src/lib/rawvf";
import { replayEvents, type ReplayCounts } from "../src/lib/videoradar";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

// 旧口径复刻（修复前）：拔旗不计 clRight、已开格 rc 不计 —— 仅 rightClick 三分支与新版不同
function replayOld(v: ParsedVideo): ReplayCounts {
  const W = v.width, H = v.height, N = W * H;
  const mines = new Uint8Array(N);
  for (let i = 0; i < N; i++) mines[i] = v.board[i] === "*" ? 1 : 0;
  const nums = new Int8Array(N);
  for (let i = 0; i < N; i++) {
    if (mines[i]) { nums[i] = -1; continue; }
    let c = 0;
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (mines[ny * W + nx]) c++;
    }
    nums[i] = c;
  }
  const state = new Uint8Array(N);
  const nb: number[][] = new Array(N);
  const neighbors = (i: number): number[] => {
    if (nb[i]) return nb[i];
    const x = i % W, y = (i / W) | 0, r: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) r.push(ny * W + nx);
    }
    nb[i] = r; return r;
  };
  let openedSafe = 0;
  const flood = (i: number) => {
    if (state[i] !== 0 || mines[i]) return;
    const stack = [i]; state[i] = 1; openedSafe++;
    while (stack.length) {
      const c = stack.pop()!;
      if (nums[c] !== 0) continue;
      for (const a of neighbors(c)) if (state[a] === 0 && !mines[a]) { state[a] = 1; openedSafe++; stack.push(a); }
    }
  };
  const chord = (i: number) => {
    if (state[i] !== 1 || nums[i] <= 0) return;
    const around = neighbors(i); let f = 0;
    for (const a of around) if (state[a] === 2) f++;
    if (f !== nums[i]) return;
    for (const a of around) if (state[a] === 0 && !mines[a]) flood(a);
  };
  let clLeft = 0, clRight = 0, clDouble = 0, ce = 0, unflag = 0, flagToggles = 0, pathPx = 0;
  let lastX: number | null = null, lastY: number | null = null;
  const counted = (fn: () => void) => {
    const before = openedSafe * 1024 + flagToggles; fn();
    if (openedSafe * 1024 + flagToggles !== before) ce++;
  };
  const evs: { ts: number; ev: string; x: number; y: number; px: number; py: number }[] = [];
  for (const line of v.events) {
    const m = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (!m) continue;
    evs.push({ ts: parseFloat(m[1]), ev: m[2], x: +m[3] - 1, y: +m[4] - 1, px: +m[5], py: +m[6] });
  }
  type Ev = { ts: number; ev: string; x: number; y: number; px: number; py: number };
  const inb = (e: Ev) => e.x >= 0 && e.y >= 0 && e.x < W && e.y < H;
  const idx = (e: Ev) => e.y * W + e.x;
  const leftClick = (r: Ev) => {
    if (!inb(r)) return;
    const i = idx(r);
    if (state[i] === 1) { counted(() => { clDouble++; chord(i); }); }
    else if (state[i] === 2) { clDouble++; }
    else { clLeft++; counted(() => flood(i)); }
  };
  const rightClickOld = (r: Ev) => {
    if (!inb(r)) return;
    const i = idx(r);
    if (state[i] === 0) { clRight++; counted(() => { state[i] = 2; flagToggles++; }); }
    else if (state[i] === 2) { unflag++; counted(() => { state[i] = 0; flagToggles++; }); }
  };
  const chordAt = (e: Ev) => {
    if (!inb(e)) return;
    counted(() => { clDouble++; chord(idx(e)); });
  };
  let pendL: Ev | null = null, pendR: Ev | null = null;
  for (const e of evs) {
    if (e.px !== 0 || e.py !== 0) {
      if (lastX !== null && lastY !== null) pathPx += Math.hypot(e.px - lastX, e.py - lastY);
      lastX = e.px; lastY = e.py;
    }
    if (e.ev === "lc") { if (pendL) leftClick(pendL); pendL = e; }
    else if (e.ev === "lr") { if (pendL) { leftClick(e); pendL = null; } }
    else if (e.ev === "rc") {
      if (pendL) { chordAt(e); pendL = null; pendR = null; }
      else { if (pendR) rightClickOld(pendR); pendR = e; }
    } else if (e.ev === "rr") { if (pendR) { rightClickOld(e); pendR = null; } }
    else if (e.ev === "sc" || e.ev === "mc") chordAt(e);
  }
  if (pendL) leftClick(pendL);
  if (pendR) rightClickOld(pendR);
  let flags = 0;
  for (let i = 0; i < N; i++) if (state[i] === 2) flags++;
  return {
    width: W,
    height: H,
    mines: v.mines,
    clLeft,
    clRight,
    clDouble,
    ce,
    wastedLeft: 0,
    wastedRight: 0,
    wastedDouble: 0,
    unflag,
    pathPx,
    crossings: 0,
    flags,
    flagged: new Uint8Array(0), // 旧口径复刻不含此量（2026-10-31 加字段，占位不参与对账）
    solvedBv: 0, // 旧口径复刻不含此量（2026-10-30 加字段，占位不参与对账）
  };
}

function parseHeadCounts(lines: string[]): { l: number; r: number; d: number } | null {
  const get = (k: string) => {
    const hit = lines.find((s) => s.startsWith(k + ":"));
    return hit ? Number(hit.slice(k.length + 1).trim()) : null;
  };
  const l = get("LeftClicks"), r = get("RightClicks"), d = get("DoubleClicks");
  if (l === null || r === null || d === null) return null;
  return { l, r, d };
}

async function main() {
  const SAMPLE = 2000;
  const rows = await prisma.$queryRawUnsafe<{ id: bigint; filepath: string }[]>(
    `SELECT id, filepath FROM video_info WHERE filepath LIKE '%.mvf' ORDER BY RAND(42) LIMIT ${SAMPLE}`
  );
  let oldHit = 0, newHit = 0, total = 0;
  let oldRdiff = 0, newRdiff = 0;
  let unflagGames = 0;
  const regressed: string[] = [];
  for (const { id, filepath } of rows) {
    let buf: Buffer;
    try {
      buf = readFileSync(path.resolve(VIDEOS_ROOT, "." + filepath));
    } catch { continue; }
    let lines: string[] | null = null;
    try {
      lines = mvfToRawvf(buf);
    } catch { continue; }
    if (!lines) continue;
    const head = parseHeadCounts(lines);
    if (!head) continue; // 丢头/老版本 mvf 无计数
    const v = formatRawvf(lines);
    total++;
    const cOld = replayOld(v);
    const cNew = replayEvents(v);
    if (cOld.unflag > 0) unflagGames++;
    const oldOk = cOld.clLeft === head.l && cOld.clRight === head.r && cOld.clDouble === head.d;
    const newOk = cNew.clLeft === head.l && cNew.clRight === head.r && cNew.clDouble === head.d;
    if (oldOk) oldHit++;
    if (newOk) newHit++;
    oldRdiff += Math.abs(cOld.clRight - head.r);
    newRdiff += Math.abs(cNew.clRight - head.r);
    if (oldOk && !newOk && regressed.length < 8) {
      regressed.push(
        `${id}: head(l=${head.l},r=${head.r},d=${head.d}) old(l=${cOld.clLeft},r=${cOld.clRight},d=${cOld.clDouble}) new(l=${cNew.clLeft},r=${cNew.clRight},d=${cNew.clDouble}) unflag=${cNew.unflag}`
      );
    }
  }
  console.log(`样本（头部带计数的 mvf）：${total}，其中含拔旗的盘：${unflagGames}`);
  console.log(`三计数全对齐：旧口径 ${oldHit}（${(oldHit / total * 100).toFixed(2)}%）｜新口径 ${newHit}（${(newHit / total * 100).toFixed(2)}%）`);
  console.log(`RightClicks 绝对差合计：旧 ${oldRdiff}｜新 ${newRdiff}`);
  if (regressed.length) console.log("旧对新错样本：\n" + regressed.join("\n"));
  else console.log("无「旧对新错」样本");
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
