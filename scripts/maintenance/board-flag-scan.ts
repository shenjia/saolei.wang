/* 存量坏旗位扫描：对候选录像用当前 replay-core 重放旗位，与库内 board 比对
 * 用法：node board-scan.cjs x|win [apply] [winTs]
 *   x   = 库内含 X 的串（假错旗候选）
 *   win = create_time >= winTs 的全量窗口（抓只漏旗/多旗类坏串）
 *   apply = 实际写库修复（缺省只报告）
 */
import { parseVideoBinary, replayEvents } from "../../src/lib/videoradar";
import { applyFlags } from "../../src/lib/videoflags";
import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

const ROOT = "/home/deploy/saolei.wang";
const p = new PrismaClient();

function extOf(filepath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filepath);
  return m ? m[1].toLowerCase() : "";
}

(async () => {
  const MODE = process.argv[2] || "x";
  const APPLY = process.argv[3] === "apply";
  const WIN_TS = BigInt(process.argv[4] || "1790352000"); // 2026-09-26 00:00 +08

  interface Row {
    id: bigint;
    board: string;
    filepath: string | null;
  }
  let rows: Row[];
  if (MODE === "x") {
    rows = (await p.videoInfo.findMany({
      where: { board: { contains: "X" } },
      select: { id: true, board: true, filepath: true },
      orderBy: { id: "asc" },
    })) as unknown as Row[];
  } else {
    rows = (await p.$queryRawUnsafe<Row[]>(
      `SELECT vi.id id, vi.board board, vi.filepath filepath
       FROM video_info vi JOIN video v ON v.id = vi.id
       WHERE v.create_time >= ? ORDER BY vi.id ASC`,
      WIN_TS,
    )) as unknown as Row[];
  }
  console.log(`候选 ${rows.length} 条（mode=${MODE} apply=${APPLY}）`);
  let checked = 0,
    skipped = 0,
    bad = 0,
    fixed = 0;
  const badList: string[] = [];
  for (const r of rows) {
    if (!r.filepath) {
      skipped++;
      continue;
    }
    const ext = extOf(r.filepath);
    let buf: Buffer;
    try {
      buf = readFileSync(`${ROOT}/videos${r.filepath}`);
    } catch {
      skipped++;
      continue;
    }
    const v = parseVideoBinary(new Uint8Array(buf), ext);
    if (!v || !v.board || v.board.length !== r.board.length) {
      skipped++;
      continue;
    }
    let fl: Uint8Array;
    try {
      fl = replayEvents(v).flagged;
    } catch {
      skipped++;
      continue;
    }
    const correct = applyFlags(v.board, fl);
    checked++;
    if (correct !== r.board) {
      bad++;
      let diff = 0,
        missF = 0,
        falseX = 0;
      for (let i = 0; i < r.board.length; i++) {
        if (r.board[i] !== correct[i]) {
          diff++;
          if (r.board[i] === "X") falseX++;
          else if (correct[i] === "F") missF++;
        }
      }
      badList.push(`${r.id} diff=${diff} 漏旗=${missF} 假X=${falseX}`);
      if (APPLY) {
        await p.videoInfo.update({ where: { id: r.id }, data: { board: correct } });
        fixed++;
      }
    }
  }
  console.log(
    `完成：核对 ${checked}，跳过 ${skipped}，坏串 ${bad}${APPLY ? `，已修复 ${fixed}` : ""}`
  );
  for (const s of badList) console.log("  " + s);
  await p.$disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
