// 动态加载更多（移植 NewsController::actionMore / UserController::actionMoreNews）
// 军衔称号在服务端预算好随 JSON 返回，客户端直接渲染

import { NextResponse } from "next/server";
import { getNews } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { NEWS_PAGESIZE } from "@/lib/config";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const userId = parseInt(p.get("user") ?? "", 10) || undefined;
  const size = Math.min(parseInt(p.get("size") ?? "", 10) || NEWS_PAGESIZE, 50);

  const items = await getNews({ userId, cursor: cursor || undefined, limit: size });
  const withTitles = await Promise.all(
    items.map(async (news) => ({ news, title: await assessTitle(news.userScore) }))
  );
  return NextResponse.json({
    items: withTitles,
    cursor: items.length ? items[items.length - 1].id : cursor,
    count: items.length,
  });
}
