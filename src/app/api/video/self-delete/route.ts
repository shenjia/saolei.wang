// 屏蔽录像本人自助删除（2026-10-23 张老师需求）
// 权限铁闸（服务端）：①登录 ②是录像主人本人 ③录像处于屏蔽态（status=0）——
// 三条全过才执行，其余一律 404（不泄露屏蔽盘存在性）。
// 删除口径复用管理端 video.delete：屏蔽态成绩已回退过（屏蔽时已做），直接清理
// 实体（video/video_info/video_stat/video_metrics/comment/引用动态）。
// 与管理端唯一的差异：物理文件不删（保留在磁盘，与其他删除路径口径一致——
// video.delete 也不删文件，防误删共享文件）。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { VIDEO_STATUS } from "@/lib/config";

export async function POST(req: Request) {
  let body: { id?: number };
  try {
    body = (await req.json()) as { id?: number };
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }

  const id = parseInt(String(body.id ?? ""), 10);
  if (!id) return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 });

  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });

  const video = await prisma.video.findUnique({ where: { id: BigInt(id) } });
  if (!video) return NextResponse.json({ ok: false, error: "录像不存在" }, { status: 404 });

  // 铁闸：仅本人 + 屏蔽态（404 语义：不存在/无权，不泄露存在性）
  if (Number(video.user) !== session.uid) {
    return NextResponse.json({ ok: false, error: "录像不存在" }, { status: 404 });
  }
  if (video.status !== VIDEO_STATUS.BANNED) {
    return NextResponse.json(
      { ok: false, error: "该录像未处于屏蔽状态，不能自助删除；如有疑问请联系管理员" },
      { status: 400 }
    );
  }

  const vid = BigInt(id);
  await prisma.$transaction([
    prisma.video.delete({ where: { id: vid } }),
    prisma.videoInfo.deleteMany({ where: { id: vid } }),
    prisma.videoStat.deleteMany({ where: { id: vid } }),
    prisma.videoMetrics.deleteMany({ where: { id: vid } }),
    prisma.comment.deleteMany({ where: { video: vid } }),
    // 引用该录像的动态一并删除（与管理端 video.delete 同口径，避免悬空链接）
    prisma.news.deleteMany({ where: { reference: vid } }),
  ]);

  console.log(`[self-delete] 玩家 #${session.uid} 自助删除屏蔽录像 #${id}`);
  return NextResponse.json({ ok: true });
}
