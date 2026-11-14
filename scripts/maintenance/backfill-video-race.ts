/* 存量录像比赛标识回填（2026-11-14 张老师「上线，需回填」）：
 * video_info.race 列已随 726558f 上线（上传管线对新上传自动提取落库），
 * 本脚本对存量 evf/rmv（race IS NULL）逐盘读文件解析提取 race_identifier
 * （evf=parseEvf 头部标准字段；rmv=玩家信息第 4 段 token，ms-toollib 判例
 * race_identifier=token_buffer）并回填。mvf/avf 无该字段语义，不扫。
 *
 * 安全口径：
 * - 只写 race IS NULL 的行（幂等：重跑自动跳过已回填的）；
 * - 提取值先过 checkSensitive（与上传闸同口径，命中跳过留痕不落库——
 *   历史存量不因回填拒传，只是不展示比赛标识）；
 * - 解析失败/文件缺失跳过留痕，不中断批次；
 * - UPDATE 不动 update_time（该列语义＝应用层文件版本号，CDN 缓存绕过用，
 *   race 是纯展示补充，不该触发录像文件版本变化）。
 *
 * 用法（生产，esbuild bundle 后放应用目录内，否则解析不到 node_modules）：
 *   npx esbuild scripts/maintenance/backfill-video-race.ts --bundle \
 *     --platform=node --external:@prisma/client --outfile=/tmp/backfill-race.cjs
 *   scp /tmp/backfill-race.cjs deploy@60.205.137.210:/home/deploy/saolei.wang/
 *   node backfill-race.cjs          # 全量（~5400 盘，分钟级）
 *   node backfill-race.cjs 500      # 只跑前 500 行（分批试跑）
 *
 * 本机调试：SAOLEI_ROOT="$PWD" DB_URL="mysql://root@localhost:3306/saolei" \
 *   node /tmp/backfill-race.cjs [limit]
 */
import { readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { parseEvf } from "../../src/lib/evf";
import { rmvToRawvf } from "../../src/lib/rmv";
import { formatRawvf } from "../../src/lib/rawvf";
import { checkSensitive } from "../../src/lib/sensitive";

const ROOT = process.env.SAOLEI_ROOT || "/home/deploy/saolei.wang";
const LIMIT = process.argv[2] ? Number(process.argv[2]) : Infinity;
const p = new PrismaClient();

let scanned = 0;
let backfilled = 0;
let skipNull = 0; // 文件无标识（raceIdentifier 空串/无 token 段）
let skipParse = 0;
let skipMissing = 0;
let skipSensitive = 0;
const samples: { id: number; race: string }[] = [];
const problems: { id: number; why: string }[] = [];

function extOf(filepath: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filepath);
  return m ? m[1].toLowerCase() : "";
}

async function main() {
  // race IS NULL 快照 + id 序扫描；LIMIT 在 JS 侧截断（$queryRaw 不支持条件拼接 LIMIT）
  const all = await p.$queryRaw<{ id: bigint; filepath: string }[]>`
    SELECT vi.id, vi.filepath
    FROM video_info vi
    WHERE vi.race IS NULL
      AND (vi.filepath LIKE '%.evf' OR vi.filepath LIKE '%.rmv')
    ORDER BY vi.id`;
  const list = LIMIT !== Infinity ? all.slice(0, LIMIT) : all;

  for (const { id, filepath } of list) {
    scanned++;
    const vid = Number(id);
    const ext = extOf(filepath);
    const abs = path.join(ROOT, "videos", filepath.replace(/^\//, ""));
    let race = "";
    try {
      const buf = new Uint8Array(readFileSync(abs));
      if (ext === "evf") {
        race = parseEvf(buf).raceIdentifier;
      } else {
        const lines = rmvToRawvf(buf);
        if (!lines) { skipParse++; problems.push({ id: vid, why: "rmv parse null" }); continue; }
        race = formatRawvf(lines).race;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        skipMissing++;
        problems.push({ id: vid, why: "file missing" });
      } else {
        skipParse++;
        problems.push({ id: vid, why: String(e).slice(0, 80) });
      }
      continue;
    }
    if (!race) { skipNull++; continue; }
    const hit = checkSensitive(race);
    if (!hit.ok) {
      skipSensitive++;
      problems.push({ id: vid, why: `sensitive: ${race.slice(0, 30)}` });
      continue;
    }
    // 只 UPDATE race 一列，不碰 update_time（文件版本号语义，见头部注释）
    await p.$executeRaw`UPDATE video_info SET race = ${race} WHERE id = ${BigInt(vid)} AND race IS NULL`;
    backfilled++;
    if (samples.length < 12) samples.push({ id: vid, race });
  }

  console.log(`扫描 ${scanned}，回填 ${backfilled}，无标识 ${skipNull}，解析失败 ${skipParse}，文件缺失 ${skipMissing}，敏感词跳过 ${skipSensitive}`);
  for (const s of samples) console.log(`  ✓ #${s.id} → "${s.race}"`);
  if (problems.length) {
    console.log(`异常明细（前 20）：`);
    for (const pr of problems.slice(0, 20)) console.log(`  ✗ #${pr.id} ${pr.why}`);
  }
  await p.$disconnect();
}

main();
