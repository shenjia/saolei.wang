// 轨迹探针：解剖单盘录像事件流，输出非人类操作特征候选（只读，不写库）
// 跑法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/trajectory-probe.ts <file> <ext>
import { readFileSync } from "fs";

import { parseVideoBinary } from "../src/lib/videoradar";

const EV = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;

interface Ev { ts: number; ev: string; x: number; y: number }

function main() {
  const [file, ext] = process.argv.slice(2);
  const v = parseVideoBinary(new Uint8Array(readFileSync(file)), ext);
  if (!v) { console.error("parse fail"); process.exit(1); }
  console.log(`size=${v.width}x${v.height} events=${v.events.length} timeMs=${v.timeMs} bbbv=${v.bbbv} noflag=${v.noflag}`);

  const evs: Ev[] = [];
  for (const line of v.events) {
    const m = EV.exec(line);
    if (!m) continue;
    evs.push({ ts: parseFloat(m[1]) * 1000, ev: m[2], x: +m[5], y: +m[6] });
  }

  // 1. 事件类型计数
  const cnt = new Map<string, number>();
  for (const e of evs) cnt.set(e.ev, (cnt.get(e.ev) ?? 0) + 1);
  console.log("事件计数:", [...cnt.entries()].map(([k, n]) => `${k}=${n}`).join(" "));

  // 2. mv 间隔 dt 分布（采样节律）
  const mv = evs.filter((e) => e.ev === "mv");
  const dts: number[] = [];
  for (let i = 1; i < mv.length; i++) dts.push(mv[i].ts - mv[i - 1].ts);
  if (dts.length) {
    const sorted = [...dts].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const uniq = new Set(dts).size;
    console.log(`mv n=${mv.length} dt: min=${sorted[0]} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} p95=${q(0.95)} max=${sorted[sorted.length - 1]} 去重后${uniq}种`);
  }

  // 3. 逐段位移方向角直方图（转向熵）+ 共线检测
  // 段=相邻 mv（含点击）对，哨兵坐标断链
  const SENT = 60000;
  const pts = evs.filter((e) => e.x < SENT && e.y < SENT && e.x >= 0 && e.y >= 0);
  const segs: { dx: number; dy: number; d: number; dt: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    const d = Math.hypot(dx, dy);
    segs.push({ dx, dy, d, dt: pts[i].ts - pts[i - 1].ts });
  }
  // 非零位移段的方向角（度，量化到 1 度）
  const angHist = new Map<number, number>();
  let nonzero = 0;
  for (const s of segs) {
    if (s.d < 0.5) continue;
    nonzero++;
    const a = Math.round((Math.atan2(s.dy, s.dx) * 180) / Math.PI);
    angHist.set(a, (angHist.get(a) ?? 0) + 1);
  }
  const angles = [...angHist.entries()].sort((a, b) => b[1] - a[1]);
  const H = -[...angHist.values()].reduce((acc, n) => {
    const p = n / nonzero; return acc + (p > 0 ? p * Math.log2(p) : 0);
  }, 0);
  console.log(`方向角：非零段${nonzero} 唯一角度${angHist.size} 熵=${H.toFixed(2)}bit top8=${angles.slice(0, 8).map(([a, n]) => `${a}°×${n}`).join(" ")}`);

  // 4. 共线率：连续三采样点严格落在一条直线（cross product≈0）
  let collinear = 0, triples = 0;
  for (let i = 2; i < pts.length; i++) {
    const a = pts[i - 2], b = pts[i - 1], c = pts[i];
    const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
    if (Math.hypot(abx, aby) < 0.5 || Math.hypot(bcx, bcy) < 0.5) continue;
    triples++;
    const cross = Math.abs(abx * bcy - aby * bcx);
    if (cross < 1e-6) collinear++;
  }
  console.log(`严格共线：${collinear}/${triples} = ${triples ? ((collinear / triples) * 100).toFixed(1) : 0}%`);

  // 5. 主对角/轴向占比（0°/45°/90°/135° 等 45° 倍数）
  const diag = angles.filter(([a]) => Math.abs(a % 45) === 0).reduce((s, [, n]) => s + n, 0);
  console.log(`45°倍数方向段占比：${nonzero ? ((diag / nonzero) * 100).toFixed(1) : 0}%`);

  // 6. 点击坐标的格内偏移分布（8px=半格，16px=格）
  const clicks = evs.filter((e) => ["lc", "rc", "mc", "sc"].includes(e.ev));
  const offX = new Map<number, number>(), offY = new Map<number, number>();
  for (const c of clicks) {
    const ox = c.x % 16, oy = c.y % 16;
    offX.set(ox, (offX.get(ox) ?? 0) + 1);
    offY.set(oy, (offY.get(oy) ?? 0) + 1);
  }
  console.log(`点击 n=${clicks.length} 格内x偏移 top=${[...offX.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o, n]) => `${o}×${n}`).join(" ")}`);
  console.log(`         格内y偏移 top=${[...offY.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o, n]) => `${o}×${n}`).join(" ")}`);

  // 7. press-release 配对（复用口径：同刻 0ms 不计）
  const presses: { L: number | null; R: number | null } = { L: null, R: null };
  const dursL: number[] = [], dursR: number[] = [];
  for (const e of evs) {
    if (e.ev === "lc" || e.ev === "mc" || e.ev === "sc") presses.L = e.ts;
    else if (e.ev === "rc") presses.R = e.ts;
    else if (e.ev === "lr" || e.ev === "mr") { if (presses.L !== null) { const d = e.ts - presses.L; if (d > 0) dursL.push(d); presses.L = null; } }
    else if (e.ev === "rr") { if (presses.R !== null) { const d = e.ts - presses.R; if (d > 0) dursR.push(d); presses.R = null; } }
  }
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const std = (a: number[]) => (a.length > 1 ? Math.round(Math.sqrt(a.reduce((s, x) => s + (x - a.reduce((u, v) => u + v, 0) / a.length) ** 2, 0) / a.length)) : null);
  console.log(`press L: n=${dursL.length} avg=${avg(dursL)}ms std=${std(dursL)}ms | press R: n=${dursR.length} avg=${avg(dursR)}ms std=${std(dursR)}ms`);

  // 8. 段速率分布（位移/时间）与匀速性：相邻段速率比
  const spd = segs.filter((s) => s.dt > 0 && s.d > 0.5).map((s) => s.d / s.dt);
  if (spd.length) {
    const sorted = [...spd].sort((a, b) => a - b);
    const cv = sorted.length > 1 ? Math.sqrt(sorted.reduce((s, x) => s + (x - sorted.reduce((u, v) => u + v, 0) / sorted.length) ** 2, 0) / sorted.length) / (sorted.reduce((u, v) => u + v, 0) / sorted.length) : 0;
    console.log(`段速率 px/ms: p50=${sorted[Math.floor(sorted.length / 2)].toFixed(3)} max=${sorted[sorted.length - 1].toFixed(3)} 变异系数=${cv.toFixed(2)}`);
  }

  // 9. 重复路径段检测：连续 N 点序列是否在整局中重复出现（模拟器固定回放痕迹）
  // 用坐标序列 8-gram 哈希粗查
  const seq = pts.map((p) => `${p.x},${p.y}`);
  const grams = new Map<string, number>();
  for (let i = 0; i + 8 <= seq.length; i++) {
    const k = seq.slice(i, i + 8).join(">");
    grams.set(k, (grams.get(k) ?? 0) + 1);
  }
  const dup = [...grams.values()].filter((n) => n > 1).length;
  const dupInstances = [...grams.values()].reduce((s, n) => s + Math.max(0, n - 1), 0);
  console.log(`8-gram 路径重复：去重后${dup}种坐标串出现>1次，多实例合计${dupInstances}（总gram=${grams.size}）`);

  // 10. 首 60 行事件预览
  console.log("--- 前 60 事件 ---");
  for (const e of evs.slice(0, 60)) console.log(`${(e.ts / 1000).toFixed(3)} ${e.ev} ${e.x} ${e.y}`);
}

main();
