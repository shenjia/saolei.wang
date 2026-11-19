// Phase B 本地对账：磁盘已有 parse-videos.ts 时代下载的原始文件（videos/Video/Mvf/...），
// 与 DB 队列 filepath 一一对应。本脚本：读文件 → md5 → 解析 → 强校验（level+3bv+real_time+player）
// → 硬链接到 videos/YYYY/MM/DD/<md5>.<ext> → 批量回填 video.hash + video_info.filepath。
// 用法: env -u NODE_OPTIONS node --experimental-transform-types scripts/phaseb-reconcile.ts [limit=0]
// 校验不一致/缺失/解析失败的记 /tmp/phaseb-reconcile-miss.jsonl（留给网络兜底）。
import { existsSync, mkdirSync, readFileSync, appendFileSync, linkSync, copyFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { mvfToRawvf } from "../src/lib/mvf";
import { avfToRawvf } from "../src/lib/avf";
import { formatRawvf } from "../src/lib/rawvf";
import { createHash } from "crypto";

const ROOT = path.resolve(import.meta.dirname!, "..");
const VIDEOS = path.join(ROOT, "videos");
const MISS_LOG = "/tmp/phaseb-reconcile-miss.jsonl";
const LIMIT = parseInt(process.argv[2] || "0", 10);
// weak 模式：文件存在即回填（差异只记录不拦截）——适用于残余批次：
// 文件按 DB filepath 对应 URL 下载，归属天然成立；差异是旧站数据固有（成绩舍入/字段口径/损坏文件）
const WEAK = process.argv[3] === "weak";
// --all：队列不限 create_time 基线（用于补齐早期录像，如 2008-2011 年 hash 仍为空的遗留行）
const ALL = process.argv.includes("--all");

const prisma = new PrismaClient();

interface Row {
  id: bigint;
  create_time: number;
  level: string;
  filepath: string;
  signature: string;
  board_3bv: number | null;
  real_time: number | null;
}

async function main() {
  const rows: Row[] = (await prisma.$queryRawUnsafe(
    `SELECT v.id, v.create_time, v.level, i.filepath, i.signature, i.board_3bv, i.real_time
       FROM video v JOIN video_info i ON i.id = v.id
      WHERE ${ALL ? "" : "v.create_time > 1382487826 AND "}i.filepath LIKE '/Video/Mvf/%'
        AND (v.hash IS NULL OR v.hash = '')`
  )) as Row[];
  const total = LIMIT > 0 ? Math.min(rows.length, LIMIT) : rows.length;
  console.log(`队列 ${rows.length} 条，本次处理 ${total} 条`);
  const t0 = Date.now();

  let matched = 0, mismatch = 0, missing = 0, parseFail = 0, linked = 0;
  let batch: { vid: bigint; hash: string; rel: string }[] = [];

  const placeAndQueue = (r: Row, md5: string, ext: string) => {
    const d = new Date((Number(r.create_time) + 8 * 3600) * 1000);
    const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    const rel = `/${ymd}/${md5}.${ext}`;
    const dst = path.join(VIDEOS, rel);
    if (!existsSync(dst)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      try { linkSync(path.join(VIDEOS, r.filepath), dst); linked++; } catch { copyFileSync(path.join(VIDEOS, r.filepath), dst); linked++; }
    }
    matched++;
    batch.push({ vid: r.id, hash: md5, rel });
  };

  const flushBatch = async (force = false) => {
    if (batch.length < 500 && !force) return;
    if (!batch.length) return;
    const cur = batch;
    batch = [];
    await prisma.$transaction([
      ...cur.map((b) =>
        prisma.$executeRawUnsafe(
          `UPDATE video SET hash=? WHERE id=? AND (hash IS NULL OR hash='')`,
          b.hash, b.vid.toString()
        )
      ),
      ...cur.map((b) =>
        prisma.$executeRawUnsafe(
          `UPDATE video_info SET filepath=? WHERE id=?`,
          b.rel, b.vid.toString()
        )
      ),
    ]);
  };

  for (let i = 0; i < total; i++) {
    const r = rows[i]!;
    const local = path.join(VIDEOS, r.filepath);
    try {
      if (!existsSync(local)) {
        missing++;
        appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: "missing", fp: r.filepath }) + "\n");
        continue;
      }
      const buf = readFileSync(local);
      const md5 = createHash("md5").update(buf).digest("hex");
      const ext = path.extname(r.filepath).slice(1).toLowerCase() || "mvf";
      const lines = ext === "avf" ? avfToRawvf(buf) : mvfToRawvf(buf);
      if (!lines) {
        parseFail++;
        appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: "parse", fp: r.filepath }) + "\n");
        if (!WEAK) continue;
        placeAndQueue(r, md5, ext); // weak：损坏文件按 URL 归属直接回填
        await flushBatch();
        continue;
      }
      const p = formatRawvf(lines);
      // 强校验：real_time 允许 ±1ms（MSSQL 秒×1000 与文件毫秒的舍入边界，实测系统性差 1）；
      // level 全等；bbbv 两侧都有值时必须相等；player trim 后相等
      // weak 模式跳过拦截，差异仅记录
      let bad = "";
      if (r.real_time === null || Math.abs(p.timeMs - r.real_time) > 1) bad = "time";
      else if (p.level !== r.level) bad = "level";
      else if (r.board_3bv !== null && p.bbbv !== null && p.bbbv !== r.board_3bv) bad = "b3bv";
      if (bad && !WEAK) {
        mismatch++;
        appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: bad, fp: r.filepath, db: { rt: r.real_time, lvl: r.level, b3bv: r.board_3bv }, parsed: { rt: p.timeMs, lvl: p.level, b3bv: p.bbbv } }) + "\n");
        continue;
      }
      if (bad && WEAK) {
        appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: bad + "(weak-pass)", fp: r.filepath, db: { rt: r.real_time, lvl: r.level, b3bv: r.board_3bv }, parsed: { rt: p.timeMs, lvl: p.level, b3bv: p.bbbv } }) + "\n");
      }
      if (r.signature.trim() !== p.player.trim()) {
        if (!WEAK) {
          mismatch++;
          appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: "player", fp: r.filepath, db: r.signature, parsed: p.player }) + "\n");
          continue;
        }
        appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: "player(weak-pass)", fp: r.filepath, db: r.signature, parsed: p.player }) + "\n");
      }
      // 归位到 ymd/md5 目录（硬链接优先，失败复制）；rel 带前导斜杠（与基线格式一致，下载路由 "."+fp 依赖）
      placeAndQueue(r, md5, ext);
      await flushBatch();
    } catch (e) {
      parseFail++;
      appendFileSync(MISS_LOG, JSON.stringify({ id: r.id.toString(), why: "err:" + (e instanceof Error ? e.message : e), fp: r.filepath }) + "\n");
      if (!WEAK) continue;
      try {
        const buf2 = readFileSync(local);
        const md5 = createHash("md5").update(buf2).digest("hex");
        const ext2 = path.extname(r.filepath).slice(1).toLowerCase() || "mvf";
        placeAndQueue(r, md5, ext2); // weak：损坏文件按 URL 归属直接回填
        await flushBatch();
      } catch { /* 文件也读不了，彻底放弃 */ }
    }
    if ((i + 1) % 2000 === 0) {
      const rate = ((i + 1) / (Date.now() - t0)) * 1000;
      const eta = ((total - i - 1) / rate / 60).toFixed(0);
      console.log(`进度 ${i + 1}/${total} (${rate.toFixed(0)}/s ETA ${eta}min) 匹配=${matched} 不一致=${mismatch} 缺失=${missing} 解析失败=${parseFail}`);
    }
  }
  await flushBatch(true);
  console.log(`DONE 处理=${total} 匹配回填=${matched} 校验不一致=${mismatch} 文件缺失=${missing} 解析失败=${parseFail} 新链接=${linked} 耗时=${((Date.now() - t0) / 60000).toFixed(1)}min`);
}

main().finally(() => prisma.$disconnect());
