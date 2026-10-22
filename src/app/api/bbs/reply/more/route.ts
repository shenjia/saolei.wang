// BBS 主题楼层「加载更多」（cursor 语义，与 /api/comment/more 同协议：items/cursor/count/total）
// 2026-10-13 张老师要求：主题详情底部由「翻页」改「加载更多」
//   —— cursor 取「已加载的最后一个楼层 id」，返回 id 更大的下一批（id 升序即楼层顺序）
// 2026-10-22：带登录态 viewerUid——本人可加载到自己的待审楼层（与列表首屏同口径）

import { NextResponse } from "next/server";
import { BBS_REPLY_PAGESIZE, getReplyFeed } from "@/lib/bbs";
import { getSession } from "@/lib/auth";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const postId = parseInt(p.get("post") ?? "", 10);
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || BBS_REPLY_PAGESIZE, 50);
  if (!postId) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }

  const session = await getSession();
  const { items, total } = await getReplyFeed(postId, cursor, size, session?.uid ?? null);
  return NextResponse.json({
    items,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
    total,
  });
}
