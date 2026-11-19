#!/usr/bin/env node
// 存量修复：9 个「盘外点击 OOB」evf → 哨兵化 + md5 改名 + SQL 产出
// 用法: node scripts/fix-oob-legacy.mjs <videoRoot> [--apply]
//   缺省 dry-run；--apply 写文件 + mv 改名 + 产出 SQL（含 evf_sig 重签）
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";

const [videoRoot] = process.argv.slice(2, 3);
const apply = process.argv.includes("--apply");
if (!videoRoot) { console.error("用法: node fix-oob-legacy.mjs <videoRoot> [--apply]"); process.exit(1); }

// 9 条受影响（video id → filepath）
const TARGETS = [
  ["348280", "/2026/10/29/f0fe7db1c6bfbcd8ad5cc7417b0c372b.evf"],
  ["348456", "/2026/10/29/c4e6adb1ec4f51cea2367893e250c456.evf"],
  ["348560", "/2026/10/29/c3c54c04e2cb2417f711d8085bb02636.evf"],
  ["348632", "/2026/10/29/c099eab3b4bca92fa5c6765f6b43abab.evf"],
  ["348796", "/2026/10/30/c589b9c49b523f6927136dd16799d506.evf"],
  ["348893", "/2026/10/30/503459b584ef13b3df053bd1eb1d05bb.evf"],
  ["348894", "/2026/10/30/37af862fc70094bfbb2c4e9dc61ff928.evf"],
  ["348927", "/2026/10/30/d1e726a02bfd556c68a6efad8e7bfcbf.evf"],
  ["349035", "/2026/10/30/50fc480d7eb6272594b9b8d1f31a3a69.evf"],
];
// 点击类 mouse code（EVF 字节流）：lc=2 lr=3 rc=4 rr=5 mc=6 mr=7 pf=8 cc=9 l=10 r=11 m=12
const CLICK_CODES = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

function rd(buf, pos, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[pos + i]; return v; }
function wr(buf, pos, n, v) { for (let i = n - 1; i >= 0; i--) { buf[pos + i] = v & 0xff; v = Math.floor(v / 256); } }

// v0.3 头解析（本站文件全是 v0.3）：返回事件流起始偏移 + 盘宽高
function parseV3Head(buf) {
  const version = buf[0];
  if (version !== 3) throw new Error(`expect v3, got ${version}`);
  const height = buf[3], width = buf[4];
  // v0.3: 3B(ver/summary/settings) + h/w + mines2 + cell + mode2 + bbbv2 + rtime3 + 8 cstr + 位图
  let p = 3 + 1 + 1 + 2 + 1 + 2 + 2 + 3;
  for (let i = 0; i < 8; i++) { while (p < buf.length && buf[p] !== 0) p++; p++; }
  p += Math.ceil(width * height / 8);
  return { eventStart: p, width, height };
}

let secret = "";
try {
  for (const line of readFileSync(join(videoRoot, "../.env"), "utf8").split("\n")) {
    const m = /^AUTH_SECRET=(.+)\s*$/.exec(line);
    if (m) secret = m[1].replace(/^["']|["']$/g, "");
  }
} catch {}
const sigOf = (buf) => createHmac("sha256", createHmac("sha256", secret).update("evf-sig-v1").digest()).update(buf).digest("hex");
const md5 = (buf) => createHash("md5").update(buf).digest("hex");

mkdirSync("/tmp/oob-fix-backup", { recursive: true });
const sqls = [];
let fixed = 0;
for (const [id, fp] of TARGETS) {
  const path = videoRoot + fp;
  const buf = readFileSync(path);
  const { eventStart, width, height } = parseV3Head(buf);
  const maxX = width * 16, maxY = height * 16;
  // 扫事件流：8B/事件，code(0) time(1-3) x(4-5) y(6-7)
  let p = eventStart, patched = 0;
  const out = Buffer.from(buf);
  while (p + 8 <= out.length) {
    const code = out[p];
    if (code === 0) break;
    if (CLICK_CODES.has(code)) {
      const x = rd(out, p + 4, 2), y = rd(out, p + 6, 2);
      const inBoard = x < maxX && y < maxY;
      const sentinel = x === maxX && y === maxY;
      if (!inBoard && !sentinel) {
        wr(out, p + 4, 2, maxX);
        wr(out, p + 6, 2, maxY);
        patched++;
      }
    }
    p += 8;
  }
  if (!patched) { console.log(`[skip] ${id} 无非法点击坐标`); continue; }
  const newMd5 = md5(out);
  const newFile = fp.replace(/\/[^/]+$/, `/${newMd5}.evf`);
  const newPath = videoRoot + newFile;
  console.log(`[fix] ${id}: patched=${patched} → ${newFile}`);
  sqls.push(`UPDATE video_info SET filepath='${newFile}', evf_sig='${sigOf(out)}' WHERE id=${id};`);
  sqls.push(`UPDATE video SET hash='${newMd5}' WHERE id=${id};`);
  if (apply) {
    copyFileSync(path, `/tmp/oob-fix-backup/${id}.evf`);
    writeFileSync(newPath, out);
    if (newPath !== path) { try { unlinkSync(path); } catch { console.log(`  [warn] 旧文件删除失败 ${path}`); } }
    fixed++;
  }
}
console.log(`apply=${apply} fixed=${fixed}/${TARGETS.length}`);
if (sqls.length) writeFileSync("/tmp/oob-fix.sql", sqls.join("\n") + "\n");
if (sqls.length && !apply) console.log("dry-run 产出 SQL（未执行）: /tmp/oob-fix.sql");
