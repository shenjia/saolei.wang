// 军衔玩家列表「加载更多」（仿 /api/news/more 的 cursor 增量模式，2026-09-24 张老师要求）
// 军衔名经 URL 编码传递（中文），服务端按已加载条数偏移取下一页

import { NextResponse } from "next/server";
import { getTitleMemberCount, getTitleMembers } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const title = p.get("title") ?? "";
  const cursor = parseInt(p.get("cursor") ?? "0", 10) || 0;
  const size = Math.min(parseInt(p.get("size") ?? "20", 10) || 20, 100);

  const [data, total] = await Promise.all([getTitleMembers(title, cursor, size), getTitleMemberCount(title)]);
  if (!data) return NextResponse.json({ error: "bad title" }, { status: 400 });
  return NextResponse.json({
    rows: data.rows,
    cursor: cursor + data.rows.length,
    hasMore: data.hasMore,
    total: total < 0 ? data.rows.length : total,
  });
}
