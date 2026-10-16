// 录像文件统一读取（本地 videos/ 命中直接回流；未命中时按 VIDEO_FALLBACK_ORIGIN
// 反代主站同名文件兜底——开发环境不带 55 万录像文件，靠主站播放/下载）。
// 主站域名写在 .env 的 VIDEO_FALLBACK_ORIGIN（现为 https://new.saolei.wang，
// 正式切换主域后改成 https://saolei.wang 即可）。
// 用服务端反代而非 302：客户端 fetch 跨域重定向会被 CORS 拦截，反代对
// fetch / flop iframe / 下载三种消费方都透明。

import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { Readable } from "stream";

export const VIDEOS_ROOT = path.join(process.cwd(), "videos");

/** 主站兜底源（如 https://new.saolei.wang），未配置则本地缺失时直接 404 */
export const VIDEO_FALLBACK_ORIGIN = (process.env.VIDEO_FALLBACK_ORIGIN || "").replace(/\/+$/, "");

/** 解析本地文件路径（带目录穿越防护）；不存在返回 null */
export function localVideoPath(relPath: string): string | null {
  const full = path.resolve(VIDEOS_ROOT, "." + relPath);
  if (!full.startsWith(VIDEOS_ROOT + path.sep) || !existsSync(full) || !statSync(full).isFile()) {
    return null;
  }
  return full;
}

/**
 * 打开录像文件流：本地命中 → 磁盘流；未命中且配置了兜底源 → 反代主站。
 * 返回 null 表示本地没有且无兜底（或兜底拉取失败），调用方回 404。
 */
export async function openVideoStream(
  relPath: string
): Promise<{ stream: ReadableStream; size: number | null } | null> {
  const local = localVideoPath(relPath);
  if (local) {
    return {
      stream: Readable.toWeb(createReadStream(local)) as ReadableStream,
      size: statSync(local).size,
    };
  }
  if (!VIDEO_FALLBACK_ORIGIN) return null;
  try {
    const res = await fetch(`${VIDEO_FALLBACK_ORIGIN}/videos${relPath}`, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok || !res.body) return null;
    return { stream: res.body, size: Number(res.headers.get("content-length")) || null };
  } catch {
    return null; // 主站超时/网络故障 → 按 404 处理，前端已有失败气泡提示
  }
}
