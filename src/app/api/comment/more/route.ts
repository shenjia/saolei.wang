// 评论加载更多（移植 CommentController::actionMore 的 JSON 协议：items/cursor/count）

import { NextResponse } from "next/server";
import { getComments, getCommentsCount } from "@/lib/queries";
import { COMMENT_PAGESIZE } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const videoId = parseInt(p.get("video") ?? "", 10);
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || COMMENT_PAGESIZE, 50);
  if (!videoId) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const [items, total] = await Promise.all([
    getComments(videoId, cursor, size),
    // 本录像评论总数：「加载更多」括号内显示剩余条数用
    getCommentsCount(videoId),
  ]);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
