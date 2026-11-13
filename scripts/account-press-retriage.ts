// 账号按压聚合触发器（bit24，2026-11-13 沈正刚 28122 案）存量补判：
// 按用户分组单遍扫描全站录像（每盘只读文件/解析一次，~3ms），对每个用户取
// 最近 ACCOUNT_PRESS_SCAN_LIMIT 盘算 press 代表时长（可统计键 n≥15 取更低者），
// 可统计盘 ≥ACCOUNT_PRESS_MIN_VIDEOS 且中位数 ≤ACCOUNT_PRESS_MEDIAN_MS →
// 该用户窗口内全部录像增量 OR bit24 并转需核定（auto_flag 0）。
//
// 与上传链路 triageVideo 的口径差异：上传时对「当前账号最近 30 盘」（含当前盘）
// 现算；本脚本对「此刻账号最近 30 盘」回溯打标——窗口随时间滚动，历史时点的
// 窗口不可复原，按当前状态补判（28122 型批量上传账号恰好整批落在窗口内）。
//
// 跑法（本地 / 生产，后台 nohup）:
//   扫描（只报不写）: env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/account-press-retriage.ts
//   落库: 同上 + --apply

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";
import { pressPairStats } from "../src/lib/video-triage";
import {
  ACCOUNT_PRESS_SCAN_LIMIT,
  ACCOUNT_PRESS_MIN_VIDEOS,
  ACCOUNT_PRESS_MEDIAN_MS,
  PRESS_SHORT_MIN_PAIRS,
  AUTO_REASON,
} from "../src/lib/video-triage-limits";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

interface Row {
  id: bigint;
  user: bigint;
  status: number;
  auto_flag: number;
  auto_reason: number;
  filepath: string;
  chinese_name: string | null;
}

interface UserAgg {
  ids: bigint[];
  reps: number[];
  name: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT v.id, v.user, v.status, v.auto_flag, v.auto_reason, vi.filepath, u.chinese_name
     FROM video v JOIN video_info vi ON vi.id=v.id LEFT JOIN user u ON u.id=v.user
     ORDER BY v.user ASC, v.id DESC`
  );
  console.log(`待扫 ${rows.length} 盘${apply ? "（--apply 落库）" : "（只报不写）"}…`);

  const byUser = new Map<string, UserAgg>();
  let readFail = 0, parseFail = 0, done = 0;
  const t0 = Date.now();
  for (const r of rows) {
    done++;
    if (done % 20000 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 60000).toFixed(1)}min)`);
    const key = String(r.user);
    let agg = byUser.get(key);
    if (!agg) { agg = { ids: [], reps: [], name: r.chinese_name }; byUser.set(key, agg); }
    if (agg.ids.length >= ACCOUNT_PRESS_SCAN_LIMIT) continue; // 窗口已满，后续更老的盘不再入窗
    agg.ids.push(r.id);
    // 文件解析只为算 press；窗口外的盘不解析（上面 continue 先行），窗口内的盘恰好都要算
    let buf: Buffer;
    try {
      const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; agg.reps.push(NaN); continue; }
      buf = readFileSync(full);
    } catch { readFail++; agg.reps.push(NaN); continue; }
    const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(new Uint8Array(buf), ext);
    if (!v) { parseFail++; agg.reps.push(NaN); continue; }
    const ps = pressPairStats(v);
    const keys: number[] = [];
    if (ps.leftAvg !== null && ps.leftN >= PRESS_SHORT_MIN_PAIRS) keys.push(ps.leftAvg);
    if (ps.rightAvg !== null && ps.rightN >= PRESS_SHORT_MIN_PAIRS) keys.push(ps.rightAvg);
    agg.reps.push(keys.length ? Math.min(...keys) : NaN);
  }

  // 聚合判定 + 落库
  const rowById = new Map<string, Row>();
  for (const r of rows) rowById.set(String(r.id), r);
  let hitUsers = 0, applied = 0;
  const t1 = Date.now();
  for (const [uid, agg] of byUser) {
    const usable = agg.reps.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (usable.length < ACCOUNT_PRESS_MIN_VIDEOS) continue;
    const mid = Math.floor(usable.length / 2);
    const median = usable.length % 2 ? usable[mid]! : (usable[mid - 1]! + usable[mid]!) / 2;
    if (median > ACCOUNT_PRESS_MEDIAN_MS) continue;
    hitUsers++;
    console.log(`⚠️ uid=${uid} ${agg.name ?? "?"} 可统计 ${usable.length} 盘 中位 ${median.toFixed(0)}ms → 窗口 ${agg.ids.length} 盘全部转需核定`);
    if (!apply) continue;
    for (const id of agg.ids) {
      const row = rowById.get(String(id));
      if (!row || row.auto_reason & AUTO_REASON.ACCOUNT_PRESS) continue;
      await prisma.video.update({
        where: { id },
        data: { autoReason: row.auto_reason | AUTO_REASON.ACCOUNT_PRESS, ...(row.auto_flag === 1 ? { autoFlag: 0 } : {}) },
      });
      applied++;
    }
  }
  console.log(`\n===== 扫描结果 =====`);
  console.log(`扫描 ${rows.length} 盘 / ${byUser.size} 用户（读失败 ${readFail} 解析失败 ${parseFail}），聚合耗时 ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  console.log(`命中用户 ${hitUsers} 个${apply ? `，落库录像 ${applied} 盘` : "（dry，未写库，加 --apply 落库）"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
