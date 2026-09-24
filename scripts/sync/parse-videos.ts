// Phase B：批量下载旧站录像实体文件并解析
// 用法: node parse-videos.js <todo.jsonl> <out.jsonl> <videoRoot> [concurrency=10] [limit=0]
// - todo.jsonl: 每行 {"id": 81496, "fp": "/Video/Mvf/12396/xxx.avf"}
// - out.jsonl : 每行 {"id":..,"ok":true,"sig":..,"sw":..,"ver":..,"nf":0/1,"board":..,"b3bv":..,"rt":..,"lvl":..,"player":..}
//               或 {"id":..,"ok":false,"err":"..."}  （追加写，支持断点续跑：已存在的 id 跳过）
// - videoRoot : 实体文件保存根目录（映射 fp 相对路径）

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import path from "path";
import { mvfToRawvf } from "../../src/lib/mvf";
import { avfToRawvf } from "../../src/lib/avf";
import { formatRawvf } from "../../src/lib/rawvf";

const BASE = "http://www.saolei.wang";
const [todoFile, outFile, videoRoot, concArg, limitArg] = process.argv.slice(2);
const CONCURRENCY = parseInt(concArg || "10", 10);
const LIMIT = parseInt(limitArg || "0", 10);
const TIMEOUT_MS = 20000;
const RETRY = 2;

if (!todoFile || !outFile || !videoRoot) {
  console.error("usage: node parse-videos.js <todo.jsonl> <out.jsonl> <videoRoot> [concurrency] [limit]");
  process.exit(1);
}

// 断点续跑：读取已完成 id
const done = new Set<number>();
if (existsSync(outFile)) {
  for (const line of readFileSync(outFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      done.add(JSON.parse(line).id);
    } catch { /* 忽略坏行 */ }
  }
}

interface Task { id: number; fp: string }
const tasks: Task[] = [];
for (const line of readFileSync(todoFile, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const t = JSON.parse(line) as Task;
  if (!done.has(t.id)) tasks.push(t);
  if (LIMIT > 0 && tasks.length >= LIMIT) break;
}

console.error(`[parse-videos] todo=${tasks.length} (skip done=${done.size}) concurrency=${CONCURRENCY}`);

let finished = 0;
let failed = 0;
const t0 = Date.now();

async function fetchWithRetry(url: string): Promise<Buffer> {
  let lastErr: unknown = null;
  for (let i = 0; i <= RETRY; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (saolei.wang sync)" },
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const ab = await res.arrayBuffer();
      if (ab.byteLength === 0) throw new Error("empty body");
      return Buffer.from(ab);
    } catch (e) {
      lastErr = e;
      if (i < RETRY) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function work(task: Task): Promise<void> {
  const url = BASE + encodeURI(task.fp);
  try {
    const buf = await fetchWithRetry(url);
    // 保存实体文件（映射 fp 到本地 videoRoot）
    const local = path.resolve(videoRoot, "." + task.fp);
    if (local.startsWith(path.resolve(videoRoot) + path.sep)) {
      mkdirSync(path.dirname(local), { recursive: true });
      writeFileSync(local, buf);
    }
    // 解析
    const ext = (path.extname(task.fp).slice(1) || "mvf").toLowerCase();
    const lines = ext === "avf" ? avfToRawvf(buf) : mvfToRawvf(buf);
    if (!lines) throw new Error("unrecognized format");
    const p = formatRawvf(lines);
    appendFileSync(outFile, JSON.stringify({
      id: task.id, ok: true,
      sig: p.player, sw: p.program, ver: p.version,
      nf: p.noflag ? 1 : 0, board: p.board,
      b3bv: p.bbbv, rt: p.timeMs, lvl: p.level,
    }) + "\n");
  } catch (e) {
    failed++;
    appendFileSync(outFile, JSON.stringify({
      id: task.id, ok: false, err: e instanceof Error ? e.message : String(e),
    }) + "\n");
  }
  finished++;
  if (finished % 500 === 0) {
    const rate = (finished / (Date.now() - t0)) * 1000;
    console.error(`[parse-videos] ${finished}/${tasks.length} failed=${failed} rate=${rate.toFixed(1)}/s`);
  }
}

async function worker(queue: Task[]): Promise<void> {
  for (;;) {
    const t = queue.shift();
    if (!t) return;
    await work(t);
  }
}

const queue = tasks.slice();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
console.error(`[parse-videos] DONE ${finished}/${tasks.length} failed=${failed} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
