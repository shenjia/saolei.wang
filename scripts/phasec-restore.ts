// Phase C：恢复 2007–2013.10 历史录像实体文件（约 5.7 万个，本地缺失整段）
// 背景：Phase B 只下载了 create_time > 2013-10-23 的队列；此前的老录像在新库里
// filepath 已是 2013 迁移改写的 /YYYY/MM/DD/<md5>.<ext> 哈希路径，但旧站上
// 实体文件只按 2008 版原路径 /Video/Mvf/<uid>/<原名>.mvf 存放。
// 恢复链路：saolei_mssql.video.Video_Path（原始路径）→ 旧站下载 →
//           md5 校验（应等于 saolei.video.hash 且等于 filepath 中的文件名）
//           → 落盘 videos/<DB filepath 去前导斜杠>
// 用法: env -u NODE_OPTIONS node --experimental-transform-types scripts/phasec-restore.ts [concurrency=6] [limit=0]
// 断点续跑：目标文件已存在且 md5 一致则跳过；失败记 /tmp/phasec-miss.jsonl
import { appendFileSync, createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

const BASE = "http://www.saolei.wang";
const ROOT = path.resolve(import.meta.dirname!, "..");
const VIDEOS = path.join(ROOT, "videos");
const MISS_LOG = "/tmp/phasec-miss.jsonl";
const CONC = parseInt(process.argv[2] || "6", 10);
const LIMIT = parseInt(process.argv[3] || "0", 10);
const TIMEOUT_MS = 25000;
const RETRY = 2;

const prisma = new PrismaClient();

interface Row {
  id: bigint;
  hash: string;
  filepath: string; // /YYYY/MM/DD/<md5>.ext
  old_path: string; // /Video/Mvf/...（staging 原始路径）
}

const md5Of = (p: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

async function fetchWithRetry(url: string): Promise<Buffer> {
  let lastErr: unknown = null;
  for (let i = 0; i <= RETRY; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (saolei.wang sync)" },
      });
      if (res.status === 404) throw Object.assign(new Error("404"), { fatal: true });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const ab = await res.arrayBuffer();
      if (ab.byteLength === 0) throw new Error("empty body");
      return Buffer.from(ab);
    } catch (e) {
      lastErr = e;
      if ((e as { fatal?: boolean }).fatal) break;
      if (i < RETRY) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  // 队列：2007–2013.10 段（create_time <= 2013-10-23 基线），hash 已回填（迁移自带），
  // 关联 staging 原始路径；排除屏蔽状态（status=0 老站已删）
  const rows: Row[] = (await prisma.$queryRawUnsafe(
    `SELECT v.id, v.hash, i.filepath, m.Video_Path AS old_path
       FROM saolei.video v
       JOIN saolei.video_info i ON i.id = v.id
       JOIN saolei_mssql.video m ON m.Video_Id = v.id
      WHERE v.create_time <= 1382487826
        AND v.status != 0
        AND v.hash IS NOT NULL AND v.hash != ''
        AND i.filepath REGEXP '^/20(0[7-9]|1[0-2])/|^/2013/(0[1-9]|10)/'
        AND m.Video_Path LIKE '/Video/Mvf/%'`
  )) as Row[];
  console.log(`Phase C 队列 ${rows.length} 条，并发 ${CONC}${LIMIT ? `，限 ${LIMIT}` : ""}`);
  const t0 = Date.now();
  const queue = LIMIT > 0 ? rows.slice(0, LIMIT) : rows.slice();

  let ok = 0, skip = 0, fail = 0, done = 0;
  const target = (r: Row) => path.join(VIDEOS, r.filepath);

  async function worker() {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const dst = target(r);
      try {
        if (existsSync(dst)) {
          const cur = await md5Of(dst);
          if (cur === r.hash) { skip++; continue; }
          // 存在但坏 → 重下覆盖
        }
        const buf = await fetchWithRetry(BASE + encodeURI(r.old_path));
        const md5 = createHash("md5").update(buf).digest("hex");
        if (md5 !== r.hash) throw new Error(`md5 mismatch: got ${md5}`);
        mkdirSync(path.dirname(dst), { recursive: true });
        const tmp = dst + ".part";
        writeFileSync(tmp, buf);
        renameSync(tmp, dst);
        ok++;
      } catch (e) {
        fail++;
        appendFileSync(MISS_LOG, JSON.stringify({
          id: r.id.toString(), old_path: r.old_path, filepath: r.filepath,
          err: e instanceof Error ? e.message : String(e),
        }) + "\n");
      }
      done++;
      if (done % 100 === 0) {
        const rate = done / (Date.now() - t0) * 1000;
        const eta = ((queue.length) / rate / 60).toFixed(1);
        console.log(`${done}/${queue.length + done} ok=${ok} skip=${skip} fail=${fail} ${rate.toFixed(1)}/s ETA ${eta}min`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`完成 ok=${ok} skip=${skip} fail=${fail}，用时 ${((Date.now() - t0) / 60000).toFixed(1)}min`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
