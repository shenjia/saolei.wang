#!/usr/bin/env node
// 历史头像小图批处理（2026-11-10 张老师需求：排行页 13px 头像改加载 20px WebP 小图省流量）
//
// 覆盖两类历史头像：
//   1. 新版上传 /uploads/avatar/*.jpg|png|webp → small/*.webp（运行期目录，nginx 直读，需在生产跑一遍）
//   2. 旧站照片墙 /images/player/*.jpg → small/*.webp（入仓随部署走，本地跑完提交）
//
// 口径与 src/lib/small-avatar.ts 一致：20×20 cover、webp q80。
// 幂等：默认跳过已存在且比源新的 small 文件；--force 强制重生成。
// 用法：node scripts/gen-small-avatars.mjs [--force] [--player-only | --uploads-only]

import { readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

// import.meta.url 含中文路径（坚果云），pathname 会 percent-encode，必须 fileURLToPath
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PX = 20;

const args = process.argv.slice(2);
const force = args.includes("--force");
const playerOnly = args.includes("--player-only");
const uploadsOnly = args.includes("--uploads-only");

async function genDir(srcDir, dstDir, filter) {
  if (!existsSync(srcDir)) {
    console.log(`[skip] 源目录不存在: ${srcDir}`);
    return;
  }
  mkdirSync(dstDir, { recursive: true });
  const files = readdirSync(srcDir).filter(filter);
  let done = 0, skip = 0, fail = 0, savedBytes = 0, origBytes = 0;
  for (const f of files) {
    const src = join(srcDir, f);
    const dst = join(dstDir, `${parse(f).name}.webp`);
    try {
      if (!force && existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) {
        skip++;
        continue;
      }
      const before = statSync(src).size;
      await sharp(src).resize(PX, PX, { fit: "cover" }).webp({ quality: 80 }).toFile(dst);
      const after = statSync(dst).size;
      origBytes += before;
      savedBytes += after;
      done++;
    } catch (e) {
      console.warn(`[fail] ${f}: ${e.message}`);
      fail++;
    }
  }
  const label = basename(srcDir);
  console.log(
    `[${label}] 生成 ${done} / 跳过 ${skip} / 失败 ${fail}` +
      (done ? `；原图合计 ${(origBytes / 1024).toFixed(0)}KB → 小图合计 ${(savedBytes / 1024).toFixed(0)}KB` : ""),
  );
}

const jobs = [];
if (!playerOnly) {
  // 新版上传：uploads/avatar 根下的图片文件（small/ 子目录排除）
  jobs.push([
    join(ROOT, "public/uploads/avatar"),
    join(ROOT, "public/uploads/avatar/small"),
    (f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith("."),
  ]);
}
if (!uploadsOnly) {
  // 旧站照片墙
  jobs.push([
    join(ROOT, "public/images/player"),
    join(ROOT, "public/images/player/small"),
    (f) => /\.jpg$/i.test(f) && !f.startsWith("."),
  ]);
}

for (const [s, d, f] of jobs) await genDir(s, d, f);
console.log("批处理完成");
