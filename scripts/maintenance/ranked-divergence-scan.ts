/* 排行模式录像分叉日检（2026-11-10，方案1+3 哨兵化上线的配套巡检）：
 * 对过去 N 小时全部排行局（video_info.evf_sig 非空＝排名局服务端签名落库）
 * 逐盘用上传闸同款 judgeVideoOutcome 重放判定。排行局只可能是完整胜局上传
 * （videowin.ts 上传校验：只有完整胜局可过），所以重放判 loss / incomplete
 * ＝客户端事件流与权威服务端语义分叉（355154 判死 / 355162·355166·355167
 * 停滞同款），需要按哨兵对替换 / 仿真真值管线修复——本脚本只报告不修复。
 *
 * 判定铁律（2026-11-09 456 盘扫描教训）：不要自己写 win 标志检查——
 * judgeVideoOutcome 的胜利＝全部安全格开启，与 flop 语义一致；
 * 「开满格但 win 标志未置」类误报在此口径下不存在。
 *
 * 用法：node ranked-div-scan.cjs [hours=24]
 * 生产运行（esbuild bundle 后放应用目录内，否则解析不到 node_modules）：
 *   npx esbuild scripts/maintenance/ranked-divergence-scan.ts --bundle \
 *     --platform=node --external:@prisma/client --outfile=/tmp/ranked-div-scan.cjs
 *   scp 上生产 /home/deploy/saolei.wang/ 后：node ranked-div-scan.cjs 24
 * 本机调试：SAOLEI_ROOT="$PWD" node /tmp/ranked-div-scan.cjs 168
 */
import { parseVideoBinary } from "../../src/lib/videoradar";
import { judgeVideoOutcome } from "../../src/lib/videowin";
import { readFileSync } from "fs";
import { PrismaClient } from "@prisma/client";

const ROOT = process.env.SAOLEI_ROOT || "/home/deploy/saolei.wang";
const HOURS = Number(process.argv[2] || "24");
const p = new PrismaClient();

function extOf(filepath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filepath);
  return m ? m[1].toLowerCase() : "";
}

interface Row {
  id: bigint;
  user: bigint;
  level: string;
  real_time: number;
  filepath: string | null;
}

(async () => {
  const since = BigInt(Math.floor(Date.now() / 1000) - HOURS * 3600);
  const rows = (await p.$queryRawUnsafe<Row[]>(
    `SELECT v.id id, v.user user, v.level level, vi.real_time real_time, vi.filepath filepath
     FROM video v JOIN video_info vi ON vi.id = v.id
     WHERE v.create_time >= ? AND vi.evf_sig IS NOT NULL
     ORDER BY v.id ASC`,
    since,
  )) as unknown as Row[];
  console.log(`窗口 ${HOURS}h（create_time >= ${since}）：排行局 ${rows.length} 盘`);
  let ok = 0,
    skipped = 0;
  const bad: string[] = [];
  for (const r of rows) {
    if (!r.filepath) {
      skipped++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(`${ROOT}/videos${r.filepath}`);
    } catch {
      skipped++;
      console.log(`  [缺文件] ${r.id} ${r.filepath}`);
      continue;
    }
    const v = parseVideoBinary(new Uint8Array(buf), extOf(r.filepath));
    if (!v || !v.board) {
      skipped++;
      console.log(`  [解析失败] ${r.id}`);
      continue;
    }
    let outcome: string;
    try {
      outcome = judgeVideoOutcome({
        width: v.width,
        height: v.height,
        board: v.board,
        events: v.events,
        marks: v.marks,
      });
    } catch {
      skipped++;
      console.log(`  [重放异常] ${r.id}`);
      continue;
    }
    if (outcome === "win") {
      ok++;
      continue;
    }
    bad.push(
      `${r.id} uid=${r.user} ${r.level} rt=${r.real_time}ms 判定=${outcome}`,
    );
  }
  console.log(`结果：一致 ${ok} / 跳过 ${skipped} / 分叉候选 ${bad.length}`);
  for (const s of bad) console.log("  [分叉候选] " + s);
  await p.$disconnect();
  if (bad.length > 0) process.exit(2); // 有候选：非零退出便于自动化判别
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
