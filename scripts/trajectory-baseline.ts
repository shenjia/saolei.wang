// 人类基线定标：按软件×级别分层抽样已过审免核定盘，计算非人类操作特征候选的正常分布
// 只读不写库。跑法：env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/trajectory-baseline.ts [每格抽样数]
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const EV = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;
const SENT = 60000;
const PER_CELL = +(process.argv[2] ?? 120);

interface Feat {
  id: number; software: string; level: string;
  clicks: number; mv: number; mvPerClick: number | null;
  mvMinDt: number | null; mvP5Dt: number | null;
  pressN: number; pressAvg: number | null; pressStd: number | null; pressDistinct: number;
  zeroPressFrac: number | null; // 0ms 配对占全部按下比
  offDistinct: number; offStd: number | null;
  clickCv: number | null;
  mvClickDelayCv: number | null; mvClickDelayDistinct: number;
  angEntropy: number | null; ang45Frac: number | null;
  timeMs: number;
}

function feats(id: number, software: string, level: string, buf: Uint8Array, ext: string, timeMs: number): Feat | null {
  const v = parseVideoBinary(buf, ext);
  if (!v) return null;
  type E = { ts: number; ev: string; x: number; y: number };
  const evs: E[] = [];
  for (const line of v.events) {
    const m = EV.exec(line);
    if (!m) continue;
    evs.push({ ts: parseFloat(m[1]) * 1000, ev: m[2], x: +m[5], y: +m[6] });
  }
  const clicks = evs.filter((e) => ["lc", "rc", "mc", "sc"].includes(e.ev));
  const mv = evs.filter((e) => e.ev === "mv");

  // mv 间隔
  const mdts: number[] = [];
  for (let i = 1; i < mv.length; i++) mdts.push(mv[i].ts - mv[i - 1].ts);
  const q = (arr: number[], p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  const mvSorted = [...mdts].sort((a, b) => a - b);

  // press 配对（同刻 0ms 不计时长，但计 zeroFrac 分子）
  const presses: { L: number | null; R: number | null } = { L: null, R: null };
  const durs: number[] = []; let totalPress = 0, zero = 0;
  for (const e of evs) {
    if (e.ev === "lc" || e.ev === "mc" || e.ev === "sc") { presses.L = e.ts; totalPress++; }
    else if (e.ev === "rc") { presses.R = e.ts; totalPress++; }
    else if (e.ev === "lr" || e.ev === "mr") {
      if (presses.L !== null) { const d = e.ts - presses.L; if (d === 0) zero++; else if (d > 0) durs.push(d); presses.L = null; }
    } else if (e.ev === "rr") {
      if (presses.R !== null) { const d = e.ts - presses.R; if (d === 0) zero++; else if (d > 0) durs.push(d); presses.R = null; }
    }
  }
  const avg = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
  const std = durs.length > 1 && avg !== null ? Math.sqrt(durs.reduce((s, x) => s + (x - avg) ** 2, 0) / durs.length) : null;

  // 点击格内偏移（x+y 各自）
  const offs: number[] = [];
  for (const c of clicks) { offs.push(c.x % 16, c.y % 16); }
  const offDistinct = new Set(offs).size;
  const offAvg = offs.length ? offs.reduce((a, b) => a + b, 0) / offs.length : 0;
  const offStd = offs.length > 1 ? Math.sqrt(offs.reduce((s, x) => s + (x - offAvg) ** 2, 0) / offs.length) : null;

  // 点击间隔 CV
  const cis: number[] = [];
  for (let i = 1; i < clicks.length; i++) cis.push(clicks[i].ts - clicks[i - 1].ts);
  const ciAvg = cis.length ? cis.reduce((a, b) => a + b, 0) / cis.length : null;
  const ciCv = ciAvg && ciAvg > 0 && cis.length > 1 ? Math.sqrt(cis.reduce((s, x) => s + (x - ciAvg) ** 2, 0) / cis.length) / ciAvg : null;

  // mv→click 延迟（每次点击距上一次 mv 的时长）CV 与取值数
  const delays: number[] = [];
  let j = 0; // mv 指针
  for (const c of clicks) {
    while (j < mv.length && mv[j].ts <= c.ts) j++;
    if (j > 0) delays.push(c.ts - mv[j - 1].ts);
  }
  const dAvg = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
  const dCv = dAvg !== null && dAvg > 0 && delays.length > 1 ? Math.sqrt(delays.reduce((s, x) => s + (x - dAvg) ** 2, 0) / delays.length) / dAvg : null;

  // 方向角
  const pts = evs.filter((e) => e.x < SENT && e.y < SENT && e.x >= 0 && e.y >= 0);
  const angHist = new Map<number, number>();
  let nonzero = 0, diag = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    if (Math.hypot(dx, dy) < 0.5) continue;
    nonzero++;
    const a = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    angHist.set(a, (angHist.get(a) ?? 0) + 1);
    if (Math.abs(a % 45) === 0) diag++;
  }
  const H = nonzero ? -[...angHist.values()].reduce((acc, n) => { const p = n / nonzero; return acc + (p > 0 ? p * Math.log2(p) : 0); }, 0) : null;

  return {
    id, software, level,
    clicks: clicks.length, mv: mv.length,
    mvPerClick: clicks.length ? mv.length / clicks.length : null,
    mvMinDt: mvSorted.length ? mvSorted[0] : null,
    mvP5Dt: q(mvSorted, 0.05),
    pressN: durs.length, pressAvg: avg !== null ? Math.round(avg) : null, pressStd: std !== null ? Math.round(std) : null,
    pressDistinct: new Set(durs).size,
    zeroPressFrac: totalPress ? zero / totalPress : null,
    offDistinct, offStd: offStd !== null ? +offStd.toFixed(2) : null,
    clickCv: ciCv !== null ? +ciCv.toFixed(3) : null,
    mvClickDelayCv: dCv !== null ? +dCv.toFixed(3) : null,
    mvClickDelayDistinct: new Set(delays).size,
    angEntropy: H !== null ? +H.toFixed(2) : null,
    ang45Frac: nonzero ? +(diag / nonzero).toFixed(3) : null,
    timeMs,
  };
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  // 可选 WHERE 追加（env BASELINE_WHERE，如 "v.create_time>1764000000"），用于近期新上传子集定标
  const where = process.env.BASELINE_WHERE ?? "1=1";
  const strata = await prisma.$queryRawUnsafe<{ software: string; level: string }[]>(`
    SELECT vi.software, v.level FROM video v JOIN video_info vi ON vi.id=v.id
    WHERE v.status=20 AND v.auto_flag=1 AND vi.software IN ('Arbiter','Clone','Vienna','Saolei.wang','元扫雷')
      AND ${where}
    GROUP BY vi.software, v.level
  `);
  const all: Feat[] = [];
  let readFail = 0, parseFail = 0;
  for (const { software, level } of strata) {
    const rows = await prisma.$queryRawUnsafe<{ id: bigint; filepath: string; real_time: number }[]>(`
      SELECT * FROM (
        SELECT v.id, vi.filepath, vi.real_time FROM video v JOIN video_info vi ON vi.id=v.id
        WHERE v.status=20 AND v.auto_flag=1 AND vi.software='${software}' AND v.level='${level}' AND ${where}
        ORDER BY RAND() LIMIT ${PER_CELL * 4}
      ) t ORDER BY RAND() LIMIT ${PER_CELL}
    `);
    const got: Feat[] = [];
    for (const r of rows) {
      try {
        const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
        if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; continue; }
        const buf = readFileSync(full);
        const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
        const f = feats(Number(r.id), software, level, new Uint8Array(buf), ext, r.real_time);
        if (!f) { parseFail++; continue; }
        got.push(f);
      } catch { readFail++; }
    }
    all.push(...got);

    const pick = (sel: (f: Feat) => number | null) => got.map(sel).filter((x): x is number => x !== null);
    console.log(`\n== ${software} ${level} (n=${got.length}) ==`);
    console.log(`  clicks: p5=${pct(pick((f) => f.clicks), 0.05)} p50=${pct(pick((f) => f.clicks), 0.5)}`);
    console.log(`  mv: p5=${pct(pick((f) => f.mv), 0.05)} p50=${pct(pick((f) => f.mv), 0.5)}`);
    console.log(`  mvPerClick: p1=${pct(pick((f) => f.mvPerClick), 0.01).toFixed(2)} p5=${pct(pick((f) => f.mvPerClick), 0.05).toFixed(2)} p50=${pct(pick((f) => f.mvPerClick), 0.5).toFixed(2)}`);
    console.log(`  mvMinDt: p50=${pct(pick((f) => f.mvMinDt), 0.5)} p95=${pct(pick((f) => f.mvMinDt), 0.95)} max=${Math.max(...pick((f) => f.mvMinDt))}`);
    console.log(`  pressStd: p1=${pct(pick((f) => f.pressStd), 0.01)} p5=${pct(pick((f) => f.pressStd), 0.05)}`);
    console.log(`  pressDistinct: p1=${pct(pick((f) => f.pressDistinct), 0.01)} p5=${pct(pick((f) => f.pressDistinct), 0.05)}`);
    console.log(`  zeroPressFrac: p50=${pct(pick((f) => f.zeroPressFrac), 0.5).toFixed(3)} p95=${pct(pick((f) => f.zeroPressFrac), 0.95).toFixed(3)} p99=${pct(pick((f) => f.zeroPressFrac), 0.99).toFixed(3)}`);
    console.log(`  offDistinct(clicks>=30): p1=${pct(got.filter((f) => f.clicks >= 30).map((f) => f.offDistinct), 0.01)} p5=${pct(got.filter((f) => f.clicks >= 30).map((f) => f.offDistinct), 0.05)}`);
    console.log(`  offStd(clicks>=30): p1=${pct(got.filter((f) => f.clicks >= 30).map((f) => f.offStd ?? -1).filter((x) => x >= 0), 0.01)} p5=${pct(got.filter((f) => f.clicks >= 30).map((f) => f.offStd ?? -1).filter((x) => x >= 0), 0.05)}`);
    console.log(`  clickCv: p1=${pct(pick((f) => f.clickCv), 0.01).toFixed(2)} p5=${pct(pick((f) => f.clickCv), 0.05).toFixed(2)}`);
    console.log(`  mvClickDelayCv: p1=${pct(pick((f) => f.mvClickDelayCv), 0.01).toFixed(2)} p5=${pct(pick((f) => f.mvClickDelayCv), 0.05).toFixed(2)}`);
    console.log(`  mvClickDelayDistinct: p1=${pct(pick((f) => f.mvClickDelayDistinct), 0.01)}`);
    console.log(`  ang45Frac: p95=${pct(pick((f) => f.ang45Frac), 0.95).toFixed(2)} max=${Math.max(...pick((f) => f.ang45Frac))}`);
  }
  console.log(`\n合计 ${all.length} 盘，读失败 ${readFail} 解析失败 ${parseFail}`);
  // 全量明细落盘供后查
  const { writeFileSync } = await import("fs");
  writeFileSync("/tmp/trajectory-baseline.json", JSON.stringify(all, null, 1));
  console.log("明细已写 /tmp/trajectory-baseline.json");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
