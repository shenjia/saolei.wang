// 删除评论（2026-10-26 张老师需求）
// 权限（服务端铁闸）：登录 且（评论发布者本人 或 该录像的上传者）——
// 录像作者可以删别人写在自己录像下的评论，发布者可以删自己发的评论；
// 两者之外（含未登录）一律 404 口径拒绝，不泄露评论存在性。
// 删除口径与管理端 comment.setStatus(-1) 完全一致：软删除（status=-1）+
// 按 countsInTotal 回退录像评论计数 + 按 cid 精确撤下该条评论的动态；
// 区别仅在不写管理日志（非管理操作）、不提供恢复入口（后台仍可恢复）。

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { countsInTotal, COMMENT_STATUS, NEWS_TYPE } from "@/lib/config";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";

export async function POST(req: Request) {
  if (await isMaintenanceOn()) return maintenanceReject() as unknown as NextResponse;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  }

  let body: { id?: number };
  try {
    body = (await req.json()) as { id?: number };
  } catch {
    return NextResponse.json({ ok: false, error: "请求格式错误" }, { status: 400 });
  }

  const id = parseInt(String(body.id ?? ""), 10);
  if (!id) return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 });

  const row = await prisma.comment.findUnique({ where: { id: BigInt(id) } });
  if (!row || row.status === COMMENT_STATUS.DELETED) {
    return NextResponse.json({ ok: false, error: "评论不存在" }, { status: 404 });
  }

  // 铁闸：发布者本人 或 录像上传者（404 语义：不存在/无权，不泄露存在性）
  const video = await prisma.video.findUnique({
    where: { id: row.video },
    select: { user: true },
  });
  const isCommenter = Number(row.user) === session.uid;
  const isVideoOwner = video && Number(video.user) === session.uid;
  if (!isCommenter && !isVideoOwner) {
    return NextResponse.json({ ok: false, error: "评论不存在" }, { status: 404 });
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  await prisma.$transaction(async (tx) => {
    await tx.comment.update({
      where: { id: BigInt(id) },
      data: { status: COMMENT_STATUS.DELETED, updateTime: now },
    });
    // 冗余计数回退：只有「正常」计入 video_stat.comments（口径同 admin ops / AI 转待审）
    if (countsInTotal(row.status)) {
      await tx.videoStat.updateMany({
        where: { id: row.video },
        data: { comments: { decrement: 1 }, updateTime: now },
      });
    }
    // 撤下该条评论的动态：按 details_data 里的 cid 精确定位（同 admin ops / content-review 口径；
    // 自评录像本就不发动态，deleteMany 0 行也安全）
    await tx.news.deleteMany({
      where: {
        type: NEWS_TYPE.COMMENT,
        user: row.user,
        reference: row.video,
        detailsData: { contains: `"cid":${id}}` },
      },
    });
  });

  console.log(
    `[comment-delete] 玩家 #${session.uid} 删除评论 #${id}（${isVideoOwner && !isCommenter ? "录像作者" : "发布者本人"}）`
  );
  // 动态流本体不挂缓存（仅新闻计数 60s unstable_cache，与管理端删除路径同口径，最多 1 分钟内自愈）
  return NextResponse.json({ ok: true });
}
