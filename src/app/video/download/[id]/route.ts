// 录像下载（移植 VideoController::actionDownload：先 uniqueAction('download') 再发文件）
// 文件名规则移植 VideoModel::getFilename：
//   Exp 12.34s NF - 3BV 123 - # 456 EnglishName (2013-01-01).mvf
// 本地文件缺失时按 VIDEO_FALLBACK_ORIGIN 反代主站同名文件（见 lib/videofile.ts）
// 2026-10-22 张老师指令：屏蔽录像不进前台——下载口对非管理员一律 404（管理员放行：
// 后台审核防盲审依赖下载，AdminReviewList 兜底下载按钮直接链到这里）

import path from "path";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { scoreTime } from "@/lib/format";
import { clientIp, uniqueVideoAction } from "@/lib/stat";
import { openVideoStream } from "@/lib/videofile";
import { isManager, VIDEO_STATUS } from "@/lib/config";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const videoId = parseInt(id, 10);
  if (!videoId) return new Response("Not Found", { status: 404 });

  const video = await prisma.video.findUnique({ where: { id: BigInt(videoId) } });
  if (!video) return new Response("Not Found", { status: 404 });
  if (video.status === VIDEO_STATUS.BANNED) {
    // 管理员（后台审核防盲审依赖下载）+ 录像主人（本人查看/删除屏蔽盘，2026-10-23）
    const session = await getSession();
    if (!session || (!isManager(session.role) && session.uid !== Number(video.user))) {
      return new Response("Not Found", { status: 404 });
    }
  }
  const [info, author] = await Promise.all([
    prisma.videoInfo.findUnique({ where: { id: video.id } }),
    prisma.user.findUnique({ where: { id: video.user } }),
  ]);
  if (!info) return new Response("Not Found", { status: 404 });

  const file = await openVideoStream(info.filepath);
  if (!file) {
    return new Response("Not Found", { status: 404 });
  }

  await uniqueVideoAction(videoId, "download", clientIp(await headers()));

  const ext = path.extname(info.filepath).slice(1) || "mvf";
  const date = new Date(Number(video.createTime) * 1000).toISOString().slice(0, 10);
  const filename =
    `${video.level[0].toUpperCase()}${video.level.slice(1)} ${scoreTime(info.realTime)}s` +
    `${info.noflag ? " NF" : ""} - 3BV ${info.board3bv}` +
    ` - # ${Number(video.user)} ${author?.englishName ?? ""} (${date}).${ext}`;

  const resHeaders: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
  };
  if (file.size !== null) resHeaders["Content-Length"] = String(file.size);
  return new Response(file.stream, { headers: resHeaders });
}
