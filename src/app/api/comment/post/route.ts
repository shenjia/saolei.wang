// 发表评论（移植 CommentController::actionPost，需登录）

import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { addComment } from "@/lib/queries";
import { COMMENT_CONTENT_LIMIT } from "@/lib/config";
import { checkSensitive, logSensitiveHit, sensitiveRejectMessage } from "@/lib/sensitive";
import { runContentReview } from "@/lib/content-review";
import { isMaintenanceOn, maintenanceReject } from "@/lib/maintenance";

export async function POST(req: Request) {
  if (await isMaintenanceOn()) return maintenanceReject() as unknown as NextResponse;
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
  // 敏感词过滤（2026-10-13 张老师需求）：命中直接拒绝，不落库、不发动态
  const hit = checkSensitive(content);
  if (!hit.ok) {
    logSensitiveHit("comment.post", session.uid, hit);
    return NextResponse.json({ error: sensitiveRejectMessage(hit) }, { status: 400 });
  }

  const video = await prisma.video.findUnique({ where: { id: BigInt(videoId) }, select: { id: true } });
  if (!video) {
    return NextResponse.json({ error: "录像不存在" }, { status: 404 });
  }

  const commentId = await addComment(videoId, session.uid, content);
  // AI 后置复审（2026-10-13）：词库已放行则正常展示，响应返回后异步送 AI 复核；
  // 判可疑会把这条评论转为「待审」并撤下动态（见 content-review.ts），用户无感知延迟
  after(() => runContentReview("comment", commentId, content));
  return NextResponse.json({ ok: true });
}
