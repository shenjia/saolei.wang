// 计数器（移植 VideoStatModel::uniqueAction：相邻同 IP 的重复操作只计一次）

import { prisma } from "./db";

export async function uniqueVideoAction(videoId: number, action: "click" | "download", ip: string) {
  const stat = await prisma.videoStat.findUnique({ where: { id: BigInt(videoId) } });
  if (!stat) return;
  const ipField = action === "click" ? "clicker" : "downloader";
  const numField = action === "click" ? "clicks" : "downloads";
  if ((stat[ipField] ?? "") === ip) return;
  await prisma.videoStat.update({
    where: { id: stat.id },
    data: {
      [ipField]: ip,
      [numField]: { increment: 1 },
      updateTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
}

/** 从请求头取客户端 IP（移植 Request::getIP） */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    ""
  );
}
