// 探针（2026-10-28）：有效 3BV/PATH 可行性验证 —— 废点击绕路剔除后再除 3BV。
//
// 原理：replay-core 的 pathPx 是全事件坐标欧氏累加。本脚本用插桩版状态机把
// 「上次点击以来累积的行程段」归属到当前这次被计数的点击（lv 开格 / chord / 旗）：
//   · 有效点击（openCell/openAround 成功、toggleLabel 改盘面）→ effPx
//   · 废点击（点已开格、无效 chord、无效右键）→ wastePx
// 有效 3BV/PATH = bbbv ÷ (effPx / 16格)。
//
// 对账铁律：插桩机的 clLeft/clRight/clDouble/ce/unflag/pathPx/flags 必须与官方
// replayCounts 完全一致，不一致则该盘弃用并计数上报。
//
// 用法（与 video-metrics.ts 同款 loader）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/effpath-probe.ts \
//     [--sample-nf=2000] [--sample-fl=2000] [--ids=226931,328090]

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../src/lib/db";
import { parseVideoBinary, replayEvents } from "../src/lib/videoradar";
import type { NormEvent } from "../src/lib/replay-core";
import type { ParsedVideo } from "../src/lib/rawvf";

const CELL_PX = 16;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEOS = path.join(REPO, "videos");

// ---------- 插桩版状态机（1:1 复制 replay-core.ts，仅加行程归属） ----------

interface EffCounts {
  clLeft: number; clRight: number; clDouble: number; ce: number;
  unflag: number; pathPx: number; flags: number;
  effPx: number; wastePx: number;
  wastedLeft: number; wastedRight: number; wastedDouble: number;
  won: boolean;
}

function replayEff(
  width: number, height: number, minesArr: Uint8Array, events: NormEvent[], marksInit: boolean
): EffCounts {
  const W = width, H = height, N = W * H;
  const mines = minesArr;
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
  const flagged = new Uint8Array(N);
  const questioned = new Uint8Array(N);
  let dead = false;
  let openedSafe = 0;
  const flagsAround = (i: number): number => {
    const x = i % W, y = (i / W) | 0;
    let f = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      if (flagged[ny * W + nx]) f++;
    }
    return f;
  };
  const openCell = (i: number): boolean => {
    if (i < 0 || i >= N || state[i] !== 0 || flagged[i]) return false;
    state[i] = 1;
    if (mines[i]) { dead = true; return true; }
    openedSafe++;
    if (nums[i] === 0) openAroundIdx(i);
    return true;
  };
  const openAroundIdx = (i: number): boolean => {
    if (i < 0 || i >= N || state[i] !== 1) return false;
    if (!(nums[i] === 0 || nums[i] === flagsAround(i))) return false;
    const x = i % W, y = (i / W) | 0;
    let any = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      any = openCell(ny * W + nx) || any;
    }
    return any;
  };
  let unflag = 0;
  const toggleLabel = (i: number, marks: boolean): boolean => {
    if (state[i] === 1) return false;
    if (marks && flagged[i]) { flagged[i] = 0; questioned[i] = 1; }
    else if (flagged[i]) { flagged[i] = 0; questioned[i] = 0; unflag++; }
    else if (questioned[i]) { flagged[i] = 0; questioned[i] = 0; unflag++; }
    else { flagged[i] = 1; questioned[i] = 0; }
    return true;
  };

  let clLeft = 0, clRight = 0, clDouble = 0;
  let wastedLeft = 0, wastedRight = 0, wastedDouble = 0;
  let pathPx = 0, effPx = 0, wastePx = 0;
  let pendingPx = 0; // 上次被计数点击以来累积的行程段
  let lastX: number | null = null, lastY: number | null = null;

  let lp = false, lv = false, rp = false, rv = false, sv = false;
  let marks = marksInit;
  let over = false;
  // Win 判定与 replay-core 相同：openedSafe >= N - mines
  let mineCount = 0;
  for (let i = 0; i < N; i++) if (mines[i]) mineCount++;
  const winAt = N - mineCount;

  const bucket = (eff: boolean) => {
    if (eff) effPx += pendingPx;
    else wastePx += pendingPx;
    pendingPx = 0;
  };

  for (const e of events) {
    if (over) break;
    if ((e.px !== 0 || e.py !== 0) && e.px < 60000 && e.py < 60000) {
      if (lastX !== null && lastY !== null) {
        const seg = Math.hypot(e.px - lastX, e.py - lastY);
        pathPx += seg;
        pendingPx += seg;
      }
      lastX = e.px;
      lastY = e.py;
    } else {
      lastX = null;
      lastY = null;
    }
    if (e.ev === "mt") { marks = !marks; continue; }
    if (e.ev === "mv") continue;
    const i = e.y * W + e.x;
    const inside = i >= 0 && i < N && e.x >= 0 && e.x < W && e.y >= 0 && e.y < H;
    switch (e.ev) {
      case "lc":
        lp = lv = true;
        break;
      case "lr": {
        if (rp || sv) {
          clDouble++;
          const ok = openAroundIdx(inside ? i : -1);
          if (!ok) wastedDouble++;
          bucket(ok);
        } else if (lv) {
          clLeft++;
          const ok = openCell(inside ? i : -1);
          if (!ok) wastedLeft++;
          bucket(ok);
        }
        lp = lv = rv = sv = false;
        break;
      }
      case "rc": {
        if (!lp) {
          if (inside && toggleLabel(i, marks)) {
            clRight++;
            rv = false;
            bucket(true);
          } else {
            rv = true;
          }
        }
        rp = true;
        break;
      }
      case "rr": {
        if (lp) {
          clDouble++;
          const ok = openAroundIdx(inside ? i : -1);
          if (!ok) wastedDouble++;
          bucket(ok);
        } else if (rv) {
          clRight++;
          wastedRight++;
          bucket(false);
        }
        rp = lv = rv = sv = false;
        break;
      }
      case "mc":
        break;
      case "mr": {
        clDouble++;
        const ok = openAroundIdx(inside ? i : -1);
        if (!ok) wastedDouble++;
        bucket(ok);
        break;
      }
      case "sc":
        lp = lv = sv = true;
        break;
    }
    if (openedSafe >= winAt) over = true;
    if (dead) over = true;
  }

  let flags = 0;
  for (let i = 0; i < N; i++) if (flagged[i]) flags++;
  const cl = clLeft + clRight + clDouble;
  return {
    clLeft, clRight, clDouble,
    ce: cl - (wastedLeft + wastedRight + wastedDouble),
    unflag, pathPx, flags, effPx, wastePx,
    wastedLeft, wastedRight, wastedDouble,
    won: !dead && openedSafe >= winAt,
  };
}

// ---------- 事件行解析（与 videoradar.replayEvents 同一正则） ----------

function toEvents(v: ParsedVideo): { evs: NormEvent[]; mines: Uint8Array } {
  const W = v.width, H = v.height;
  const mines = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mines[i] = v.board[i] === "*" ? 1 : 0;
  const evs: NormEvent[] = [];
  for (const line of v.events) {
    const m = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (!m) continue;
    evs.push({ ev: m[2] as NormEvent["ev"], x: +m[3] - 1, y: +m[4] - 1, px: +m[5], py: +m[6] });
  }
  return { evs, mines };
}

// ---------- 主流程 ----------

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

interface Row { id: bigint; filepath: string; level: string; noflag: boolean; stnb: number; bbbv: number }

async function loadSample(noflag: boolean, n: number, extraIds: number[]): Promise<Row[]> {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT v.id, vi.filepath, vm.level, vm.noflag, vm.stnb, vm.bbbv
     FROM video v
     JOIN video_info vi ON vi.id = v.id
     JOIN video_metrics vm ON vm.id = v.id
     WHERE v.status = 20 AND vm.level = 'exp' AND vm.noflag = ?
       AND vm.path > 0 AND vm.cl > 0 AND vm.bbbv > 0 AND vi.real_time > 0
     ORDER BY RAND() LIMIT ?`,
    noflag ? 1 : 0, n
  );
  if (extraIds.length) {
    const ph = extraIds.map(() => "?").join(",");
    const extra = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT v.id, vi.filepath, vm.level, vm.noflag, vm.stnb, vm.bbbv
       FROM video v JOIN video_info vi ON vi.id = v.id
       JOIN video_metrics vm ON vm.id = v.id
       WHERE v.id IN (${ph})`,
      ...extraIds
    );
    rows.push(...extra);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const getN = (k: string, d: number) => {
    const a = args.find((s) => s.startsWith(`--${k}=`));
    return a ? parseInt(a.split("=")[1], 10) : d;
  };
  const idsArg = args.find((s) => s.startsWith("--ids="));
  const extraIds = idsArg ? idsArg.split("=")[1].split(",").map(Number).filter(Boolean) : [];

  const nNF = getN("sample-nf", 2000);
  const nFL = getN("sample-fl", 2000);
  const [nfRows, flRows] = await Promise.all([
    loadSample(true, nNF, extraIds),
    loadSample(false, nFL, extraIds),
  ]);

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const mismatch = { count: 0, lost: 0 };
  const groups = {
    NF: { rows: nfRows, stnb: [] as number[], raw: [] as number[], eff: [] as number[] },
    FL: { rows: flRows, stnb: [] as number[], raw: [] as number[], eff: [] as number[] },
  };

  for (const g of Object.values(groups)) {
    for (const row of g.rows) {
      const fp = path.join(VIDEOS, row.filepath);
      let buf: Buffer;
      try { buf = readFileSync(fp); } catch { mismatch.lost++; continue; }
      const ext = path.extname(fp).slice(1).toLowerCase();
      const v = parseVideoBinary(buf, ext);
      if (!v) { mismatch.lost++; continue; }
      const official = replayEvents(v);
      const { evs, mines } = toEvents(v);
      const mine = replayEff(v.width, v.height, mines, evs, v.marks ?? false);
      // 对账：七个计数必须全等
      if (
        mine.clLeft !== official.clLeft || mine.clRight !== official.clRight ||
        mine.clDouble !== official.clDouble || mine.ce !== official.ce ||
        mine.unflag !== official.unflag || mine.pathPx !== official.pathPx ||
        mine.flags !== official.flags || !mine.won
      ) { mismatch.count++; continue; }
      if (mine.effPx <= 0) continue;
      const rawP = row.bbbv / (official.pathPx / CELL_PX);
      const effP = row.bbbv / (mine.effPx / CELL_PX);
      g.stnb.push(row.stnb);
      g.raw.push(rawP);
      g.eff.push(effP);
    }
  }

  console.log(`对账失败（计数不一致）: ${mismatch.count}，文件缺失/解析失败: ${mismatch.lost}`);
  for (const [name, g] of Object.entries(groups)) {
    const ord = [...g.eff].sort((a, b) => a - b);
    console.log(`\n=== ${name}（有效样本 n=${g.eff.length}）===`);
    console.log(`  r(stnb, raw 3BV/PATH) = ${r3(pearson(g.stnb, g.raw))}`);
    console.log(`  r(stnb, eff 3BV/PATH) = ${r3(pearson(g.stnb, g.eff))}`);
    console.log(`  eff 分布: p05=${r3(pct(ord, 5))} p25=${r3(pct(ord, 25))} p50=${r3(pct(ord, 50))} p75=${r3(pct(ord, 75))} p95=${r3(pct(ord, 95))} p99=${r3(pct(ord, 99))}`);
    for (const id of extraIds) {
      const idx = g.rows.findIndex((r) => Number(r.id) === id);
      if (idx < 0 || !g.eff[idx]) continue;
      const below = ord.filter((x) => x < g.eff[idx]).length;
      console.log(`  [${id}] stnb=${g.stnb[idx]} raw=${r3(g.raw[idx])} eff=${r3(g.eff[idx])} → eff 组内分位 ≈ ${r3((below / ord.length) * 100)}%`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
