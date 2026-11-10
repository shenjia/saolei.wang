// 小头像生成（服务端专用，2026-11-10）
//
// ⚠️ 本文件 import sharp，只允许服务端代码（route handler / RSC 数据层 / 后台 ops）
// 引用——绝不能被任何客户端组件直接或间接 import（会打坏浏览器 bundle）。
// URL 解析的客户端安全版在 small-avatar.ts。

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { SMALL_AVATAR_PX } from "./small-avatar";

/** 生成小头像到指定绝对路径（目录自动创建）。返回生成的字节数，失败抛错由调用方处置。 */
export async function generateSmallAvatar(srcAbs: string, dstAbs: string): Promise<number> {
  if (!existsSync(srcAbs)) throw new Error(`源文件不存在: ${srcAbs}`);
  const sharp = (await import("sharp")).default;
  const info = await sharp(srcAbs)
    .resize(SMALL_AVATAR_PX, SMALL_AVATAR_PX, { fit: "cover" })
    .webp({ quality: 80 })
    .toFile(dstAbs);
  return info.size;
}

/** 确保 small 目录存在 */
export function ensureSmallDir(dirAbs: string): void {
  if (!existsSync(dirAbs)) mkdirSync(dirAbs, { recursive: true });
}

/** 便捷封装：由 /uploads/avatar/xxx.jpg 原图绝对路径推 small 目标绝对路径并生成 */
export async function generateSmallForUploadAvatar(uploadDir: string, relPath: string): Promise<number> {
  const name = path.basename(relPath, path.extname(relPath));
  return generateSmallAvatar(
    path.join(uploadDir, path.basename(relPath)),
    path.join(uploadDir, "small", `${name}.webp`),
  );
}
