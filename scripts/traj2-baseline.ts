// 人类基线定标 v2（traj2）：针对 360420 型「带抖动合成流」候选触发器的人类分布
//   1. IDLE_GAP_MODE   空闲间隔（release→下一 press）精确众数占比 / Top2 占比
//   2. TURN_SMOOTH     mv 段内相邻步进转角 std 的 p50（完美弧线 → 段内转角恒定）
//   3. SPEED_ENVELOPE  段内 vmax/vmean 分布（ease-in-out 包络 → 无匀速滑行段）
// 只读不写库。跑法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/traj2-baseline.ts [每格抽样数]
// 可选 env TRAJ2_WHERE 追加 WHERE（近期上传子集定标）。
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const EV = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;
const SENT = 60000;
const PER_CELL = +(process.argv[2] ?? 120);

interface E { ts: number; ev: string; x: number; y: number }

export interface Traj2Stats {
  clicks: number; mv: number;
  idleN: number; idleModeMs: number; idleModeShare: number; idleTop2Share: number;
  idleWinShare: number; idleWinLo: number;
  turnNSeg: number; turnP50: number | null; turnP90: number | null;
  vsN: number; vsMin: number | null; vsP10: number | null; vsGlideFrac: number | null;
}

/** 三组候选指标（与 traj2-probe 同口径；供分拣器实现对照） */
export function traj2Stats(evs: E[]): Traj2Stats {
  const presses = evs.filter((e) => ["lc", "rc", "mc", "sc"].includes(e.ev));
  const releases = evs.filter((e) => ["lr", "rr", "mr"].includes(e.ev));
  const mvs = evs.filter((e) => e.ev === "mv");

  // 空闲间隔：press[i] 与其前最近一次 release 的间隔（要求该 release 晚于前一 press）
  const idle: number[] = [];
  let ri = 0;
  for (let i = 1; i < presses.length; i++) {
    while (ri + 1 < releases.length && releases[ri + 1].ts <= presses[i].ts) ri++;
    if (releases[ri] && releases[ri].ts > presses[i - 1].ts && releases[ri].ts <= presses[i].ts)
      idle.push(presses[i].ts - releases[ri].ts);
  }
  const h = new Map<number, number>();
  for (const g of idle) h.set(g, (h.get(g) ?? 0) + 1);
  const counts = [...h.values()].sort((a, b) => b - a);
  const idleModeShare = idle.length ? counts[0]! / idle.length : 0;
  const idleTop2Share = idle.length ? (counts[0]! + (counts[1] ?? 0)) / idle.length : 0;
  let idleModeMs = 0;
  for (const [v, n] of h) if (n === counts[0]) { idleModeMs = v; break; }
  // 50ms 滑窗聚集度：仅统计下沿 ≥150ms 的窗（长间隔区间的聚集；短间隔节奏点击不计）
  let idleWinShare = 0, idleWinLo = 0;
  if (idle.length) {
    for (let lo = 150; lo <= 600; lo += 10) {
      const c = idle.filter((g) => g >= lo && g < lo + 50).length;
      if (c / idle.length > idleWinShare) { idleWinShare = c / idle.length; idleWinLo = lo; }
    }
  }

  // 段：连续 mv（被点击事件打断）
  const segs: E[][] = []; let cur: E[] = [];
  for (const e of evs) { if (e.ev === "mv") cur.push(e); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);

  // 转角 std：段内相邻步进（≥2px）方向变化的标准差（弧线 → 恒定转角 → 小 std）
  const turnStds: number[] = [];
  for (const s of segs) {
    const moves: [number, number][] = [];
    for (let i = 1; i < s.length; i++) {
      if (s[i].x >= SENT || s[i - 1].x >= SENT) continue;
      const dx = s[i].x - s[i - 1].x, dy = s[i].y - s[i - 1].y;
      if (Math.hypot(dx, dy) >= 2) moves.push([dx, dy]);
    }
    if (moves.length < 4) continue;
    const ta: number[] = [];
    for (let i = 1; i < moves.length; i++) {
      let d = Math.atan2(moves[i][1], moves[i][0]) - Math.atan2(moves[i - 1][1], moves[i - 1][0]);
      if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      ta.push(d);
    }
    const m = ta.reduce((a, b) => a + b, 0) / ta.length;
    turnStds.push(Math.sqrt(ta.reduce((s2, x) => s2 + (x - m) ** 2, 0) / ta.length));
  }
  const tq = (p: number) => { const s = [...turnStds].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null; };

  // 速度形状：段内 vmax/vmean（直距≥8px、≥5 采样）
  const ratios: number[] = [];
  for (const s of segs) {
    if (s.length < 5) continue;
    if (s.at(-1)!.x >= SENT || s[0].x >= SENT) continue;
    const straight = Math.hypot(s.at(-1)!.x - s[0].x, s.at(-1)!.y - s[0].y);
    if (straight < 8) continue;
    const vels: number[] = [];
    for (let i = 1; i < s.length; i++) {
      const dt = Math.max(1, s[i].ts - s[i - 1].ts);
      vels.push(Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y) / dt);
    }
    ratios.push(Math.max(...vels) / Math.max(0.01, vels.reduce((a, b) => a + b, 0) / vels.length));
  }
  const rq = (p: number) => { const s = [...ratios].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? null; };

  return {
    clicks: presses.length, mv: mvs.length,
    idleN: idle.length, idleModeMs, idleModeShare, idleTop2Share, idleWinShare, idleWinLo,
    turnNSeg: turnStds.length, turnP50: tq(0.5), turnP90: tq(0.9),
    vsN: ratios.length, vsMin: rq(0), vsP10: rq(0.1),
    vsGlideFrac: ratios.length ? ratios.filter((r) => r <= 1.2).length / ratios.length : null,
  };
}

export function parseEvents(v: { events: string[] }): E[] {
  const evs: E[] = [];
  for (const line of v.events) {
    const m = EV.exec(line);
    if (m) evs.push({ ts: parseFloat(m[1]) * 1000, ev: m[2], x: +m[5], y: +m[6] });
  }
  return evs;
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(arr.length * p))];
}

async function main() {
  const where = process.env.TRAJ2_WHERE ?? "1=1";
  const strata = await prisma.$queryRawUnsafe<{ software: string; level: string }[]>(`
    SELECT vi.software, v.level FROM video v JOIN video_info vi ON vi.id=v.id
    WHERE v.status=20 AND v.auto_flag=1 AND vi.software IN ('Arbiter','Clone','Vienna','Saolei.wang','元扫雷')
      AND ${where}
    GROUP BY vi.software, v.level
  `);
  const all: { id: number; software: string; level: string; ext: string; s: Traj2Stats }[] = [];
  let readFail = 0, parseFail = 0;
  for (const { software, level } of strata) {
    const rows = await prisma.$queryRawUnsafe<{ id: bigint; filepath: string }[]>(`
      SELECT * FROM (
        SELECT v.id, vi.filepath FROM video v JOIN video_info vi ON vi.id=v.id
        WHERE v.status=20 AND v.auto_flag=1 AND vi.software='${software}' AND v.level='${level}' AND ${where}
        ORDER BY RAND() LIMIT ${PER_CELL * 4}
      ) t ORDER BY RAND() LIMIT ${PER_CELL}
    `);
    const got: Traj2Stats[] = [];
    for (const r of rows) {
      try {
        const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
        if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; continue; }
        const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
        const v = parseVideoBinary(new Uint8Array(readFileSync(full)), ext);
        if (!v) { parseFail++; continue; }
        const s = traj2Stats(parseEvents(v));
        got.push(s);
        all.push({ id: Number(r.id), software, level, ext, s });
      } catch { readFail++; }
    }
    console.log(`\n== ${software} ${level} (n=${got.length}) ==`);
    const idle = got.filter((s) => s.idleN >= 40);
    if (idle.length) console.log(`  idle众数占比(n≥40, ${idle.length}): p50=${pct(idle.map((s) => s.idleModeShare), 0.5).toFixed(3)} p95=${pct(idle.map((s) => s.idleModeShare), 0.95).toFixed(3)} p99=${pct(idle.map((s) => s.idleModeShare), 0.99).toFixed(3)} max=${Math.max(...idle.map((s) => s.idleModeShare)).toFixed(3)} | Top2 p99=${pct(idle.map((s) => s.idleTop2Share), 0.99).toFixed(3)} max=${Math.max(...idle.map((s) => s.idleTop2Share)).toFixed(3)}`);
    const win = idle.filter((s) => s.idleWinLo >= 150);
    if (win.length) console.log(`  idle50ms窗(n≥40, ${win.length}): p95=${pct(win.map((s) => s.idleWinShare), 0.95).toFixed(3)} p99=${pct(win.map((s) => s.idleWinShare), 0.99).toFixed(3)} max=${Math.max(...win.map((s) => s.idleWinShare)).toFixed(3)} | 众数≥180ms 子集 max=${Math.max(0, ...idle.filter((s) => s.idleModeMs >= 180).map((s) => s.idleWinShare)).toFixed(3)}`);
    const turn = got.filter((s) => s.turnNSeg >= 20);
    if (turn.length) console.log(`  转角stdP50(nSeg≥20, ${turn.length}): min=${Math.min(...turn.map((s) => s.turnP50!)).toFixed(3)} p1=${pct(turn.map((s) => s.turnP50!), 0.01).toFixed(3)} p5=${pct(turn.map((s) => s.turnP50!), 0.05).toFixed(3)} p50=${pct(turn.map((s) => s.turnP50!), 0.5).toFixed(3)} | P90max=${Math.max(...turn.map((s) => s.turnP90!)).toFixed(3)}`);
    const vs = got.filter((s) => s.vsN >= 50);
    if (vs.length) console.log(`  vshape(vsN≥50, ${vs.length}): p10min=${Math.min(...vs.map((s) => s.vsP10!)).toFixed(2)} p10p1=${pct(vs.map((s) => s.vsP10!), 0.01).toFixed(2)} min=${Math.min(...vs.map((s) => s.vsMin!)).toFixed(2)} | 匀速段占比p95=${pct(vs.map((s) => s.vsGlideFrac!), 0.95).toFixed(3)}`);
  }
  console.log(`\n合计 ${all.length} 盘，读失败 ${readFail} 解析失败 ${parseFail}`);
  const { writeFileSync } = await import("fs");
  writeFileSync("/tmp/traj2-baseline.json", JSON.stringify(all, null, 1));
  console.log("明细已写 /tmp/traj2-baseline.json");
}

if (process.argv[1]?.includes("traj2-baseline")) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
