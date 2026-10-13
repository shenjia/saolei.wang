// Phase B 网络兜底：对 hash 仍为空的残余队列（文件缺失/解析失败/校验不一致者）
// 重新从旧站下载落盘（原名结构 videos/Video/Mvf/...），之后跑 phaseb-reconcile.ts 校验回填。
// 用法: env -u NODE_OPTIONS node --experimental-transform-types scripts/phaseb-fetch-rest.ts [concurrency=6]
// 特性：undici keep-alive 连接池、天然忽略 HTTP_PROXY 环境变量、重试 2 次、失败记 miss。
import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const BASE = "http://www.saolei.wang";
const ROOT = path.resolve(import.meta.dirname!, "..");
const VIDEOS = path.join(ROOT, "videos");
const MISS_LOG = "/tmp/phaseb-fetch-rest-miss.jsonl";
const CONC = parseInt(process.argv[2] || "6", 10);
const TIMEOUT_MS = 20000;
const RETRY = 2;

const prisma = new PrismaClient();

interface Row { id: bigint; filepath: string }

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
  const rows: Row[] = (await prisma.$queryRawUnsafe(
    `SELECT v.id, i.filepath
       FROM video v JOIN video_info i ON i.id = v.id
      WHERE v.create_time > 1382487826
        AND i.filepath LIKE '/Video/Mvf/%'
        AND (v.hash IS NULL OR v.hash = '')`
  )) as Row[];
  console.log(`兜底队列 ${rows.length} 条，并发 ${CONC}`);
  const t0 = Date.now();

  let ok = 0, fail = 0, done = 0;
  const queue = rows.slice();
  const localPath = (fp: string) => path.join(VIDEOS, fp);

  async function worker() {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const fp = r.filepath;
      try {
        const buf = await fetchWithRetry(BASE + encodeURI(fp));
        const local = localPath(fp);
        mkdirSync(path.dirname(local), { recursive: true });
        const tmp = local + ".part";
        writeFileSync(tmp, buf);
        // 简单原子化：改名为最终名（覆盖可能存在的半截文件）
        const { renameSync } = await import("fs");
        renameSync(tmp, local);
        ok++;
      } catch (e) {
        fail++;
        appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), fp, err: e instanceof Error ? e.message : String(e) }) + "\n");
      }
      done++;
      if (done % 100 === 0) {
        const rate = (done / (Date.now() - t0)) * 1000;
        const eta = ((rows.length - done) / rate / 60).toFixed(1);
        console.log(`进度 ${done}/${rows.length} (${rate.toFixed(1)}/s ETA ${eta}min) ok=${ok} fail=${fail}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  console.log(`DONE 总=${rows.length} 下载落盘=${ok} 失败=${fail} 耗时=${((Date.now() - t0) / 60000).toFixed(1)}min`);
}

main().finally(() => prisma.$disconnect());
