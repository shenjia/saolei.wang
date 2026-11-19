// 计数器（移植 VideoStatModel::uniqueAction：相邻同 IP 的重复操作只计一次）

import { prisma } from "./db";

/** 计数器（移植 VideoStatModel::uniqueAction：相邻同 IP 的重复操作只计一次）
 *  返回操作后的最新计数值（2026-11-05 张老师：浏览永远不应为 0——详情页此前先读
 *  后加，首次浏览必然显示 0；现由调用方用返回值兜底显示。stat 行缺失返回 null） */
export async function uniqueVideoAction(videoId: number, action: "click" | "download", ip: string): Promise<number | null> {
  const stat = await prisma.videoStat.findUnique({ where: { id: BigInt(videoId) } });
  if (!stat) return null;
  const ipField = action === "click" ? "clicker" : "downloader";
  const numField = action === "click" ? "clicks" : "downloads";
  if ((stat[ipField] ?? "") === ip) return Number(stat[numField] ?? 0);
  const updated = await prisma.videoStat.update({
    where: { id: stat.id },
    data: {
      [ipField]: ip,
      [numField]: { increment: 1 },
      updateTime: BigInt(Math.floor(Date.now() / 1000)),
    },
  });
  return Number(updated[numField] ?? 0);
}

/** 从请求头取客户端 IP（移植 Request::getIP） */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    ""
  );
}
