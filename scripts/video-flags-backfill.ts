// 跑批：存量录像 → 重放事件流取终态旗位 → 合成含旗 board 串（F=雷+旗 / X=非雷旗）
// 回写 video_info.board（等长替换，varchar(500) 不变）。
//
// 背景（2026-10-31 张老师需求）：录像详情页封面显示玩家标过的雷——FL 局与 NF 局
// 封面此前一模一样（纯数字盘 + 灰雷格），打法信息丢失。方案是不加列，把旗编码
// 等长合进 board 串（见 src/lib/videoflags.ts）。
//
// 用法（必须用 ts loader，否则无扩展名 import 解析不了）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/video-flags-backfill.ts [选项]
// 选项：
//   --limit=N        只处理前 N 个（默认全量）
//   --from=N         从 id 第 N 个偏移开始（配合 --limit 分批）
//   --ids=1,2,3      只处理指定 id（逗号分隔）
//   --dry-run        只统计不写库
//   --fl-only        只处理 FL 局（noflag=0；NF 局终态旗位图必全零，跑了也是原串）
//
// 幂等：串里已有旗编码的（含 F/X）默认跳过；重放失败/文件缺失跳过不写。
// 只 UPDATE 不重建——board 列本来就是「缺则补、错则修」的语义（renderBoard
// 口径曾整列重算过，见 scripts/sync/fix-board-numbers.py 先例）。

import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { parseVideoBinary, replayEvents } from "../src/lib/videoradar";
import { applyFlags } from "../src/lib/videoflags";

// ---- 生产避峰守卫（与 video-metrics.ts 同款，慢 SQL 巡检治理 2026-10-27）----
import { existsSync } from "fs";
function assertOffPeak(): void {
  const isProd =
    existsSync("/home/deploy/saolei.wang/.env") ||
    !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "");
  if (!isProd) return;
  const h = new Date().getHours();
  if (h >= 14 && h < 17 && !has("off-peak-ok")) {
    console.error(
      `[避峰守卫] 当前 ${h} 点处于生产高峰期（14-17 点），拒绝执行跑批。` +
        `请在低峰期运行，或确认无碍后加 --off-peak-ok 放行。`
    );
    process.exit(1);
  }
}
assertOffPeak();

const VIDEOS_ROOT = path.join(process.cwd(), "videos");

function arg(name: string): string | null {
  const hit = process.argv.find((a) => startsWith(a)(name));
  return hit ? hit.slice(name.length + 3) : null;
}
const startsWith = (a: string) => (n: string) => a.startsWith(`--${n}=`);
const has = (name: string) => process.argv.includes(`--${name}`);

function readVideoFile(filepath: string): Uint8Array | null {
  try {
    const full = path.resolve(VIDEOS_ROOT, "." + filepath);
    if (!full.startsWith(VIDEOS_ROOT + path.sep)) return null;
    return new Uint8Array(readFileSync(full));
  } catch {
    return null;
  }
}

async function main() {
  const dryRun = has("dry-run");
  const limit = arg("limit") ? parseInt(arg("limit")!, 10) : 0;
  const from = arg("from") ? parseInt(arg("from")!, 10) : 0;
  const idsArg = arg("ids");

  // 目标行：FL 局（noflag=0）+ board 非空（空板走 ensureVideoBoard 兜底现解析，
  // 那条链路已自带含旗合成）+ 尚无旗编码
  const where = {
    noflag: false,
    ...(idsArg ? { id: { in: idsArg.split(",").map((s) => BigInt(s)) } } : {}),
  };
  const rows = await prisma.videoInfo.findMany({
    where,
    select: { id: true, filepath: true, board: true },
    orderBy: { id: "asc" },
    ...(limit ? { take: limit } : {}),
    ...(from ? { skip: from } : {}),
  });

  let done = 0, skipped = 0, nofile = 0, parseFail = 0, noChange = 0, written = 0;
  const t0 = Date.now();
  // 批量写：500 一组拼 UPDATE CASE（与 video-metrics rebuildComposite 同款手法）
  const pending: Array<[bigint, string]> = [];
  const flush = async () => {
    if (!pending.length || dryRun) return;
    const CHUNK = 500;
    for (let i = 0; i < pending.length; i += CHUNK) {
      const part = pending.slice(i, i + CHUNK);
      const ids = part.map((p) => p[0].toString()).join(",");
      const whens = part.map((p) => `WHEN ${p[0]} THEN '${p[1]}'`).join(" ");
      await prisma.$executeRawUnsafe(
        `UPDATE video_info SET board = CASE id ${whens} END WHERE id IN (${ids})`
      );
      written += part.length;
    }
    pending.length = 0;
  };

  for (const r of rows) {
    done++;
    if (!r.board) { skipped++; continue; } // 空板走 ensureVideoBoard
    if (r.board.includes("F") || r.board.includes("X")) { skipped++; continue; } // 已含旗
    const buf = readVideoFile(r.filepath);
    if (!buf) { nofile++; continue; }
    const ext = r.filepath.split(".").pop()?.toLowerCase() ?? "";
    const v = parseVideoBinary(buf, ext);
    if (!v || !v.board || v.board.length !== v.width * v.height) { parseFail++; continue; }
    // ⚠️ 解析器 board 必须与库内串一致（曾整列重算修数字，个别行或仍有出入）：
    //    以解析器输出为基准合成（它才与事件流自洽），不再读 r.board
    let out: string;
    try {
      out = applyFlags(v.board, replayEvents(v).flagged);
    } catch {
      parseFail++;
      continue;
    }
    if (out === r.board) { noChange++; continue; } // 零旗局（chord 流无旗）串不变
    pending.push([r.id, out]);
    if (pending.length >= 2000) await flush();
    if (done % 5000 === 0) {
      console.log(`进度 ${done}/${rows.length}（写 ${written} 跳过 ${skipped} 无文件 ${nofile} 解析失败 ${parseFail}） ${(Date.now() - t0) / 1000 | 0}s`);
    }
  }
  await flush();

  console.log(
    `完成：扫描 ${done}，写入 ${written}，无变化 ${noChange}，跳过(空板/已含旗) ${skipped}，` +
      `文件缺失 ${nofile}，解析失败 ${parseFail}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (dryRun ? "（dry-run 未写库）" : "")
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
