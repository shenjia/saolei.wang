// 全站 path 异常扫描（2026-10-23，张老师指令：找出与 347022 同款「超大范围往返瞬移」的录像）
//
// 跑法（生产 /home/deploy/saolei.wang，后台）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/path-anomaly-scan.ts [--dry]
//
// 原理：347022 与三盘已屏蔽盘实证同一模式——相邻事件 >100px 瞬移占总行程 60%+，
//      且瞬移方向左右对称（往返）。正常人类盘（含 ppc 高到 300+ 的慢局）瞬移占比
//      极低（实测最高 34%，无往返对称）。
// 判定：瞬移行程占比 >50% 即异常（保守线，四盘嫌疑 61%~85%，正常盘最高 34%）。
// 输出：控制台报告 + /tmp/path-anomaly-scan-report.json

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";
import { AUTO_REASON, PATH_SPEED_TRIGGER, PATH_SPEED_MIN_TIME_MS } from "../src/lib/video-triage-limits";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const EV = /^([\d.]+) (mv|lc|lr|rc|rr|mc|mr|sc|mt) (\d+) (\d+) \((\d+) (\d+)\)/;
/** 瞬移判定：相邻事件位移超过此像素数 */
const JUMP_PX = 100;
/** 异常判定：瞬移贡献行程占比超过此比例 */
const JUMP_RATIO_TRIGGER = 0.5;
/** 守卫：总行程低于此格数不判（分母太小，短局偶发瞬移会虚高占比） */
const MIN_PATH_CELLS = 200;
/** rmv 解析器哨兵坐标（Vienna 格式越界哨兵 ~65523，259991/274037 实证）——按无效样本丢弃 */
const SENTINEL_PX = 60000;
/** 守卫：瞬移密度低于此次/秒不判（人类慢局思考期也会偶发大跳，81983 实证：
 *  987s 里 34 跳=0.03/s 且集中在 4s+ 停顿；四盘确认异常盘全在 2.1~4.8/s） */
const MIN_JUMPS_PER_SEC = 0.5;
/** 守卫：瞬移次数下限 */
const MIN_JUMPS = 10;

interface Row {
  id: bigint;
  level: string;
  status: number;
  ppc: number | null;
  path: number | null;
  realTime: number | null;
  user: bigint;
  chineseName: string | null;
  filepath: string;
}

async function fetchCandidates(): Promise<Row[]> {
  // 粗筛：ppc>4（覆盖往返瞬移形态）或 path/秒>20（覆盖超速形态；阈值远低于
  // 触发线 30，给 rmv 哨兵污染盘留余量）。PATH_SPEED 需要 ≥30s 长局，SQL 同步约束。
  return prisma.$queryRawUnsafe<Row[]>(`
    SELECT m.id, v.level, v.status, m.ppc, m.path, vi.real_time AS realTime,
           v.user, u.chinese_name, vi.filepath
    FROM video_metrics m
    JOIN video v ON v.id = m.id
    JOIN video_info vi ON vi.id = m.id
    LEFT JOIN user u ON u.id = v.user
    WHERE m.ppc > 4 OR (vi.real_time >= 30000 AND m.path / (vi.real_time / 1000) > 20)
    ORDER BY m.id ASC
  `);
}

interface ScanResult {
  id: number;
  status: number;
  level: string;
  user: number;
  name: string | null;
  ppc: number | null;
  path: number | null;
  jumpRatio: number;
  jumpCount: number;
  totalPathCells: number;
  clicks: number;
  jumpsPathCells: number;
  events: number;
  cellsPerSec: number;
  triggers: number[];
}

async function main() {
  const dry = process.argv.includes("--dry");
  const rows = await fetchCandidates();
  console.log(`粗筛 ppc>4 共 ${rows.length} 盘，开始逐文件精算…`);

  const results: ScanResult[] = [];
  let readFail = 0, parseFail = 0, done = 0;
  const t0 = Date.now();

  for (const r of rows) {
    done++;
    if (done % 1000 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    let buf: Buffer;
    try {
      const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; continue; }
      buf = readFileSync(full);
    } catch { readFail++; continue; }

    const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(new Uint8Array(buf), ext);
    if (!v) { parseFail++; continue; }

    // 事件流逐对位移（真实时长用库内 real_time——rmv 文件内 Time 恒 0）
    const timeMs = r.realTime ?? v.timeMs;
    let totalPx = 0, jumpsPx = 0, jumpCount = 0, clicks = 0, events = 0;
    let lastPx: number | null = null, lastPy: number | null = null;
    for (const line of v.events) {
      const m = EV.exec(line);
      if (!m) continue;
      events++;
      const px = +m[5], py = +m[6], ev = m[2];
      if (px >= SENTINEL_PX || py >= SENTINEL_PX || px < 0 || py < 0) {
        // 哨兵/无效坐标：断开位移链（不计入相邻对），避免 rmv 哨兵虚增行程
        lastPx = null; lastPy = null;
        continue;
      }
      if (ev === "lc" || ev === "rc" || ev === "mc" || ev === "sc") clicks++;
      if (lastPx !== null && lastPy !== null) {
        const d = Math.hypot(px - lastPx, py - lastPy);
        totalPx += d;
        if (d > JUMP_PX) { jumpsPx += d; jumpCount++; }
      }
      lastPx = px; lastPy = py;
    }
    const totalCells = Math.round(totalPx / 16);
    const hitSpeed = timeMs >= PATH_SPEED_MIN_TIME_MS && totalCells / (timeMs / 1000) > PATH_SPEED_TRIGGER;
    const hitJump =
      totalPx >= MIN_PATH_CELLS * 16 &&
      jumpCount >= MIN_JUMPS &&
      jumpCount / (timeMs / 1000) >= MIN_JUMPS_PER_SEC &&
      jumpsPx / totalPx > JUMP_RATIO_TRIGGER;

    if (hitJump || hitSpeed) {
      results.push({
        id: Number(r.id), status: r.status, level: r.level,
        user: Number(r.user), name: r.chineseName,
        ppc: r.ppc, path: r.path,
        jumpRatio: jumpsPx > 0 ? Math.round((jumpsPx / totalPx) * 1000) / 1000 : 0,
        jumpCount, totalPathCells: totalCells,
        jumpsPathCells: Math.round(jumpsPx / 16), clicks, events,
        cellsPerSec: Math.round((totalCells / (timeMs / 1000)) * 10) / 10,
        triggers: [hitJump ? AUTO_REASON.PATH_JUMP : 0, hitSpeed ? AUTO_REASON.PATH_SPEED : 0].filter(Boolean),
      });
      console.log(`⚠️ id=${r.id} status=${r.status} ${r.level} ${r.chineseName ?? "?"} 行程=${totalCells}格 ${(totalCells / (timeMs / 1000)).toFixed(1)}格/s 瞬移占=${totalPx ? ((jumpsPx / totalPx) * 100).toFixed(0) : 0}%(${jumpCount}次) [${hitJump ? "PATH_JUMP " : ""}${hitSpeed ? "PATH_SPEED" : ""}]`);
    }
  }

  results.sort((a, b) => b.cellsPerSec - a.cellsPerSec);
  console.log(`\n===== 扫描结果 =====`);
  console.log(`扫描 ${rows.length} 盘（ppc>4 或 ≥30s且>20格/s），读失败 ${readFail}，解析失败 ${parseFail}`);
  console.log(`异常盘（PATH_JUMP 瞬移占比>${JUMP_RATIO_TRIGGER * 100}% / PATH_SPEED ≥30s 且 >${PATH_SPEED_TRIGGER}格/s）共 ${results.length} 盘:`);
  const byStatus = new Map<number, ScanResult[]>();
  for (const x of results) { const a = byStatus.get(x.status) ?? []; a.push(x); byStatus.set(x.status, a); }
  for (const [st, arr] of [...byStatus.entries()].sort()) {
    console.log(`  status=${st}: ${arr.length} 盘`);
    for (const x of arr) {
      console.log(`    id=${x.id} ${x.level} ${x.name ?? "?"}(uid=${x.user}) 行程${x.totalPathCells}格 ${x.cellsPerSec}格/s 瞬移占${(x.jumpRatio * 100).toFixed(0)}%(${x.jumpCount}次) [${x.triggers.map((t) => t === AUTO_REASON.PATH_JUMP ? "PATH_JUMP" : "PATH_SPEED").join("+")}]`);
    }
  }

  writeFileSync("/tmp/path-anomaly-scan-report.json", JSON.stringify({
    scanned: rows.length, readFail, parseFail, trigger: JUMP_RATIO_TRIGGER, jumpPx: JUMP_PX,
    speedTrigger: PATH_SPEED_TRIGGER, anomalies: results,
  }, null, 2));
  console.log(`报告已写 /tmp/path-anomaly-scan-report.json（${dry ? "dry 模式未写库" : "本脚本只读不写库"}）`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
