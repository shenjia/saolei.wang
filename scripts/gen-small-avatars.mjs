#!/usr/bin/env node
// 历史头像多档小图批处理（2026-11-10 张老师需求：全站头像 WebP 化省流量）
//
// 覆盖两类历史头像，各生成三档（口径与 src/lib/small-avatar.ts 一致：方形 cover、webp q80）：
//   small 20px → 排行页 13px、论坛列表 16px
//   mid  160px → 顶栏 28/30px、用户卡片/VS 页 72px
//   big  360px → 每日之星 144px、个人主页 162px
//
//   1. 新版上传 /uploads/avatar/*.{jpg,png,webp} → {small,mid,big}/*.webp（运行期目录，nginx 直读，需在生产跑一遍）
//   2. 旧站照片墙 /images/player/*.jpg → {small,mid,big}/*.webp（small 入仓随部署走，本地跑完提交）
//
// 幂等：默认跳过已存在且比源新的产物；--force 强制重生成。
// 用法：node scripts/gen-small-avatars.mjs [--force] [--player-only | --uploads-only]
//      （--force 时旧版 small 单档也会被三档口径覆盖重生成）

import { readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

// import.meta.url 含中文路径（坚果云），pathname 会 percent-encode，必须 fileURLToPath
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIZES = { small: 20, mid: 160, big: 360 };

const args = process.argv.slice(2);
const force = args.includes("--force");
const playerOnly = args.includes("--player-only");
const uploadsOnly = args.includes("--uploads-only");

async function genDir(srcDir, sizeDirs, filter) {
  if (!existsSync(srcDir)) {
    console.log(`[skip] 源目录不存在: ${srcDir}`);
    return;
  }
  for (const d of Object.values(sizeDirs)) mkdirSync(d, { recursive: true });
  const files = readdirSync(srcDir).filter(filter);
  let done = 0, skip = 0, fail = 0, savedBytes = 0, origBytes = 0;
  for (const f of files) {
    const src = join(srcDir, f);
    const name = `${parse(f).name}.webp`;
    // 全三档都已新于源才算跳过（补齐缺档场景）
    const allFresh = Object.values(sizeDirs).every(
      (d) => existsSync(join(d, name)) && statSync(join(d, name)).mtimeMs >= statSync(src).mtimeMs,
    );
    if (!force && allFresh) {
      skip++;
      continue;
    }
    try {
      const before = statSync(src).size;
      let after = 0;
      for (const [size, px] of Object.entries(SIZES)) {
        const info = await sharp(src)
          .resize(px, px, { fit: "cover" })
          .webp({ quality: 80 })
          .toFile(join(sizeDirs[size], name));
        after += info.size;
      }
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
      (done ? `；原图合计 ${(origBytes / 1024).toFixed(0)}KB → 三档合计 ${(savedBytes / 1024).toFixed(0)}KB` : ""),
  );
}

const jobs = [];
if (!playerOnly) {
  // 新版上传：uploads/avatar 根下的图片文件（尺寸子目录排除）
  jobs.push([
    join(ROOT, "public/uploads/avatar"),
    Object.fromEntries(Object.keys(SIZES).map((s) => [s, join(ROOT, "public/uploads/avatar", s)])),
    (f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith("."),
  ]);
}
if (!uploadsOnly) {
  // 旧站照片墙（构建期静态树，small 档入仓；mid/big 仅本地生成不入仓——
  // mid/big 的展示位是登录后页面，流量省在运行期，生产跑一遍即可）
  jobs.push([
    join(ROOT, "public/images/player"),
    Object.fromEntries(Object.keys(SIZES).map((s) => [s, join(ROOT, "public/images/player", s)])),
    (f) => /\.jpg$/i.test(f) && !f.startsWith("."),
  ]);
}

for (const [s, d, f] of jobs) await genDir(s, d, f);
console.log("批处理完成");
