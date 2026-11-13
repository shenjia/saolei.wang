// 分拣触发器 v2 全量命中清单（2026-11-13，张老师指令「列出来慢慢处理」）：
// 全站单遍扫描，导出 bit17/18/19/23 新命中（库内无该位码）的全部录像明细 +
// bit24 账号聚合命中用户的完整窗口盘，按用户聚合输出。
// 不写库、不改 auto_flag——只出清单，处置由张老师人工决定。
//
// 跑法（生产后台）:
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/triage-v2-fulllist.ts
// 输出: /tmp/triage-v2-fulllist.json（videos 全明细 + users 聚合）+ 控制台摘要

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";
import { humanLikeStats, humanLikeTriggers, pressPairStats, pressTriggers } from "../src/lib/video-triage";
import { AUTO_REASON, ACCOUNT_PRESS_SCAN_LIMIT } from "../src/lib/video-triage-limits";
import { RANKED_SOFTWARE } from "../src/lib/evfwrite";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

const NAMES: [number, string][] = [
  [AUTO_REASON.PATH_SPARSE, "bit17"],
  [AUTO_REASON.PATH_DT, "bit18"],
  [AUTO_REASON.PRESS_UNIFORM, "bit19"],
  [AUTO_REASON.SHORT_PRESS, "bit23"],
];

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
  real_time: number;
  board_3bv: number;
  stnb: number | null;
  chinese_name: string | null;
}

interface VideoHit {
  id: number; uid: number; name: string | null; level: string; status: number;
  software: string; rt_s: number; bv3: number; stnb: number | null;
  L_n: number; L_avg: number | null; R_n: number; R_avg: number | null;
  sigma: number | null; mvPerClick: number | null; bits: string[];
}

async function main() {
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT v.id, v.user, v.level, v.status, v.auto_flag, v.auto_reason,
            vi.software, vi.evf_sig, vi.filepath, vi.real_time, vi.board_3bv,
            m.stnb, u.chinese_name
     FROM video v JOIN video_info vi ON vi.id=v.id
     LEFT JOIN video_metrics m ON m.id=v.id LEFT JOIN user u ON u.id=v.user
     ORDER BY v.user ASC, v.id DESC`
  );
  console.log(`扫描 ${rows.length} 盘…`);

  const videos: VideoHit[] = [];
  const byUser = new Map<string, { ids: bigint[]; reps: number[]; name: string | null }>();
  let readFail = 0, parseFail = 0, done = 0;
  const t0 = Date.now();

  for (const r of rows) {
    done++;
    if (done % 20000 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 60000).toFixed(1)}min)`);
    const uk = String(r.user);
    let agg = byUser.get(uk);
    if (!agg) { agg = { ids: [], reps: [], name: r.chinese_name }; byUser.set(uk, agg); }
    if (agg.ids.length < ACCOUNT_PRESS_SCAN_LIMIT) agg.ids.push(r.id);

    let v;
    try {
      const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; agg.reps.push(NaN); continue; }
      v = parseVideoBinary(new Uint8Array(readFileSync(full)), r.filepath.split(".").pop()?.toLowerCase() ?? "");
    } catch { readFail++; agg.reps.push(NaN); continue; }
    if (!v) { parseFail++; agg.reps.push(NaN); continue; }

    const clientOwned = r.software === RANKED_SOFTWARE || r.evf_sig !== null;
    const ps = pressPairStats(v);
    const hl = humanLikeStats(v);
    const bits =
      humanLikeTriggers(hl, r.software, clientOwned) |
      pressTriggers(ps, r.level);
    // press 代表时长（bit24 口径：可统计键 n≥10 取更低者）
    const keys: number[] = [];
    if (ps.leftAvg !== null && ps.leftN >= 10) keys.push(ps.leftAvg);
    if (ps.rightAvg !== null && ps.rightN >= 10) keys.push(ps.rightAvg);
    agg.reps.push(keys.length ? Math.min(...keys) : NaN);

    const newBits = bits & ~r.auto_reason; // 只列库内尚未标记的（已有位=已知案底）
    if (!newBits) continue;
    const hitNames = NAMES.filter(([b]) => newBits & b).map(([, n]) => n);
    videos.push({
      id: Number(r.id), uid: Number(r.user), name: r.chinese_name, level: r.level,
      status: r.status, software: r.software, rt_s: +(r.real_time / 1000).toFixed(1),
      bv3: r.board_3bv, stnb: r.stnb,
      L_n: ps.leftN, L_avg: ps.leftAvg !== null ? +ps.leftAvg.toFixed(0) : null,
      R_n: ps.rightN, R_avg: ps.rightAvg !== null ? +ps.rightAvg.toFixed(0) : null,
      sigma: hl.pressStd !== null ? +hl.pressStd.toFixed(1) : null,
      mvPerClick: hl.mvPerClick !== null ? +hl.mvPerClick.toFixed(2) : null,
      bits: hitNames,
    });
  }

  // bit24 聚合
  const acctUsers: { uid: number; name: string | null; usable: number; medianMs: number | null; videoIds: number[] }[] = [];
  for (const [uk, agg] of byUser) {
    const usable = agg.reps.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (usable.length < 3) continue;
    const mid = Math.floor(usable.length / 2);
    const median = usable.length % 2 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2;
    if (median > 40) continue;
    acctUsers.push({ uid: Number(uk), name: agg.name, usable: usable.length, medianMs: Math.round(median), videoIds: agg.ids.map(Number) });
  }

  // 按用户聚合摘要（命中盘数降序）
  const byUid = new Map<number, VideoHit[]>();
  for (const x of videos) {
    const a = byUid.get(x.uid) ?? [];
    a.push(x); byUid.set(x.uid, a);
  }
  const userSummary = [...byUid.entries()]
    .map(([uid, vs]) => ({ uid, name: vs[0]!.name, hits: vs.length, bits: vs.flatMap((v) => v.bits).filter((b, i, a2) => a2.indexOf(b) === i), statuses: vs.map((v) => v.status).filter((s, i, a2) => a2.indexOf(s) === i) }))
    .sort((a, b) => b.hits - a.hits);

  console.log(`\n===== 命中清单（读失败 ${readFail} 解析失败 ${parseFail}）=====`);
  console.log(`新命中录像 ${videos.length} 盘 / ${byUid.size} 用户；bit24 账号命中 ${acctUsers.length} 用户`);
  console.log(`\n用户聚合（命中盘数降序，前 40）：`);
  console.log(`uid\t姓名\t命中盘\t位码\t状态`);
  for (const u of userSummary.slice(0, 40)) {
    console.log(`${u.uid}\t${u.name ?? "?"}\t${u.hits}\t${u.bits.join("+")}\t[${u.statuses.join(",")}]`);
  }
  console.log(`\nbit24 账号（中位按压 ≤40ms）：`);
  console.log(`uid\t姓名\t可统计盘\t中位ms`);
  for (const u of acctUsers.sort((a, b) => (a.medianMs ?? 999) - (b.medianMs ?? 999))) {
    console.log(`${u.uid}\t${u.name ?? "?"}\t${u.usable}\t${u.medianMs}`);
  }

  writeFileSync("/tmp/triage-v2-fulllist.json", JSON.stringify({ scanned: Number(rows.length), readFail, parseFail, videos, acctUsers, userSummary }, null, 1));
  console.log(`\n全量明细已写 /tmp/triage-v2-fulllist.json（videos ${videos.length} 行）`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
