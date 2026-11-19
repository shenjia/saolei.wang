// 候选触发器指标探针：对指定录像文件计算四组「动力学指纹」候选指标
//   1. 点击节拍聚集：press-to-press 间隔 / release-to-press 空闲间隔 的精确众数占比
//   2. 轨迹转角恒定：mv 段内相邻步进转角 std（分位）
//   3. 速度形状：段内 vmax/vmean——无匀速滑行段 = 全部段带钟形加减速包络
//   4. 停稳再点：按下时刻距前一 mv 的延迟（人类常边移动边点，合成器停稳后再点）
// 用法: jiti scripts/traj2-probe.ts <file>...
import { readFileSync } from "node:fs";
import { parseVideoBinary } from "../src/lib/videoradar";

const SENT = 60000;
interface E { ts: number; ev: string; x: number; y: number }

function load(file: string) {
  const ext = file.split(".").pop()!.toLowerCase();
  const v = parseVideoBinary(new Uint8Array(readFileSync(file)), ext);
  if (!v) throw new Error(`parse fail: ${file}`);
  const evs: E[] = [];
  for (const line of v.events) {
    const m = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/.exec(line);
    if (m) evs.push({ ts: parseFloat(m[1]) * 1000, ev: m[2], x: +m[5], y: +m[6] });
  }
  return { file, evs };
}

const mode = (a: number[]) => {
  const h = new Map<number, number>();
  for (const x of a) h.set(x, (h.get(x) ?? 0) + 1);
  let mv = 0, mc = 0;
  for (const [v, n] of h) if (n > mc) { mc = n; mv = v; }
  return { value: mv, count: mc, share: a.length ? mc / a.length : 0 };
};

// 段：连续 mv 事件（被点击事件打断）
function segsOf(evs: E[]): E[][] {
  const segs: E[][] = []; let cur: E[] = [];
  for (const e of evs) { if (e.ev === "mv") cur.push(e); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);
  return segs;
}

function turnStd(segs: E[][]) {
  const per: number[] = [];
  for (const s of segs) {
    const moves: [number, number][] = [];
    for (let i = 1; i < s.length; i++) {
      const dx = s[i].x - s[i - 1].x, dy = s[i].y - s[i - 1].y;
      if (Math.hypot(dx, dy) >= 2 && s[i].x < SENT && s[i - 1].x < SENT) moves.push([dx, dy]);
    }
    if (moves.length < 4) continue;
    const ta: number[] = [];
    for (let i = 1; i < moves.length; i++) {
      let d = Math.atan2(moves[i][1], moves[i][0]) - Math.atan2(moves[i - 1][1], moves[i - 1][0]);
      if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      ta.push(d);
    }
    const m = ta.reduce((a, b) => a + b, 0) / ta.length;
    per.push(Math.sqrt(ta.reduce((s2, x) => s2 + (x - m) ** 2, 0) / ta.length));
  }
  const q = (p: number) => { const s = [...per].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
  return { nSeg: per.length, p50: q(0.5), p90: q(0.9) };
}

function vshape(segs: E[][]) {
  const ratios: number[] = [];
  for (const s of segs) {
    if (s.length < 5) continue;
    const straight = Math.hypot(s.at(-1)!.x - s[0].x, s.at(-1)!.y - s[0].y);
    if (straight < 8 || s.at(-1)!.x >= SENT || s[0].x >= SENT) continue;
    const vels: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const dt = Math.max(1, s[i].ts - s[i - 1].ts);
      vels.push(Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y) / dt);
    }
    ratios.push(Math.max(...vels) / Math.max(0.01, vels.reduce((a, b) => a + b, 0) / vels.length));
  }
  const sorted = [...ratios].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
  return { n: ratios.length, min: sorted[0] ?? NaN, p10: q(0.1), glideFrac: ratios.filter((r) => r <= 1.2).length / Math.max(1, ratios.length) };
}

for (const file of process.argv.slice(2)) {
  const { evs } = load(file);
  const presses = evs.filter((e) => ["lc", "rc", "mc", "sc"].includes(e.ev));
  const releases = evs.filter((e) => ["lr", "rr", "mr"].includes(e.ev));

  // press-to-press 间隔 & release-to-press 空闲间隔
  const p2p: number[] = [];
  for (let i = 1; i < presses.length; i++) p2p.push(presses[i].ts - presses[i - 1].ts);
  const idle: number[] = [];
  let ri = 0;
  for (let i = 1; i < presses.length; i++) {
    // presses[i] 前最近一次 release
    while (ri + 1 < releases.length && releases[ri + 1].ts <= presses[i].ts) ri++;
    if (releases[ri] && releases[ri].ts > presses[i - 1].ts && releases[ri].ts <= presses[i].ts)
      idle.push(presses[i].ts - releases[ri].ts);
  }
  const mp = mode(p2p), mi = mode(idle);

  // 按下前 30/50ms 内有 mv 的占比（边移动边点）
  const mvs = evs.filter((e) => e.ev === "mv");
  let mv30 = 0, mv50 = 0, settleHist = new Map<number, number>();
  let j = 0;
  for (const c of presses) {
    while (j < mvs.length && mvs[j].ts <= c.ts) j++;
    const last = mvs[j - 1];
    if (last) {
      const d = c.ts - last.ts;
      if (d >= 0 && d <= 30) mv30++;
      if (d >= 0 && d <= 50) mv50++;
      if (d >= 40 && d <= 400) settleHist.set(Math.round(d / 10) * 10, (settleHist.get(Math.round(d / 10) * 10) ?? 0) + 1);
    }
  }
  const settleTop = [...settleHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const segs = segsOf(evs);
  const t = turnStd(segs), vs = vshape(segs);
  const name = file.split("/").pop()!;
  console.log(`${name.slice(0, 46).padEnd(46)} clicks=${presses.length}`);
  console.log(`  p2p间隔: n=${p2p.length} 众数=${mp.value}ms×${mp.count}(${(mp.share * 100).toFixed(1)}%)`);
  console.log(`  空闲间隔: n=${idle.length} 众数=${mi.value}ms×${mi.count}(${(mi.share * 100).toFixed(1)}%)`);
  console.log(`  转角std: nSeg=${t.nSeg} p50=${t.p50.toFixed(3)} p90=${t.p90.toFixed(3)}`);
  console.log(`  速度形状: n=${vs.n} min=${vs.min.toFixed(2)} p10=${vs.p10.toFixed(2)} 匀速段占比=${(vs.glideFrac * 100).toFixed(1)}%`);
  console.log(`  边移边点: 30ms内mv ${(mv30 / presses.length * 100).toFixed(1)}% / 50ms内mv ${(mv50 / presses.length * 100).toFixed(1)}%  停稳延迟Top: ${settleTop.map(([d, n]) => `${d}ms×${n}`).join(" ")}`);
}
