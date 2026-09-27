// Phase C 审计：全量录像文件存在性 + md5 校验（张老师要求：保证所有录像文件都存在）
// 范围：saolei.video 中 status != 0（非屏蔽）的每一条，按 video_info.filepath 检查：
//   A. 文件缺失 → miss（可用 phasec-restore 恢复）
//   B. 文件存在但 md5 != video.hash → corrupt（重下覆盖）
//   C. hash 为空的（2008 残留 /Video/% 路径）→ 只查存在性
// 输出：/tmp/phasec-audit-missing.jsonl、/tmp/phasec-audit-corrupt.jsonl + 汇总
// 用法: env -u NODE_OPTIONS node --experimental-transform-types scripts/phasec-audit.ts [--md5]
//   不加 --md5 只做存在性扫描（秒级）；加 --md5 全量读文件校验（约 10-20 分钟）
import { appendFileSync, createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(import.meta.dirname!, "..");
const VIDEOS = path.join(ROOT, "videos");
const MISSING = "/tmp/phasec-audit-missing.jsonl";
const CORRUPT = "/tmp/phasec-audit-corrupt.jsonl";
const DO_MD5 = process.argv.includes("--md5");

const prisma = new PrismaClient();

interface Row {
  id: bigint;
  hash: string | null;
  filepath: string;
  create_time: number;
}

const md5Of = (p: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

async function main() {
  const rows: Row[] = (await prisma.$queryRawUnsafe(
    `SELECT v.id, v.hash, i.filepath, v.create_time
       FROM saolei.video v JOIN saolei.video_info i ON i.id = v.id
      WHERE v.status != 0 AND i.filepath IS NOT NULL AND i.filepath != ''`
  )) as Row[];
  console.log(`审计范围 ${rows.length} 条（status!=0），md5 校验：${DO_MD5 ? "开" : "关"}`);
  const { writeFileSync: wf } = await import("fs");
  wf(MISSING, ""); wf(CORRUPT, "");

  let ok = 0, missing = 0, corrupt = 0, noHash = 0;
  // 按年代分桶统计缺失，便于定位问题段
  const missByYear = new Map<string, number>();
  const t0 = Date.now();
  let done = 0;

  const CONC = 8;
  const queue = rows.slice();
  async function worker() {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const p = path.join(VIDEOS, r.filepath);
      const year = r.filepath.split("/")[1] || "?";
      try {
        if (!existsSync(p) || !statSync(p).isFile()) {
          missing++;
          missByYear.set(year, (missByYear.get(year) ?? 0) + 1);
          appendFileSync(MISSING, JSON.stringify({ id: r.id.toString(), filepath: r.filepath, hash: r.hash, create_time: Number(r.create_time) }) + "\n");
        } else if (DO_MD5 && r.hash) {
          const md5 = await md5Of(p);
          if (md5 !== r.hash) {
            corrupt++;
            appendFileSync(CORRUPT, JSON.stringify({ id: r.id.toString(), filepath: r.filepath, hash: r.hash, actual: md5 }) + "\n");
          } else ok++;
        } else {
          if (!r.hash) noHash++;
          else ok++;
        }
      } catch (e) {
        // ⚠️ 存在但损坏的 .part 半截文件也算 miss（statSync isFile 会过，但内容不完整）
        missing++;
        appendFileSync(MISSING, JSON.stringify({ id: r.id.toString(), filepath: r.filepath, err: e instanceof Error ? e.message : String(e) }) + "\n");
      }
      done++;
      if (done % 50000 === 0) console.log(`  ${done}/${rows.length} 用时 ${((Date.now() - t0) / 60000).toFixed(1)}min`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  console.log(`\n=== 审计结果（${((Date.now() - t0) / 60000).toFixed(1)}min）===`);
  console.log(`完好(含md5通过): ${ok}`);
  console.log(`无hash仅存在性: ${noHash}`);
  console.log(`缺失: ${missing}`);
  if (DO_MD5) console.log(`md5不一致: ${corrupt}`);
  if (missByYear.size) {
    console.log("缺失按年代分布:");
    [...missByYear.entries()].sort().forEach(([y, n]) => console.log(`  ${y}: ${n}`));
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
