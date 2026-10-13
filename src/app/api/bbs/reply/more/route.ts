// BBS 主题楼层「加载更多」（cursor 语义，与 /api/comment/more 同协议：items/cursor/count/total）
// 2026-10-13 张老师要求：主题详情底部由「翻页」改「加载更多」
//   —— cursor 取「已加载的最后一个楼层 id」，返回 id 更大的下一批（id 升序即楼层顺序）

import { NextResponse } from "next/server";
import { BBS_REPLY_PAGESIZE, getReplyFeed } from "@/lib/bbs";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const postId = parseInt(p.get("post") ?? "", 10);
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || BBS_REPLY_PAGESIZE, 50);
  if (!postId) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const { items, total } = await getReplyFeed(postId, cursor, size);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
