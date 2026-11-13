// 按压口径 v3 重捡（2026-11-13 张老师指令）：对需核定池（auto_flag=0）重算按压类
// 触发器并按新口径重写——与增量 OR 补判不同，本脚本是「清位重判」：
//
//   1. bit0/bit23：pressTriggers 新口径（含触控板豁免——全部配对 <12ms 放过）
//   2. bit19：σ 线废弃，改「完全相同按压时长众数占比」分级线（初95%/中85%/高75%），
//      触控板流同样豁免
//   3. bit24：账号触控板豁免——账号窗口内全部可统计按压 <12ms → 触控板账号，
//      剥离该账号池内录像的 bit24（触控板账号中位数天然 ≤12ms，不是合成流证据）
//   4. 重算后 reason=0 的盘解除需核定（auto_flag=1）；若该盘在 --restore-file
//      清单内且当前 status=10，恢复 status=20（2026-11-13 嫌疑清单批量转待审的回滚）
//
// 不动 auto_flag=-1（人工终局）/ 2（分拣失败）。轨迹类位码（17/18/20/21/22）口径
// 未变，原位保留。
//
// 跑法（本地 / 生产）:
//   扫描（只报不写）: env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/press-retriage-v3.ts
//   落库: 同上 + --apply [--restore-file /tmp/retriage-ids.txt]

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary } from "../src/lib/videoradar";
import { pressPairStats, pressTriggers, humanLikeStats } from "../src/lib/video-triage";
import { AUTO_REASON, PRESS_UNIFORM_SHARE, PRESS_SHORT_MIN_PAIRS, TOUCHPAD_MAX_PRESS_MS, ACCOUNT_PRESS_SCAN_LIMIT } from "../src/lib/video-triage-limits";

const VIDEOS_ROOT = path.join(process.cwd(), "videos");
const PRESS_BITS = AUTO_REASON.PRESS | AUTO_REASON.PRESS_UNIFORM | AUTO_REASON.SHORT_PRESS;
const BIT24 = AUTO_REASON.ACCOUNT_PRESS;

interface Row {
  id: bigint;
  user: bigint;
  level: string;
  status: number;
  auto_reason: number;
  filepath: string;
  chinese_name: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rfIdx = process.argv.indexOf("--restore-file");
  const restoreIds = rfIdx >= 0
    ? new Set(readFileSync(process.argv[rfIdx + 1]!, "utf8").trim().split(",").map((s) => s.trim()))
    : null;

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT v.id, v.user, v.level, v.status, v.auto_reason, vi.filepath, u.chinese_name
     FROM video v JOIN video_info vi ON vi.id=v.id LEFT JOIN user u ON u.id=v.user
     WHERE v.auto_flag = 0
     ORDER BY v.id ASC`
  );
  console.log(`需核定池 ${rows.length} 盘${apply ? "（--apply 落库）" : "（只报不写）"}…`);

  const levelLine = (lv: string) => PRESS_UNIFORM_SHARE[lv] ?? 0.85;
  let done = 0, readFail = 0, parseFail = 0;
  const t0 = Date.now();
  // 每盘新 reason（只在有变化时落库）；bit24 待剥离的按用户收集
  const rewrites: { row: Row; next: number }[] = [];
  const bit24Users = new Map<string, Row[]>();
  for (const r of rows) {
    done++;
    if (done % 500 === 0) console.log(`  ... ${done}/${rows.length} (${((Date.now() - t0) / 60000).toFixed(1)}min)`);
    let buf: Buffer;
    try {
      const full = path.resolve(VIDEOS_ROOT, "." + r.filepath);
      if (!full.startsWith(VIDEOS_ROOT + path.sep)) { readFail++; continue; }
      buf = readFileSync(full);
    } catch { readFail++; continue; }
    const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(new Uint8Array(buf), ext);
    if (!v) { parseFail++; continue; }

    const ps = pressPairStats(v);
    const hl = humanLikeStats(v);
    let next = r.auto_reason & ~PRESS_BITS;
    next |= pressTriggers(ps, r.level);
    // bit19 占比口径（触控板豁免内嵌判据：全部 <12ms 不判）
    if (hl.pressN >= 30 &&
        !(hl.pressMaxMs !== null && hl.pressMaxMs < TOUCHPAD_MAX_PRESS_MS) &&
        hl.pressModeShare !== null && hl.pressModeShare >= levelLine(r.level)) {
      next |= AUTO_REASON.PRESS_UNIFORM;
    }
    if (next & BIT24) {
      const key = String(r.user);
      const arr = bit24Users.get(key);
      if (arr) arr.push(r); else bit24Users.set(key, [r]);
    }
    if (next !== r.auto_reason) rewrites.push({ row: r, next });
  }

  // bit24 触控板账号豁免：窗口内全部可统计按压 <12ms → 剥离
  // （VideoInfo 无 Video 的 Prisma 关联，两步查询取用户最近 30 盘）
  let stripped24 = 0;
  for (const [uid, urows] of bit24Users) {
    const userVids = await prisma.video.findMany({
      where: { user: BigInt(uid) },
      select: { id: true },
      orderBy: { id: "desc" },
      take: ACCOUNT_PRESS_SCAN_LIMIT,
    });
    const vids = userVids.length
      ? await prisma.videoInfo.findMany({
          where: { id: { in: userVids.map((x) => x.id) } },
          select: { id: true, filepath: true },
        })
      : [];
    let allTouchpad = true, usable = 0;
    for (const vi of vids) {
      let buf: Buffer;
      try {
        const full = path.resolve(VIDEOS_ROOT, "." + vi.filepath);
        if (!full.startsWith(VIDEOS_ROOT + path.sep)) { allTouchpad = false; break; }
        buf = readFileSync(full);
      } catch { allTouchpad = false; break; }
      const ext = vi.filepath.split(".").pop()?.toLowerCase() ?? "";
      const v = parseVideoBinary(new Uint8Array(buf), ext);
      if (!v) continue;
      const ps = pressPairStats(v);
      const keys: number[] = [];
      if (ps.leftAvg !== null && ps.leftN >= PRESS_SHORT_MIN_PAIRS) keys.push(ps.leftAvg);
      if (ps.rightAvg !== null && ps.rightN >= PRESS_SHORT_MIN_PAIRS) keys.push(ps.rightAvg);
      if (!keys.length) continue;
      usable++;
      if (Math.min(...keys) >= TOUCHPAD_MAX_PRESS_MS) { allTouchpad = false; break; }
    }
    if (allTouchpad && usable > 0) {
      console.log(`☐ uid=${uid} ${urows[0]!.chinese_name ?? "?"} 账号 ${usable} 盘可统计按压全部 <${TOUCHPAD_MAX_PRESS_MS}ms → 触控板账号，剥离 ${urows.length} 盘的 bit24`);
      for (const r of urows) {
        const rw = rewrites.find((x) => x.row.id === r.id);
        const next = (rw ? rw.next : r.auto_reason) & ~BIT24;
        if (rw) rw.next = next; else rewrites.push({ row: r, next });
        stripped24++;
      }
    }
  }

  // 落库 + 统计
  let released = 0, kept = 0, restored = 0;
  const drop19: number[] = [];
  for (const { row: r, next } of rewrites) {
    if (next === r.auto_reason) continue;
    const release = next === 0;
    if (release) {
      released++;
      if (restoreIds?.has(String(r.id)) && r.status === 10) restored++;
    } else {
      kept++;
      if (!(next & AUTO_REASON.PRESS_UNIFORM) && (r.auto_reason & AUTO_REASON.PRESS_UNIFORM)) drop19.push(Number(r.id));
    }
    if (apply) {
      await prisma.video.update({
        where: { id: r.id },
        data: { autoReason: next, autoFlag: release ? 1 : 0, ...(release && restoreIds?.has(String(r.id)) && r.status === 10 ? { status: 20 } : {}) },
      });
    }
  }

  console.log(`\n===== 重捡结果（读失败 ${readFail} 解析失败 ${parseFail}）=====`);
  console.log(`重写 ${rewrites.length} 盘：继续需核定 ${kept}、解除需核定 ${released}（其中恢复 status=20 ${restored} 盘）；bit24 触控板剥离 ${stripped24} 盘`);
  if (drop19.length) console.log(`bit19 释放（新占比口径不成立）：${drop19.length} 盘，如 ${drop19.slice(0, 8).join(",")}${drop19.length > 8 ? " …" : ""}`);
  if (apply) console.log("已落库。");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
