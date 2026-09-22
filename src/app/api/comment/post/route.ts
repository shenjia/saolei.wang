// 发表评论（移植 CommentController::actionPost，需登录）

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { addComment } from "@/lib/queries";
import { COMMENT_CONTENT_LIMIT } from "@/lib/config";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  let body: { video?: number | string; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  const videoId = parseInt(String(body.video ?? ""), 10);
  const content = (body.content ?? "").trim();
  if (!videoId) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ error: "评论内容不能为空" }, { status: 400 });
  }
  if ([...content].length > COMMENT_CONTENT_LIMIT) {
    return NextResponse.json({ error: `评论不能超过${COMMENT_CONTENT_LIMIT}个字` }, { status: 400 });
  }

  const video = await prisma.video.findUnique({ where: { id: BigInt(videoId) }, select: { id: true } });
  if (!video) {
    return NextResponse.json({ error: "录像不存在" }, { status: 404 });
  }

  await addComment(videoId, session.uid, content);
  return NextResponse.json({ ok: true });
}
