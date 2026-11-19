// 评论加载更多（移植 CommentController::actionMore 的 JSON 协议：items/cursor/count）
// 2026-10-22：带登录态 viewerUid——本人可加载到自己的待审行（与列表首屏同口径）

import { NextResponse } from "next/server";
import { getComments, getCommentsCount } from "@/lib/queries";
import { COMMENT_PAGESIZE } from "@/lib/config";
import { getSession } from "@/lib/auth";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const videoId = parseInt(p.get("video") ?? "", 10);
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || COMMENT_PAGESIZE, 100); // 2026-10-14 递增批量上限放宽（原 50）
  if (!videoId) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const session = await getSession();
  const [items, total] = await Promise.all([
    getComments(videoId, cursor, size, session?.uid ?? null),
    // 本录像评论总数：「加载更多」括号内显示剩余条数用
    getCommentsCount(videoId, session?.uid ?? null),
  ]);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
