// P0 全量回测定标：录像自动分拣触发器分布报告（2026-10-19 方案 v2）
//
// 跑法（项目根）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/video-triage-backtest.ts [年份起点]
//
// 对 2026 年（默认）status=20 录像全量重放：
//   1. press-release 配对时长（左/右分开，n 守卫敏感性 n≥10/20/30）
//   2. 各触发器命中分布 + 组合后的免核定/需核定比例
//   3. ppc / 点击数下限 / 首击延迟三信号校准（只报分布不判定）
// 输出：控制台报告 + /tmp/triage-backtest-report.json（明细 per-trigger 命中 id 清单）

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { parseVideoBinary } from "../src/lib/videoradar";
import { prisma } from "../src/lib/db";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const sinceYear = Number(process.argv[2] ?? 2026);

// ---------- press-release 配对统计（与 lib/video-triage.ts 同口径；此处先内联，定稿后收敛进 lib） ----------
const EV = /^(-?[\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;

interface PressStats {
  leftAvg: number | null;
  leftN: number;
  rightAvg: number | null;
  rightN: number;
  firstEvTs: number | null;
  cl: number;
}

function pressStats(events: string[]): PressStats {
  const presses: Record<"L" | "R", number> = { L: -1, R: -1 };
  const dursL: number[] = [];
  const dursR: number[] = [];
  let firstEvTs: number | null = null;
  let cl = 0;
  for (const line of events) {
    const m = EV.exec(line);
    if (!m) continue;
    const ts = parseFloat(m[1]) * 1000;
    const ev = m[2];
    if (firstEvTs === null) firstEvTs = ts;
    if (ev === "lc" || ev === "mc" || ev === "sc") {
      presses.L = ts;
      cl++;
    } else if (ev === "rc") {
      presses.R = ts;
      cl++;
    } else if (ev === "lr" || ev === "mr") {
      if (presses.L >= 0) {
        dursL.push(ts - presses.L);
        presses.L = -1;
      }
    } else if (ev === "rr") {
      if (presses.R >= 0) {
        dursR.push(ts - presses.R);
        presses.R = -1;
      }
    }
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    leftAvg: avg(dursL), leftN: dursL.length,
    rightAvg: avg(dursR), rightN: dursR.length,
    firstEvTs, cl,
  };
}

// ---------- STNB 阈值（定稿候选：p99 取整上浮） ----------
const STNB_TRIGGER: Record<string, number> = { beg: 205, int: 160, exp: 150 };

// ---------- 主流程 ----------
async function main() {
  const t0 = Date.now();
  const rows = await prisma.$queryRawUnsafe<{
    id: bigint; filepath: string; level: string; noflag: number;
    real_time: number; board_3bv: number; stnb: number | null;
    cls: number | null; path: number | null; ppc: number | null; cl: number | null;
  }[]>(
    `SELECT v.id, vi.filepath, v.level, vi.noflag, vi.real_time, vi.board_3bv,
            vm.stnb, vm.cls, vm.path, vm.ppc, vm.cl
     FROM video v JOIN video_info vi ON vi.id = v.id
     LEFT JOIN video_metrics vm ON vm.id = v.id
     WHERE v.create_time >= UNIX_TIMESTAMP(?) AND v.status = 20`,
    `${sinceYear}-01-01`
  );
  console.log(`样本 ${rows.length} 盘（${sinceYear} 年起 status=20）`);

  const hits = {
    press60_n30: [] as number[], press60_n20: [] as number[], press60_n10: [] as number[],
    stnb: [] as number[], cls: [] as number[], path0: [] as number[],
    ppc05: [] as number[], clickFloor: [] as number[],
    parseFail: [] as number[], noFile: [] as number[],
  };
  // 分级明细：press 命中分布 + 人类 leftAvg 分位（定分级阈值用）
  const perLevel: Record<string, { press60: number[]; leftAvgs: number[]; total: number }> = {};
  const flagged = new Set<number>(); // 任一触发器命中（去重合计）
  // ppc/点击数/首击 分布校准桶
  const ppcDeciles: number[] = [];
  const clickRatio: number[] = []; // cl / bbbv
  const firstTs: number[] = [];
  const leftAvgAll: number[] = [];

  let done = 0;
  for (const r of rows) {
    done++;
    if (done % 1000 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    const id = Number(r.id);
    let buf: Buffer | null = null;
    try {
      const full = path.join(VIDEOS_ROOT, r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) continue;
      buf = readFileSync(full);
    } catch {
      hits.noFile.push(id);
      continue;
    }
    const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(new Uint8Array(buf), ext);
    if (!v) {
      hits.parseFail.push(id);
      continue;
    }
    const ps = pressStats(v.events);
    if (ps.leftAvg !== null) leftAvgAll.push(ps.leftAvg);

    const lv = perLevel[r.level] ?? (perLevel[r.level] = { press60: [], leftAvgs: [], total: 0 });
    lv.total++;
    if (ps.leftAvg !== null) lv.leftAvgs.push(ps.leftAvg);

    // press ≤60ms（三档守卫）
    const leftHit = ps.leftAvg !== null && ps.leftAvg <= 60;
    const rightHit = ps.rightAvg !== null && ps.rightAvg <= 60 && ps.rightN >= 30;
    if (leftHit || rightHit) {
      lv.press60.push(id);
      if (ps.leftN >= 30 || ps.rightN >= 30) hits.press60_n30.push(id);
      if (ps.leftN >= 20 || ps.rightN >= 20) hits.press60_n20.push(id);
      if (ps.leftN >= 10 || ps.rightN >= 10) hits.press60_n10.push(id);
    }
    // STNB
    if (r.stnb !== null && r.stnb > (STNB_TRIGGER[r.level] ?? Infinity)) hits.stnb.push(id);
    // cls
    if (r.cls !== null && r.cls > 10) hits.cls.push(id);
    // path
    if (r.path !== null && r.path === 0 && (r.cl ?? 0) > 20) hits.path0.push(id);
    // 校准桶（不判定）
    if (r.ppc !== null && (r.cl ?? 0) > 50) ppcDeciles.push(r.ppc);
    if (r.cl !== null && r.board_3bv > 0) clickRatio.push(r.cl / r.board_3bv);
    if (ps.firstEvTs !== null) firstTs.push(ps.firstEvTs);
    if (ps.cl > 0 && r.board_3bv > 0 && ps.cl < r.board_3bv * 0.8) hits.clickFloor.push(id);
    if (r.ppc !== null && r.ppc < 0.5 && (r.cl ?? 0) > 50) hits.ppc05.push(id);
  }

  // 任一触发器命中合计（press 取 n30 口径 + stnb/cls/path0/ppc05/clickFloor + 解析失败）
  for (const id of [...hits.press60_n30, ...hits.stnb, ...hits.cls, ...hits.path0, ...hits.ppc05, ...hits.clickFloor, ...hits.parseFail]) {
    flagged.add(id);
  }

  const q = (arr: number[], p: number) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) * p)] : null;
  };
  const n = rows.length;
  const pct = (x: number) => `${(100 * x / n).toFixed(2)}%`;

  const report = {
    since: sinceYear, sample: n, elapsedSec: Math.round((Date.now() - t0) / 1000),
    flaggedTotal: { count: flagged.size, pct: pct(flagged.size) },
    perLevel: Object.fromEntries(
      Object.entries(perLevel).map(([lv, d]) => {
        const s = d.leftAvgs.slice().sort((a, b) => a - b);
        return [lv, {
          total: d.total,
          press60_hit: d.press60.length,
          leftAvg_p1: q(s, 0.01), leftAvg_p5: q(s, 0.05), leftAvg_p50: q(s, 0.5),
        }];
      })
    ),
    hits: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, { count: v.length, pct: pct(v.length), ids: v.slice(0, 50) }])),
    calibration: {
      leftAvgMs: { p1: q(leftAvgAll, 0.01), p5: q(leftAvgAll, 0.05), p50: q(leftAvgAll, 0.5), min: leftAvgAll.length ? Math.min(...leftAvgAll) : null },
      ppc: { p1: q(ppcDeciles, 0.01), p5: q(ppcDeciles, 0.05), p50: q(ppcDeciles, 0.5), min: ppcDeciles.length ? Math.min(...ppcDeciles) : null },
      clickRatio: { p1: q(clickRatio, 0.01), p5: q(clickRatio, 0.05), min: clickRatio.length ? Math.min(...clickRatio) : null },
    },
  };
  writeFileSync("/tmp/triage-backtest-report.json", JSON.stringify(report, null, 2));

  console.log("\n===== 触发器命中（" + n + " 盘）=====");
  for (const [k, v] of Object.entries(hits)) console.log(`  ${k}: ${v.length} (${pct(v.length)})`);
  console.log("\n===== 校准分位 =====");
  console.log(JSON.stringify(report.calibration, null, 2));
  console.log("\n报告已写 /tmp/triage-backtest-report.json");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
