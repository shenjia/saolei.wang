// 待审/屏蔽录像本人自助删除。
// 权限铁闸（服务端）：①登录 ②是录像主人本人 ③录像待审（10）或已屏蔽（0）。
// 已通过（20）不开放自助删除；非本人请求按 404 处理，不泄露录像存在性。
// 删除实体及关联数据，待审录像同步扣减 user_stat 计数；物理文件保留在磁盘，
// 与管理端 video.delete 同口径，防误删共享文件。

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

  // 铁闸：仅本人 + 待审/屏蔽态（404 语义：不存在/无权，不泄露存在性）
  if (Number(video.user) !== session.uid) {
    return NextResponse.json({ ok: false, error: "录像不存在" }, { status: 404 });
  }
  if (video.status !== VIDEO_STATUS.NORMAL && video.status !== VIDEO_STATUS.BANNED) {
    return NextResponse.json(
      { ok: false, error: "已审核录像不能自助删除；如有疑问请联系管理员" },
      { status: 400 }
    );
  }

  const vid = BigInt(id);
  const deleted = await prisma.$transaction(async (tx) => {
    // 删除时再次带本人+状态条件，避免审核状态在查询后发生变化仍被误删。
    const result = await tx.video.deleteMany({
      where: {
        id: vid,
        user: BigInt(session.uid),
        status: { in: [VIDEO_STATUS.NORMAL, VIDEO_STATUS.BANNED] },
      },
    });
    if (!result.count) return false;

    await tx.videoInfo.deleteMany({ where: { id: vid } });
    await tx.videoStat.deleteMany({ where: { id: vid } });
    await tx.videoMetrics.deleteMany({ where: { id: vid } });
    await tx.comment.deleteMany({ where: { video: vid } });
    // 引用该录像的动态一并删除（与管理端 video.delete 同口径，避免悬空链接）。
    await tx.news.deleteMany({ where: { reference: vid } });
    // 防御性清理六张成绩表：正常待审盘无成绩行，但历史同步管线可能越状态写入。
    await tx.videoScoresBeg.deleteMany({ where: { id: vid } });
    await tx.videoScoresBegNf.deleteMany({ where: { id: vid } });
    await tx.videoScoresInt.deleteMany({ where: { id: vid } });
    await tx.videoScoresIntNf.deleteMany({ where: { id: vid } });
    await tx.videoScoresExp.deleteMany({ where: { id: vid } });
    await tx.videoScoresExpNf.deleteMany({ where: { id: vid } });

    // 待审计入个人录像数，删除时扣减；屏蔽盘本就不计数，不能重复扣。
    if (video.status === VIDEO_STATUS.NORMAL) {
      const field = video.level === "beg" ? "begVideos" : video.level === "int" ? "intVideos" : "expVideos";
      await tx.userStat.updateMany({
        where: { id: video.user, [field]: { gt: 0 } },
        data: { [field]: { decrement: 1 }, updateTime: BigInt(Math.floor(Date.now() / 1000)) },
      });
    }
    return true;
  });
  if (!deleted) {
    return NextResponse.json({ ok: false, error: "录像状态已变化，请刷新后重试" }, { status: 409 });
  }

  console.log(`[self-delete] 玩家 #${session.uid} 自助删除${video.status === VIDEO_STATUS.NORMAL ? "待审" : "屏蔽"}录像 #${id}`);
  return NextResponse.json({ ok: true });
}
