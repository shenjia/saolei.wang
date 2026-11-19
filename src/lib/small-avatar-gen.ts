// 头像多档尺寸生成（服务端专用，2026-11-10）
//
// ⚠️ 本文件 import sharp，只允许服务端代码（route handler / RSC 数据层 / 后台 ops）
// 引用——绝不能被任何客户端组件直接或间接 import（会打坏浏览器 bundle）。
// URL 解析的客户端安全版在 small-avatar.ts。
//
// 三档一次生成：small 20 / mid 160 / big 360（cover 方形、q80 WebP）。
// cover 裁切口径与展示位 object-fit: cover 一致——居中方形裁切。
// 生成失败抛错由调用方处置（业务入口均 catch 不阻塞主流程）。

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { AVATAR_SIZE_PX, type AvatarSize } from "./small-avatar";

/** 生成一档头像到指定绝对路径。失败抛错由调用方处置。 */
async function genSize(srcAbs: string, dstAbs: string, px: number): Promise<number> {
  const sharp = (await import("sharp")).default;
  const info = await sharp(srcAbs)
    .resize(px, px, { fit: "cover" })
    .webp({ quality: 80 })
    .toFile(dstAbs);
  return info.size;
}

/** 生成全部三档（small/mid/big）到 {dirOf(srcAbs)}/{size}/{name}.webp。
 *  目录自动创建；任一档失败抛错，已生成的档保留（重跑幂等覆盖）。 */
export async function generateAvatarSizes(srcAbs: string): Promise<void> {
  if (!existsSync(srcAbs)) throw new Error(`源文件不存在: ${srcAbs}`);
  const parsed = path.parse(srcAbs);
  for (const [size, px] of Object.entries(AVATAR_SIZE_PX) as [AvatarSize, number][]) {
    const sub = path.join(parsed.dir, size);
    if (!existsSync(sub)) mkdirSync(sub, { recursive: true });
    await genSize(srcAbs, path.join(sub, `${parsed.name}.webp`), px);
  }
}
