// 后台审核专用录像文件下发（2026-10-28，347943 案续）
//
// 背景：nginx 对 ^~ /videos/ 直接 alias 磁盘并下发 30d 缓存——录像文件被服务端
// 原地修补（如 evf 时间倒流钳制）后，后台审核播放会命中浏览器里的陈旧副本。
// 不能用 `?t=时间戳` 穿透：flop 取扩展名是 uri.substring(uri.lastIndexOf(".")+1)，
// 查询串会拼进扩展名（"evf?t=123" ≠ "evf"），直接报「请选择一个 evf/avf/mvf/rmv/rawvf 文件」。
//
// 因此走本路由：URL 以真实扩展名结尾（/api/admin/video-file/347943.evf），
// 服务端按 DB 里 video_info.filepath 读磁盘（videofile.ts 统一通道，本地缺失
// 自动反代兜底源），Cache-Control: no-store 保证永远拿到磁盘当前版。
// 用户只给 id，路径完全取库内值，无目录穿越面。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdminApi } from "@/lib/admin/guard";
import { openVideoStream } from "@/lib/videofile";

export const dynamic = "force-dynamic";

/** flop 认的录像扩展名白名单（与播放器校验一致） */
const EXT_WHITELIST = new Set(["evf", "avf", "mvf", "rmv", "rawvf"]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ file: string }> }
) {
  const guard = await requireAdminApi();
  if ("error" in guard) return guard.error;

  const { file } = await params;
  const dot = file.lastIndexOf(".");
  const id = dot > 0 ? Number(file.slice(0, dot)) : NaN;
  const ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
  if (!Number.isInteger(id) || id <= 0 || !EXT_WHITELIST.has(ext)) {
    return NextResponse.json({ error: "无效的录像标识" }, { status: 400 });
  }

  const info = await prisma.videoInfo.findUnique({
    where: { id: BigInt(id) },
    select: { filepath: true },
  });
  if (!info || !info.filepath.toLowerCase().endsWith("." + ext)) {
    return NextResponse.json({ error: "录像不存在" }, { status: 404 });
  }

  const stream = await openVideoStream(info.filepath);
  if (!stream) {
    return NextResponse.json({ error: "录像文件缺失" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    // 审核播放必须取磁盘当前版（文件可能被原地修补），任何缓存层都不许拦
    "Cache-Control": "no-store, max-age=0",
  };
  if (stream.size !== null) headers["Content-Length"] = String(stream.size);
  return new Response(stream.stream, { headers });
}
