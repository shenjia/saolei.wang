// 探针（2026-10-29 晚）：「路线规划」分母候选对比 + 回报率敏感度验证。
//
// 背景（张老师 2026-10-29）：连续 Path 按事件间欧氏累加，鼠标回报率越高 → mv 采样越密
// → 抖动/噪声进得越多，同一轨迹 Path 系统性偏长 → bpp 受录制设备影响、不可比。
//
// 三个候选分母（分子恒为 bbbv）：
//   PATH      = pathPx/16（现行，连续欧氏累加，含 mv 采样）
//   crossings = 鼠标轨迹跨格次数（离散几何，格内抖动不计）
//   Epath     = 相邻两次**有效点击**坐标间的直线距离之和（张老师 2026-10-29 提案，
//               只用点击坐标、完全不看 mv —— 回报率免疫的极端形态；语义 = 选点序列
//               的理想路线长度，即「路线规划」的字面义）
//
// 验证项：
//   ① 回报率敏感度：log(指标) ~ log(bbbv) + log(mvRate) 回归的 mvRate 弹性
//     （mvRate = 有效 mv 事件数/秒 ≈ 采样率代理；弹性应 PATH<0、crossings≈0、Epath≈0）
//   ② 技能区分度：各口径与 STNB 的组内秩相关
//   ③ 3BV 结构依赖：各口径按 bbbv 分桶的中位数（单调上升 = 初级/小图吃亏仍在）
//   ④ 录制格式差异：按文件扩展名（avf=站内录制 / mvf=旧站 / evf=元扫雷）看中位数
//
// 对账铁律同 effpath-probe：插桩机计数（含 pathPx）必须与官方 replayCounts 全等。
//
// 用法：env -u NODE_OPTIONS node --experimental-transform-types \
//        --import ./scripts/sync/ts-extension-loader.mjs scripts/cellpath-probe.ts \
//        [--sample=1500]

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

interface CellCounts {
  clLeft: number; clRight: number; clDouble: number; ce: number;
  unflag: number; pathPx: number; flags: number;
  crossings: number; cellsDistinct: number;
  mvCount: number; epathPx: number; nEff: number;
  won: boolean;
}

/** 插桩版状态机 = replay-core 1:1，额外统计：跨格次数 / 去重格子数 / mv 数 / Epath */
function replayCells(
  width: number, height: number, minesArr: Uint8Array, events: NormEvent[], marksInit: boolean,
): CellCounts {
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
  let pathPx = 0;
  let lastX: number | null = null, lastY: number | null = null;

  // 格子轨迹 + 回报率代理 + Epath
  const visited = new Uint8Array(N);
  let cellsDistinct = 0;
  let crossings = 0;
  let lastCell = -1;
  let mvCount = 0;
  let epathPx = 0;
  let nEff = 0;
  let lastEffX: number | null = null, lastEffY: number | null = null;

  const countCell = (px: number, py: number): number => {
    const cx = Math.floor(px / CELL_PX);
    const cy = Math.floor(py / CELL_PX);
    if (cx < 0 || cx >= W || cy < 0 || cy >= H) return -1;
    const idx = cy * W + cx;
    if (!visited[idx]) { visited[idx] = 1; cellsDistinct++; }
    return idx;
  };

  /** 有效点击落点 → 累加与上一有效点击的直线距离（Epath） */
  const effClick = (px: number, py: number) => {
    nEff++;
    const valid = px > 0 && py > 0 && px < 60000 && py < 60000;
    if (valid) {
      if (lastEffX !== null && lastEffY !== null) {
        epathPx += Math.hypot(px - lastEffX, py - lastEffY);
      }
      lastEffX = px; lastEffY = py;
    }
  };

  let lp = false, lv = false, rp = false, rv = false, sv = false;
  let marks = marksInit;
  let over = false;
  let mineCount = 0;
  for (let i = 0; i < N; i++) if (mines[i]) mineCount++;
  const winAt = N - mineCount;

  for (const e of events) {
    if (over) break;
    if ((e.px !== 0 || e.py !== 0) && e.px < 60000 && e.py < 60000) {
      if (e.ev === "mv") mvCount++;
      if (lastX !== null && lastY !== null) {
        const seg = Math.hypot(e.px - lastX, e.py - lastY);
        pathPx += seg;
        const steps = Math.max(1, Math.ceil(seg * 2)); // 0.5px 步长光栅化
        let prevCell = lastCell;
        for (let t = 0; t <= steps; t++) {
          const px = lastX + ((e.px - lastX) * t) / steps;
          const py = lastY + ((e.py - lastY) * t) / steps;
          const idx = countCell(px, py);
          if (idx < 0) { prevCell = -1; continue; }
          if (idx !== prevCell) { crossings++; prevCell = idx; }
        }
        lastCell = prevCell;
      } else {
        const idx = countCell(e.px, e.py);
        lastCell = idx;
      }
      lastX = e.px;
      lastY = e.py;
    } else {
      lastX = null;
      lastY = null;
      lastCell = -1;
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
          if (ok) effClick(e.px, e.py);
        } else if (lv) {
          clLeft++;
          const ok = openCell(inside ? i : -1);
          if (!ok) wastedLeft++;
          if (ok) effClick(e.px, e.py);
        }
        lp = lv = rv = sv = false;
        break;
      }
      case "rc": {
        if (!lp) {
          if (inside && toggleLabel(i, marks)) {
            clRight++;
            rv = false;
            effClick(e.px, e.py);
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
          if (ok) effClick(e.px, e.py);
        } else if (rv) {
          clRight++;
          wastedRight++;
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
        if (ok) effClick(e.px, e.py);
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
    unflag, pathPx, flags, crossings, cellsDistinct,
    mvCount, epathPx, nEff,
    won: !dead && openedSafe >= winAt,
  };
}

// ---------- 事件行解析（与 effpath-probe 同款） ----------

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

// ---------- 统计工具 ----------

function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}
function quant(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = ((sorted.length - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
/** OLS：ys ~ a + b1*x1 + b2*x2（正规方程 3x3） */
function ols2(xs1: number[], xs2: number[], ys: number[]): { b1: number; b2: number } {
  const n = ys.length;
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const v = [1, xs1[i], xs2[i]];
    for (let r = 0; r < 3; r++) {
      T[r] += v[r] * ys[i];
      for (let c = 0; c < 3; c++) S[r * 3 + c] += v[r] * v[c];
    }
  }
  // 3x3 求解（克莱姆）
  const det =
    S[0] * (S[4] * S[8] - S[5] * S[7]) -
    S[1] * (S[3] * S[8] - S[5] * S[6]) +
    S[2] * (S[3] * S[7] - S[4] * S[6]);
  if (Math.abs(det) < 1e-12) return { b1: 0, b2: 0 };
  const solve = (col: number) => {
    const m = S.slice();
    for (let r = 0; r < 3; r++) m[r * 3 + col] = T[r];
    return (
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[1] * (m[3] * m[8] - m[5] * m[6]) +
      m[2] * (m[3] * m[7] - m[4] * m[6])
    ) / det;
  };
  return { b1: solve(1), b2: solve(2) };
}

// ---------- 主流程 ----------

interface Row { id: bigint; filepath: string; level: string; noflag: number; stnb: number; bbbv: number; realTime: number }

async function main() {
  const args = process.argv.slice(2);
  const getN = (k: string, d: number) => {
    const a = args.find((s) => s.startsWith(`--${k}=`));
    return a ? parseInt(a.split("=")[1], 10) : d;
  };
  const n = getN("sample", 1500);

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT v.id, vi.filepath, vm.level, vm.noflag, vm.stnb, vm.bbbv, vm.real_time realTime
    FROM video v
    JOIN video_info vi ON vi.id = v.id
    JOIN video_metrics vm ON vm.id = v.id
    WHERE v.status = 20 AND vm.path > 0 AND vm.cl > 0 AND vm.bbbv > 0 AND vm.real_time > 0
    ORDER BY RAND() LIMIT ${n * 6}`;

  const buckets: Record<string, number[]> = {
    beg: [0, 6, 9, 12, 15, 18, 22, 27, 999],
    int: [0, 35, 45, 55, 65, 75, 85, 999],
    exp: [0, 120, 140, 160, 180, 200, 225, 999],
  };

  interface G {
    n: number; lost: number; mismatch: number;
    stnb: number[]; bbbv: number[];
    bpp: number[]; cpbpp: number[]; eppb: number[];
    mvRate: number[]; ext: string[];
    cellRatio: number[];
  }
  const groups: Record<string, G> = {};
  for (const lv of ["beg", "int", "exp"]) for (const nf of [0, 1]) {
    groups[`${lv}-${nf ? "NF" : "FL"}`] = { n: 0, lost: 0, mismatch: 0, stnb: [], bbbv: [], bpp: [], cpbpp: [], eppb: [], mvRate: [], ext: [], cellRatio: [] };
  }

  for (const row of rows) {
    const key = `${row.level}-${Number(row.noflag) ? "NF" : "FL"}`;
    const g = groups[key];
    if (!g) continue;
    if (g.n + g.lost + g.mismatch >= n) continue;
    const fp = path.join(VIDEOS, row.filepath);
    let buf: Buffer;
    try { buf = readFileSync(fp); } catch { g.lost++; continue; }
    const ext = path.extname(fp).slice(1).toLowerCase();
    const v = parseVideoBinary(buf, ext);
    if (!v) { g.lost++; continue; }
    const official = replayEvents(v);
    const { evs, mines } = toEvents(v);
    const mine = replayCells(v.width, v.height, mines, evs, v.marks ?? false);
    if (
      mine.clLeft !== official.clLeft || mine.clRight !== official.clRight ||
      mine.clDouble !== official.clDouble || mine.ce !== official.ce ||
      mine.unflag !== official.unflag || mine.pathPx !== official.pathPx ||
      mine.flags !== official.flags || !mine.won
    ) { g.mismatch++; continue; }
    // 2026-10-29 crossings 并入 replay-core 后的回归对账：两套实现必须逐盘全等
    if (mine.crossings !== official.crossings) { g.mismatch++; continue; }
    g.n++;
    const secs = row.realTime / 1000;
    g.bpp.push(row.bbbv / (official.pathPx / CELL_PX));
    g.cpbpp.push(row.bbbv / mine.crossings);
    g.eppb.push(mine.epathPx > 0 ? row.bbbv / (mine.epathPx / CELL_PX) : NaN);
    g.stnb.push(row.stnb);
    g.bbbv.push(row.bbbv);
    g.mvRate.push(mine.mvCount / secs);
    g.ext.push(ext);
    g.cellRatio.push(mine.cellsDistinct / (v.width * v.height));
  }

  const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
  console.log("抽样参数：每组目标 n=" + n);
  for (const [key, g] of Object.entries(groups)) {
    if (g.n < 50) { console.log(`\n== ${key} == 样本不足（n=${g.n}，缺失 ${g.lost}，对账失败 ${g.mismatch}）`); continue; }
    console.log(`\n== ${key}  n=${g.n}（缺失 ${g.lost}，对账失败 ${g.mismatch}）==`);

    // ① 回报率敏感度：log(指标) ~ log(bbbv) + log(mvRate)
    const valid = g.eppb.map((v, i) => (Number.isFinite(v) && Number.isFinite(g.mvRate[i]) && g.mvRate[i] > 0 ? i : -1)).filter((i) => i >= 0);
    const lg = (arr: number[], i: number) => Math.log(arr[i]);
    const rateElasticity = (metric: number[]) => {
      // 过滤 0/Infinity/极端离群（一次 chord 同格 epath≈0 或全程未跨格 crossings=0 会毒化回归）
      const idxs = valid.filter((i) => Number.isFinite(metric[i]) && metric[i] > 0 && metric[i] < 1e4);
      const xs1 = idxs.map((i) => lg(g.bbbv, i));
      const xs2 = idxs.map((i) => lg(g.mvRate, i));
      const ys = idxs.map((i) => Math.log(metric[i]));
      return ols2(xs1, xs2, ys);
    };
    const eBpp = rateElasticity(g.bpp);
    if (key === "beg-FL") {
      const idxs = valid.filter((i) => Number.isFinite(g.bpp[i]) && g.bpp[i] > 0 && g.bpp[i] < 1e4);
      console.log(`  [debug] n=${g.n} valid=${valid.length} idxs=${idxs.length} mvRate[0..5]=${g.mvRate.slice(0, 6).map((v) => v.toFixed(1)).join(",")} bbbv[0..5]=${g.bbbv.slice(0, 6).join(",")} bpp[0..5]=${g.bpp.slice(0, 6).map((v) => v.toPrecision(4)).join(",")} anyNaN_rate=${g.mvRate.some((v) => !Number.isFinite(v))} anyNaN_bpp=${g.bpp.some((v) => !Number.isFinite(v))}`);
    }
    const eCp = rateElasticity(g.cpbpp);
    const eEp = rateElasticity(g.eppb);
    const pctPer2x = (c: number) => ((Math.pow(2, c) - 1) * 100).toFixed(1) + "%";
    console.log(`  mvRate(次/秒): p10 ${quant([...g.mvRate].sort((a, b) => a - b), 10).toFixed(0)} / p50 ${quant([...g.mvRate].sort((a, b) => a - b), 50).toFixed(0)} / p90 ${quant([...g.mvRate].sort((a, b) => a - b), 90).toFixed(0)}`);
    console.log(`  ① 回报率弹性（mvRate 翻倍时指标的变化；负=回报率越高分数越低）:`);
    console.log(`     PATH口径 ${pctPer2x(eBpp.b2)} | crossings ${pctPer2x(eCp.b2)} | Epath ${pctPer2x(eEp.b2)}`);

    // ② 技能区分度
    const vIdx = valid;
    const rc = (metric: number[]) => corr(rank(vIdx.map((i) => metric[i])), rank(vIdx.map((i) => g.stnb[i])));
    console.log(`  ② 秩相关~STNB: PATH ${r3(rc(g.bpp))} | crossings ${r3(rc(g.cpbpp))} | Epath ${r3(rc(g.eppb))}`);

    // ③ bbbv 分桶中位数（结构依赖）
    const edges = buckets[key.split("-")[0]];
    const lines: string[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const idxs: number[] = [];
      for (let k = 0; k < g.bbbv.length; k++) if (g.bbbv[k] >= edges[i] && g.bbbv[k] < edges[i + 1]) idxs.push(k);
      if (idxs.length < 30) continue;
      const med = (metric: number[]) => quant(idxs.map((k) => metric[k]).filter(Number.isFinite).sort((a, b) => a - b), 50);
      lines.push(`[${edges[i]},${edges[i + 1] === 999 ? "∞" : edges[i + 1]}) n=${idxs.length} PATH=${med(g.bpp).toFixed(3)} crossings=${med(g.cpbpp).toFixed(3)} Epath=${med(g.eppb).toFixed(3)}`);
    }
    console.log("  ③ bbbv分桶中位数:\n    " + lines.join("\n    "));

    // ④ 按录制格式
    const exts = [...new Set(g.ext)];
    const extLines: string[] = [];
    for (const ex of exts) {
      const idxs = g.ext.map((e, k) => (e === ex ? k : -1)).filter((k) => k >= 0);
      if (idxs.length < 30) { extLines.push(`${ex}: n=${idxs.length}(略)`); continue; }
      const med = (metric: number[]) => quant(idxs.map((k) => metric[k]).filter(Number.isFinite).sort((a, b) => a - b), 50);
      const medRate = quant(idxs.map((k) => g.mvRate[k]).sort((a, b) => a - b), 50);
      extLines.push(`${ex}: n=${idxs.length} mvRate p50=${medRate.toFixed(0)} PATH=${med(g.bpp).toFixed(3)} crossings=${med(g.cpbpp).toFixed(3)} Epath=${med(g.eppb).toFixed(3)}`);
    }
    console.log("  ④ 按录制格式:\n    " + extLines.join("\n    "));
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
