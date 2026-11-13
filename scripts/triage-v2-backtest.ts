// 分拣触发器 v2 全站回测（2026-11-13，四项改动上线前定标）：
//   ① bit17 站内客户端/老 Clone 豁免改数值守卫（mv/点击 <1.56/1.7 豁免失效）
//   ② bit19 PRESS_UNIFORM 线 5→8ms
//   ③ bit23 SHORT_PRESS 短局超快按压（n≥15 且 avg≤30ms）
//   ④ bit24 ACCOUNT_PRESS 账号按压聚合（最近 30 盘可统计 ≥3 且中位 ≤40ms）
// 单遍扫描本地全站录像：每盘解析一次，bit17~23 逐盘判；bit24 按用户分组聚合。
// 输出各触发器命中 × status 分桶（status=20 已通过盘 = 误报候选，需逐盘复核）。
//
// 跑法: env -u NODE_OPTIONS node --experimental-transform-types \
//         --import ./scripts/sync/ts-extension-loader.mjs scripts/triage-v2-backtest.ts
// 只读不写库。报告写 /tmp/triage-v2-backtest.json

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";
import { humanLikeStats, humanLikeTriggers, pressPairStats, pressTriggers } from "../src/lib/video-triage";
import { AUTO_REASON, PRESS_SHORT_MIN_PAIRS } from "../src/lib/video-triage-limits";
import { RANKED_SOFTWARE } from "../src/lib/evfwrite";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

interface Row {
  id: bigint;
  user: bigint;
  level: string;
  status: number;
  auto_flag: number;
  auto_reason: number;
  software: string;
  evf_sig: string | null;
  filepath: string;
  chinese_name: string | null;
}

const NAMES: [number, string][] = [
  [AUTO_REASON.PATH_SPARSE, "bit17_PATH_SPARSE"],
  [AUTO_REASON.PATH_DT, "bit18_PATH_DT"],
  [AUTO_REASON.PRESS_UNIFORM, "bit19_PRESS_UNIFORM(8ms)"],
  [AUTO_REASON.CLICK_OFFSET, "bit20_CLICK_OFFSET"],
  [AUTO_REASON.ZERO_PRESS, "bit21_ZERO_PRESS"],
  [AUTO_REASON.GAP_MODE, "bit22_GAP_MODE"],
  [AUTO_REASON.SHORT_PRESS, "bit23_SHORT_PRESS"],
];

async function main() {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT v.id, v.user, v.level, v.status, v.auto_flag, v.auto_reason, vi.software, vi.evf_sig, vi.filepath, u.chinese_name
     FROM video v JOIN video_info vi ON vi.id=v.id LEFT JOIN user u ON u.id=v.user
     ORDER BY v.user ASC, v.id DESC`
  );
  console.log(`回测 ${rows.length} 盘…`);

  // bits[userKey] = { id, perBits }（每盘命中集合，bit24 单独聚合）
  type PerVideo = { id: bigint; user: string; level: string; status: number; autoReason: number; name: string | null; bits: number };
  const perVideo: PerVideo[] = [];
  const byUser = new Map<string, { ids: bigint[]; reps: number[] }>();
  let readFail = 0, parseFail = 0, done = 0;
  const t0 = Date.now();

  for (const r of rows) {
    done++;
    if (done % 20000 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 60000).toFixed(1)}min)`);
    const uk = String(r.user);
    let agg = byUser.get(uk);
    if (!agg) { agg = { ids: [], reps: [] }; byUser.set(uk, agg); }
    if (agg.ids.length < 30) agg.ids.push(r.id);

    let v;
    try {
      const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; agg.reps.push(NaN); continue; }
      v = parseVideoBinary(new Uint8Array(readFileSync(full)), r.filepath.split(".").pop()?.toLowerCase() ?? "");
    } catch { readFail++; agg.reps.push(NaN); continue; }
    if (!v) { parseFail++; agg.reps.push(NaN); continue; }

    const clientOwned = r.software === RANKED_SOFTWARE || r.evf_sig !== null;
    const ps = pressPairStats(v);
    const bits =
      humanLikeTriggers(humanLikeStats(v), r.software, clientOwned) |
      pressTriggers(ps, r.level);
    if (bits) perVideo.push({ id: r.id, user: uk, level: r.level, status: r.status, autoReason: r.auto_reason, name: r.chinese_name, bits });
    const keys: number[] = [];
    if (ps.leftAvg !== null && ps.leftN >= PRESS_SHORT_MIN_PAIRS) keys.push(ps.leftAvg);
    if (ps.rightAvg !== null && ps.rightN >= PRESS_SHORT_MIN_PAIRS) keys.push(ps.rightAvg);
    agg.reps.push(keys.length ? Math.min(...keys) : NaN);
  }

  // bit24 聚合
  const rowByKey = new Map<string, Row>();
  for (const r of rows) rowByKey.set(`${r.user}:${r.id}`, r);
  const acctHits: { id: number; user: number; status: number; usable: number; median: number }[] = [];
  for (const [uk, agg] of byUser) {
    const usable = agg.reps.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (usable.length < 3) continue;
    const mid = Math.floor(usable.length / 2);
    const median = usable.length % 2 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2;
    if (median > 40) continue;
    for (const id of agg.ids) {
      const row = rowByKey.get(`${uk}:${id}`);
      acctHits.push({ id: Number(id), user: Number(uk), status: row?.status ?? -1, usable: usable.length, median: Math.round(median) });
    }
  }

  // 报告：分桶区分「库内已有该位」（历史补判/上传时已判，含管理员看过仍通过的）
  // 与「本次新命中」（库内无该位 = 若是已通过盘即真·误报候选）
  const bucket = (p: { status: number; autoReason: number }, bit: number) => {
    const st = p.status === 20 ? "passed20" : p.status === 10 ? "pending10" : p.status === 0 ? "blocked0" : `s${p.status}`;
    return (p.autoReason & bit) ? `${st}+已有位` : `${st}+新命中`;
  };
  const report: Record<string, Record<string, number>> = {};
  const samples: Record<string, unknown[]> = {};
  for (const [bit, name] of NAMES) {
    report[name] = {};
    samples[name] = [];
    for (const p of perVideo) {
      if (!(p.bits & bit)) continue;
      const b = bucket(p, bit);
      report[name][b] = (report[name][b] ?? 0) + 1;
      if (p.status === 20 && !(p.autoReason & bit) && samples[name].length < 300) {
        samples[name].push({ id: Number(p.id), level: p.level, user: Number(p.user), name: p.name, bits: p.bits });
      }
    }
  }
  report["bit24_ACCOUNT_PRESS"] = {};
  samples["bit24_ACCOUNT_PRESS"] = [];
  for (const h of acctHits) {
    const row = rowByKey.get(`${h.user}:${h.id}`);
    const ar = row?.auto_reason ?? 0;
    const b = bucket({ status: h.status, autoReason: ar }, AUTO_REASON.ACCOUNT_PRESS);
    report["bit24_ACCOUNT_PRESS"][b] = (report["bit24_ACCOUNT_PRESS"][b] ?? 0) + 1;
    if (h.status === 20 && !(ar & AUTO_REASON.ACCOUNT_PRESS) && samples["bit24_ACCOUNT_PRESS"].length < 300) {
      samples["bit24_ACCOUNT_PRESS"].push({ ...h, name: row?.chinese_name ?? null });
    }
  }

  console.log(`\n===== 回测结果（读失败 ${readFail} 解析失败 ${parseFail}）=====`);
  for (const name of [...NAMES.map(([, n]) => n), "bit24_ACCOUNT_PRESS"]) {
    const total = Object.values(report[name]).reduce((s, n) => s + n, 0);
    console.log(`${name}: 共 ${total} → ${JSON.stringify(report[name])}`);
  }
  const passedUsers = new Set(acctHits.filter((h) => h.status === 20).map((h) => h.user));
  console.log(`bit24 命中用户数 ${new Set(acctHits.map((h) => h.user)).size}，其中含已通过盘的用户 ${passedUsers.size} 个`);
  writeFileSync("/tmp/triage-v2-backtest.json", JSON.stringify({ scanned: Number(rows.length), readFail, parseFail, report, samples }, null, 2));
  console.log(`明细已写 /tmp/triage-v2-backtest.json`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
