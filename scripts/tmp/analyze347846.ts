import { readFileSync } from "fs";
import { parseVideoBinary } from "../../src/lib/videoradar";

// 内联 video-triage.ts 的两个纯函数（绕开 @/core 别名依赖）
const EV_LINE = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;
const SENTINEL_PX = 60000;

function pressPairStats(v: { events: string[] }) {
  const presses: { L: number | null; R: number | null } = { L: null, R: null };
  const dursL: number[] = []; const dursR: number[] = [];
  let cl = 0;
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const ts = parseFloat(m[1]) * 1000;
    const ev = m[2];
    if (ev === "lc" || ev === "mc" || ev === "sc") { presses.L = ts; cl++; }
    else if (ev === "rc") { presses.R = ts; cl++; }
    else if (ev === "lr" || ev === "mr") { if (presses.L !== null) { dursL.push(ts - presses.L); presses.L = null; } }
    else if (ev === "rr") { if (presses.R !== null) { dursR.push(ts - presses.R); presses.R = null; } }
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { leftAvg: avg(dursL), leftN: dursL.length, rightAvg: avg(dursR), rightN: dursR.length, cl, dursL };
}

function pathStats(v: { events: string[] }, timeMs: number) {
  let totalPx = 0, jumpsPx = 0, jumpCount = 0;
  let lastPx: number | null = null, lastPy: number | null = null;
  for (const line of v.events) {
    const m = EV_LINE.exec(line);
    if (!m) continue;
    const px = +m[5], py = +m[6];
    if (px >= SENTINEL_PX || py >= SENTINEL_PX || px < 0 || py < 0) { lastPx = null; lastPy = null; continue; }
    if (lastPx !== null && lastPy !== null) {
      const d = Math.hypot(px - lastPx, py - lastPy);
      totalPx += d;
      if (d > 100) { jumpsPx += d; jumpCount++; }
    }
    lastPx = px; lastPy = py;
  }
  return { totalPx, jumpsPx, jumpCount, totalCells: Math.round(totalPx / 16), cellsPerSec: Math.round(totalPx / 16) / (timeMs / 1000) };
}

const buf = new Uint8Array(readFileSync("/tmp/347846.evf"));
const v = parseVideoBinary(buf, "evf");
if (!v) { console.log("PARSE FAIL"); process.exit(0); }
console.log("=== basic ===");
console.log("software:", v.software, "| version:", v.version);
console.log("bbbv:", v.bbbv, "| timeTime:", v.timeMs, "| events:", v.events.length);
const ps = pressPairStats(v);
console.log("=== press ===");
console.log("leftAvg:", ps.leftAvg, "leftN:", ps.leftN, "rightAvg:", ps.rightAvg, "rightN:", ps.rightN, "cl:", ps.cl);
if (ps.dursL && ps.dursL.length) console.log("dursL(ms):", ps.dursL.join(","));
const pj = pathStats(v, 9930);
console.log("=== path ===");
console.log("totalCells:", pj.totalCells, "cellsPerSec:", pj.cellsPerSec.toFixed(2), "jumpCount:", pj.jumpCount);
console.log("=== all events (" + v.events.length + ") ===");
console.log(v.events.join("\n"));
